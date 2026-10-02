import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { SDK, CustomLogAdapter, getPublicKeyFromPrivate } from '@canton-network/wallet-sdk';
import { configSchema, loadConfig, type Config } from './model.js';
import { Journal } from './journal.js';
import { freshRunDirectory } from './experience.js';
import { bundledPackageId } from './assets.js';

const credentialsSchema = z.object({ signingKey: z.string().max(4096).default(''), A: z.string().max(16384).default(''), B: z.string().max(16384).default('') }).strict();
export const doctorOutputSchema = z.object({ ready: z.boolean(), checks: z.array(z.object({ label: z.string().max(1024), status: z.enum(['pass', 'warn', 'fail']), message: z.string().max(4096), action: z.string().max(4096).optional() })).max(100) });
export const liveSetupSchema = z.object({ config: z.unknown().optional(), credentials: credentialsSchema.default({ signingKey: '', A: '', B: '' }), savedRun: z.string().max(128).optional() }).strict();

export const liveDefaults = {
  mode: 'testnet', packageId: bundledPackageId, party: '', synchronizerId: '',
  signingKeyEnv: 'CANTON_TEST_SIGNING_KEY', signingFingerprint: '', topologyConfirmed: false,
  primary: 'A', count: 60, intervalMs: 1000,
  scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 60000 },
  endpoints: Object.fromEntries(['A', 'B'].map(id => [id, { url: '', participantId: '', auth: { type: 'static', tokenEnv: `CANTON_${id}_TOKEN` } }])),
};

/** Only directories created by browser setup are selectable, never arbitrary browser-supplied paths. */
export function browserRuns(parent = resolve('runs')) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).flatMap(entry => {
    const configPath = join(parent, entry.name, 'ui-config.json');
    const journalPath = join(parent, entry.name, 'journal.sqlite');
    if (!existsSync(configPath) || !existsSync(journalPath)) return [];
    let journal: Journal | undefined;
    try {
      const config = loadConfig(configPath);
      if (config.mode !== 'testnet') return [];
      journal = new Journal(journalPath, false);
      if (journal.get('runId')) journal.assertConfig(config);
      return [{ id: entry.name, config, configPath, journalPath, runId: journal.get<string>('runId'), completed: Boolean(journal.get('completedAt')) }];
    } catch { return []; }
    finally { journal?.close(); }
  });
}

export async function prepareBrowserRun(input: unknown, parent?: string) {
  const request = liveSetupSchema.safeParse(input);
  if (!request.success) throw new Error('Invalid setup request');
  const saved = request.data.savedRun ? browserRuns(parent).find(r => r.id === request.data.savedRun) : undefined;
  if (request.data.savedRun && !saved) throw new Error('Saved run not found');
  let raw: unknown = saved?.config ?? request.data.config;
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
  for (const id of ['A', 'B'] as const) {
    const auth = config.endpoints[id].auth;
    if (credentials[id]) env[auth.type === 'static' ? auth.tokenEnv : auth.clientSecretEnv] = credentials[id];
  }
  if (saved) return { ...saved, env };
  const dir = freshRunDirectory('run', parent);
  const configPath = join(dir, 'ui-config.json');
  const journalPath = join(dir, 'journal.sqlite');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const journal = new Journal(journalPath); journal.close();
  return { id: dir.split('/').at(-1)!, config, configPath, journalPath, env };
}
