import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SDK, CustomLogAdapter, getPublicKeyFromPrivate } from '@canton-network/wallet-sdk';
import { Config, Fault, configSchema, endpointIds, faultKind } from './model.js';
import { CantonLedger } from './ledger.js';
import { bundledPackageId, bundledDarPath, bundledDarSha256, bundledDarVerified } from './assets.js';

export interface DoctorCheck { id: string; label: string; status: 'pass' | 'fail' | 'warn'; message: string; action?: string }
export interface DoctorReport { ready: boolean; checks: DoctorCheck[] }

function configChecks(path: string): { config?: Config; checks: DoctorCheck[] } {
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { checks: [{ id: 'config', label: 'Configuration', status: 'fail', message: 'Configuration file is unreadable or contains invalid JSON.', action: 'Check the config path and repair its JSON syntax.' }] }; }
  const parsed = configSchema.safeParse(input);
  if (parsed.success) return { config: parsed.data, checks: [{ id: 'config', label: 'Configuration', status: 'pass', message: 'Configuration fields are valid.' }] };
  return { checks: parsed.error.issues.map((issue, index) => {
    const field = issue.path.length ? issue.path.join('.') : 'config';
    let expected = 'use the required field shape';
    if (issue.code === 'invalid_type') expected = `expected ${issue.expected}`;
    else if (issue.code === 'invalid_value') expected = `expected one of ${issue.values.map(String).join(', ')}`;
    else if (issue.code === 'too_small') expected = `${issue.origin} minimum ${issue.minimum}`;
    else if (issue.code === 'too_big') expected = `${issue.origin} maximum ${issue.maximum}`;
    else if (issue.code === 'invalid_format') expected = field === 'packageId' ? 'expected 64 lowercase hexadecimal characters' : field.endsWith('Url') || field.endsWith('.url') ? 'expected a valid HTTPS URL, or loopback HTTP URL' : 'use the required field format';
    else if (issue.code === 'unrecognized_keys') expected = 'remove unsupported fields';
    else if (issue.code === 'custom') expected = issue.message;
    return { id: `config.${index}`, label: `Configuration: ${field}`, status: 'fail' as const, message: `${field}: ${expected}.`, action: `Correct ${field} in the configuration file.` };
  }) };
}

export function loadConfigChecked(path: string): Config {
  const result = configChecks(path);
  if (!result.config) throw new Fault('configuration', result.checks.map(c => c.message).join(' '));
  return result.config;
}

export async function doctor(configPath: string): Promise<DoctorReport> {
  const loaded = configChecks(configPath);
  const checks: DoctorCheck[] = [...loaded.checks];
  const node = process.versions.node.split('.').map(Number);
  const nodeSupported = node[0] > 24 || (node[0] === 24 && node[1] >= 10);
  checks.push({ id: 'node', label: 'Node.js', status: nodeSupported ? 'pass' : 'fail', message: nodeSupported ? 'Node.js meets the 24.10.0 minimum.' : 'Node.js 24.10.0 or newer is required.', ...(!nodeSupported ? { action: 'Install Node.js 24.10.0 or newer and reinstall dependencies.' } : {}) });
  let verified = false;
  try { verified = bundledDarVerified(); } catch { /* Report a safe artifact failure below. */ }
  checks.push({ id: 'dar', label: 'Bundled DAR', status: verified ? 'pass' : 'fail', message: verified ? `Bundled DAR checksum matches ${bundledDarSha256}.` : 'Bundled DAR is missing, unreadable, or its checksum differs.', ...(!verified ? { action: `Restore ${bundledDarPath} from the project distribution; expected SHA-256 ${bundledDarSha256}.` } : {}) });
  checks.push({ id: 'writes', label: 'Independent write capability', status: 'warn', message: 'Untested. Doctor performs reads only; it does not prove either participant can submit independently.', action: 'Verify independent submission capability through the authorized smoke run after prerequisites pass.' });
  const config = loaded.config;
  if (!config) return { ready: false, checks };
  if (config.packageId !== bundledPackageId) checks.push({ id: 'package-source', label: 'Configured package', status: 'warn', message: 'Configured package differs from the bundled test package.', action: `Use bundled package ID ${bundledPackageId}, or confirm that your custom DAR contains the matching Failover templates.` });
  checks.push({ id: 'topology', label: 'Topology attestation', status: config.topologyConfirmed ? 'pass' : 'fail', message: config.topologyConfirmed ? 'Operator attests multi-hosting and independent participant submission; doctor has not verified topology.' : 'Operator confirmation of multi-hosting and independent participant submission is missing.', ...(!config.topologyConfirmed ? { action: 'Ask the Canton operator to confirm the party is multi-hosted and both participants can submit independently before setting topologyConfirmed=true.' } : {}) });
  const key = process.env[config.signingKeyEnv];
  if (!key) checks.push({ id: 'signer', label: 'Signing key', status: 'fail', message: 'Configured signing key environment variable is unset.', action: `Set ${config.signingKeyEnv} through the selected environment file or shell.` });
  else {
    try {
      const sdk = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) });
      if (await sdk.keys.fingerprint(getPublicKeyFromPrivate(key)) !== config.signingFingerprint) throw new Error('mismatch');
      checks.push({ id: 'signer', label: 'Signing key', status: 'pass', message: 'Signing key matches the configured fingerprint.' });
    } catch { checks.push({ id: 'signer', label: 'Signing key', status: 'fail', message: 'Signing key is invalid or does not match the configured fingerprint.', action: 'Use the private key corresponding to signingFingerprint, or correct the configured fingerprint.' }); }
  }
  const endpointResults = await Promise.all(endpointIds.map(async endpoint => {
    const result: DoctorCheck[] = [];
    const auth = config.endpoints[endpoint].auth;
    const variable = auth.type === 'static' ? auth.tokenEnv : auth.clientSecretEnv;
    result.push({ id: `${endpoint}.auth-env`, label: `${endpoint}: authentication environment`, status: process.env[variable] ? 'pass' : 'fail', message: process.env[variable] ? 'Configured authentication environment variable is set.' : 'Configured authentication environment variable is unset.', ...(!process.env[variable] ? { action: `Set ${variable} through the selected environment file or shell.` } : {}) });
    const ledger = new CantonLedger(endpoint, config);
    ledger.setDeadline(Date.now() + config.requestTimeoutMs);
    const inspect = async (id: string, label: string, action: string, run: () => Promise<unknown>): Promise<DoctorCheck> => {
      try { await run(); return { id: `${endpoint}.${id}`, label: `${endpoint}: ${label}`, status: 'pass', message: `${label} verified through authenticated reads.` }; }
      catch (error) {
        const kind = faultKind(error);
        const message = error instanceof Fault ? error.message : 'Response was malformed or did not meet the expected Ledger API schema.';
        const remedy = kind === 'auth' ? 'Check the configured token/client credentials, issuer audience, and authentication environment.' : kind === 'permission' ? 'Ask the operator to grant this authenticated user access to the configured party and required Ledger API reads.' : kind === 'availability' ? 'Check participant and identity-provider reachability, TLS, and requestTimeoutMs.' : kind === 'throttled' ? 'Wait for the identity provider or participant rate limit to clear before retrying.' : action;
        return { id: `${endpoint}.${id}`, label: `${endpoint}: ${label}`, status: 'fail', message, action: remedy };
      }
    };
    result.push(...await Promise.all([
      inspect('authenticated-user', 'Authenticated user', 'Check that /v2/authenticated-user returns a user with a nonempty ID.', async () => { z.object({ user: z.object({ id: z.string().min(1) }) }).parse(await ledger.transport.raw('GET', '/v2/authenticated-user')); }),
      inspect('identity', 'Participant identity', 'Correct the participant URL or participantId to match the intended participant.', async () => {
        const participant = z.object({ participantId: z.string() }).parse(await ledger.transport.raw('GET', '/v2/parties/participant-id'));
        if (participant.participantId !== config.endpoints[endpoint].participantId) throw new Fault('configuration', 'Participant identity differs from configuration.');
      }),
      inspect('connectivity', 'Party synchronizer connectivity', 'Ask the operator to connect the configured party to synchronizerId and verify its hosting.', async () => {
        const syncs = z.object({ connectedSynchronizers: z.array(z.object({ synchronizerId: z.string() })).optional() }).parse(await ledger.transport.raw('GET', '/v2/state/connected-synchronizers', undefined, { party: config.party }));
        if (!syncs.connectedSynchronizers?.some(s => s.synchronizerId === config.synchronizerId)) throw new Fault('configuration', 'Configured party is not connected to the expected synchronizer.');
      }),
      inspect('package', 'Package registration', 'Ask the operator to register the configured test DAR on this participant; doctor does not upload packages.', async () => {
        const pkg = z.object({ packageStatus: z.string() }).parse(await ledger.transport.raw('GET', `/v2/packages/${config.packageId}/status`));
        if (pkg.packageStatus !== 'PACKAGE_STATUS_REGISTERED') throw new Fault('configuration', 'Test package is not registered.');
      }),
      inspect('acs', 'Complete active-contract snapshot', 'Check party read permissions and complete ACS pagination; repair malformed or inconsistent participant responses.', () => ledger.snapshot('__doctor__')),
    ]));
    return result;
  }));
  checks.push(...endpointResults.flat());
  return { ready: !checks.some(check => check.status === 'fail'), checks };
}

export function formatDoctor(report: DoctorReport): string {
  return [report.ready ? 'Prerequisite reads passed. Independent writes remain untested.' : 'Prerequisites need attention before running.', ...report.checks.flatMap(check => [`${check.status.toUpperCase()} ${check.label}: ${check.message}`, ...(check.action ? [`  Next: ${check.action}`] : [])])].join('\n');
}
