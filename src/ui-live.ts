import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SDK, CustomLogAdapter, getPublicKeyFromPrivate } from '@canton-network/wallet-sdk';
import { configSchema, loadConfig, type Config } from './model.js';
import { Journal } from './journal.js';
import { freshRunDirectory } from './experience.js';
import { listProfiles } from './profiles.js';
import { bundledPackageId } from './assets.js';

const credentialsSchema = z.object({ signingKey: z.string().max(4096).default(''), A: z.string().max(16384).default(''), B: z.string().max(16384).default('') }).strict();
export const doctorOutputSchema = z.object({ ready: z.boolean(), checks: z.array(z.object({ label: z.string().max(1024), status: z.enum(['pass', 'warn', 'fail']), message: z.string().max(4096), action: z.string().max(4096).optional() })).max(100) });
export const liveSetupSchema = z.object({ config: z.unknown().optional(), credentials: credentialsSchema.default({ signingKey: '', A: '', B: '' }), savedRun: z.string().max(128).optional(), reuseSource: z.string().max(128).optional() }).strict().refine(v => !(v.savedRun && v.reuseSource));

export const liveDefaults = {
  mode: 'testnet', packageId: bundledPackageId, party: '', synchronizerId: '',
  signingKeyEnv: 'CANTON_TEST_SIGNING_KEY', signingFingerprint: '', topologyConfirmed: false,
  primary: 'A', count: 60, intervalMs: 1000,
  scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 60000 },
  endpoints: Object.fromEntries(['A', 'B'].map(id => [id, { url: '', participantId: '', auth: { type: 'static', tokenEnv: `CANTON_${id}_TOKEN` } }])),
};

export function isProxyConfig(config: Config): boolean {
  return Object.values(config.endpoints).some(e => {
    const url = new URL(e.url);
    return ['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/[a-f0-9]{48}\/?$/.test(url.pathname);
  });
}

export function browserProfiles(directory = resolve('profiles')) {
  return listProfiles(directory).flatMap(profile => {
    try {
      const config = loadConfig(profile.path);
      return config.mode === 'testnet' && !isProxyConfig(config) ? [{ id: `profile:${profile.name}`, label: profile.name, source: 'profile' as const, config, configPath: profile.path }] : [];
    } catch { return []; }
  });
}

/** Discover project-local journals and validate saved config against each run before presenting it. */
export function browserRuns(parent = resolve('runs'), profilesDirectory?: string) {
  if (!existsSync(parent)) return [];
  const profiles = browserProfiles(profilesDirectory);
  return readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).flatMap(entry => {
    const journalPath = join(parent, entry.name, 'journal.sqlite');
    if (!existsSync(journalPath)) return [];
    let journal: Journal | undefined;
    try {
      journal = new Journal(journalPath, false);
      if (journal.get('mode') === 'simulation') return [];
      const runId = journal.get<string>('runId');
      const candidates: { config: Config; path?: string }[] = [];
      for (const key of ['connectionConfig', 'runConfig']) {
        const parsed = configSchema.safeParse(journal.get(key));
        if (parsed.success) candidates.push({ config: parsed.data });
      }
      const uiPath = join(parent, entry.name, 'ui-config.json');
      const savedPath = journal.get<string>('configPath');
      for (const path of [uiPath, savedPath && resolve(dirname(journalPath), savedPath)]) {
        if (!path || !existsSync(path)) continue;
        try { candidates.push({ config: loadConfig(path), path }); } catch { /* Try another verified source. */ }
      }
      candidates.push(...profiles.map(p => ({ config: p.config, path: p.configPath })));
      const candidate = candidates.find(c => {
        if (c.config.mode !== 'testnet' || isProxyConfig(c.config)) return false;
        // Uninitialized journals are recognized only when browser setup saved its own config.
        if (!runId) return c.path === uiPath;
        try { journal!.assertConfig(c.config); return true; } catch { return false; }
      });
      if (!candidate) return [];
      const config = candidate.config;
      const completed = Boolean(journal.get('completedAt'));
      const markers = journal.events().filter(e => e.kind === 'fault_start' || e.kind === 'fault_end');
      const canResume = !completed && config.scenario.type === 'failover' && config.primary === config.scenario.faultedEndpoint && markers.every(e => e.data.source === 'client-proxy');
      return [{ id: entry.name, config, configPath: candidate.path, journalPath, runId, completed, canResume, createdAt: journal.get<string>('createdAt') ?? statSync(journalPath).mtime.toISOString(),
        source: existsSync(uiPath) ? 'dashboard' as const : 'CLI' as const }];
    } catch { return []; }
    finally { journal?.close(); }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function prepareBrowserRun(input: unknown, parent?: string, profilesDirectory?: string) {
  const request = liveSetupSchema.safeParse(input);
  if (!request.success) throw new Error('Invalid setup request');
  const saved = request.data.savedRun ? browserRuns(parent, profilesDirectory).find(r => r.id === request.data.savedRun) : undefined;
  if (request.data.savedRun && !saved) throw new Error('Saved run not found');
  if (saved && !saved.canResume && !saved.completed) throw new Error('Saved run cannot resume with proxy controls; reuse its settings for a new test');
  const sources = [...browserRuns(parent, profilesDirectory), ...browserProfiles(profilesDirectory)];
  const reused = request.data.reuseSource ? sources.find(r => r.id === request.data.reuseSource) : undefined;
  if (request.data.reuseSource && !reused) throw new Error('Saved connection settings not found');
  const source = saved ?? reused;
  let raw: unknown = saved?.config ?? request.data.config ?? reused?.config;
  // Config stores environment references only. Browser credentials can never override Node runtime options.
  if (raw && typeof raw === 'object') {
    const c = raw as Config;
    raw = { ...c, signingKeyEnv: 'CANTON_TEST_SIGNING_KEY', endpoints: c.endpoints ? Object.fromEntries(['A', 'B'].map(id => {
      const e = c.endpoints[id as 'A' | 'B'];
      return [id, { ...e, auth: e?.auth?.type === 'static' ? { type: 'static', tokenEnv: `CANTON_${id}_TOKEN` } : { ...e?.auth, clientSecretEnv: `CANTON_${id}_CLIENT_SECRET` } }];
    })) : undefined };
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Check setup fields: ' + parsed.error.issues.map(i => i.path.join('.') || 'configuration').join(', '));
  let config = parsed.data;
  if (config.mode !== 'testnet' || config.scenario.type !== 'failover') throw new Error('Live setup requires a testnet failover scenario');
  if (config.primary !== config.scenario.faultedEndpoint) throw new Error('Primary participant must match the traffic block target');
  if (!config.topologyConfirmed) throw new Error('Confirm shared-party hosting and independent submission before setup');
  const env: NodeJS.ProcessEnv = {};
  const credentials = request.data.credentials;
  if (credentials.signingKey) {
    try {
      const sdk = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) });
      const fingerprint = await sdk.keys.fingerprint(getPublicKeyFromPrivate(credentials.signingKey));
      if (saved && fingerprint !== config.signingFingerprint) throw new Error('mismatch');
      if (!saved) config = { ...config, signingFingerprint: fingerprint };
    } catch { throw new Error('Signing key is invalid or does not match the saved run'); }
    env[config.signingKeyEnv] = credentials.signingKey;
  }
  if (!credentials.signingKey && source) env[config.signingKeyEnv] = process.env[source.config.signingKeyEnv] ?? process.env[config.signingKeyEnv];
  for (const id of ['A', 'B'] as const) {
    const auth = config.endpoints[id].auth;
    const variable = auth.type === 'static' ? auth.tokenEnv : auth.clientSecretEnv;
    const originalAuth = source?.config.endpoints[id].auth;
    const originalVariable = originalAuth?.type === 'static' ? originalAuth.tokenEnv : originalAuth?.clientSecretEnv;
    if (credentials[id]) env[variable] = credentials[id];
    else if (originalAuth?.type === auth.type && originalVariable) env[variable] = process.env[originalVariable] ?? process.env[variable];
  }
  let connectionConfig = config;
  if (source) {
    connectionConfig = { ...config, signingKeyEnv: source.config.signingKeyEnv, endpoints: { ...config.endpoints } };
    for (const id of ['A', 'B'] as const) {
      const auth = config.endpoints[id].auth, original = source.config.endpoints[id].auth;
      if (auth.type === 'static' && original.type === 'static') connectionConfig.endpoints[id] = { ...config.endpoints[id], auth: { ...auth, tokenEnv: original.tokenEnv } };
      else if (auth.type !== 'static' && original.type === auth.type) connectionConfig.endpoints[id] = { ...config.endpoints[id], auth: { ...auth, clientSecretEnv: original.clientSecretEnv } };
    }
  }
  if (saved) {
    const configPath = join(dirname(saved.journalPath), `detected-config-${randomUUID()}.json`);
    writeFileSync(configPath, JSON.stringify(connectionConfig, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { ...saved, configPath, config, connectionConfig, env };
  }
  const dir = freshRunDirectory('run', parent);
  const configPath = join(dir, 'ui-config.json');
  const journalPath = join(dir, 'journal.sqlite');
  writeFileSync(configPath, JSON.stringify(connectionConfig, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const journal = new Journal(journalPath); journal.close();
  return { id: basename(dir), config, connectionConfig, configPath, journalPath, env };
}
