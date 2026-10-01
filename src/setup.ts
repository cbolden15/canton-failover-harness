import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SDK, CustomLogAdapter, getPublicKeyFromPrivate } from '@canton-network/wallet-sdk';
import { AuthConfig, Config, EndpointId, Fault, authSchema, configSchema, faultKind } from './model.js';
import { bundledDarVerified, bundledPackageId } from './assets.js';
import { Profile, listProfiles, saveProfile } from './profiles.js';
import { Transport } from './transport.js';

class Cancelled extends Error {}
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const plain = (value: string) => value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const safeUrl = (value: string) => {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash &&
    (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); }
  catch { return false; }
};
const positive = (value: string, maximum = Number.MAX_SAFE_INTEGER) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= maximum;

export async function runSetup(options: { profilesDir?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<Profile | undefined> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const write = (text: string) => { output.write(text); };
  if (!options.input && !process.stdin.isTTY) { write('Setup needs a terminal. Run canton-failover setup interactively, or supply --config to doctor/run.\n'); return undefined; }
  if (!bundledDarVerified()) throw new Fault('configuration', 'Bundled DAR is missing or does not match its checksum');
  const rl = createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY), crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => rl.close());
  const ask = async (label: string, fallback = '', validate = plain, hint = 'Enter a nonempty value.') => {
    while (true) {
      write(`${label}${fallback ? ` [${fallback}]` : ''}: `);
      const line = await lines.next();
      if (line.done || ['cancel', 'quit'].includes(line.value.trim().toLowerCase())) throw new Cancelled();
      const value = line.value.trim() || fallback;
      if (validate(value)) return value;
      write(`Invalid input. ${hint}\n`);
    }
  };
  const choice = (label: string, choices: string[], fallback: string) => ask(label, fallback,
    value => choices.some(c => c.toLowerCase() === value.toLowerCase()), `Choose ${choices.join(', ')}.`).then(value => choices.find(c => c.toLowerCase() === value.toLowerCase())!);
  const auth = async (id: EndpointId): Promise<AuthConfig> => {
    const provider = await choice(`${id} authentication provider (keycloak/okta/auth0/genericOIDC/static)`, ['keycloak', 'okta', 'auth0', 'genericOIDC', 'static'], 'keycloak');
    if (provider === 'static') return { type: 'static', tokenEnv: await ask(`${id} token environment variable name`, `CANTON_${id}_TOKEN`, v => envName.test(v), 'Enter an environment variable name, not a token.') };
    const issuer = await ask(provider === 'genericOIDC' ? `${id} token endpoint URL` : `${id} ${provider} issuer URL${provider === 'keycloak' ? ' (include /realms/REALM)' : ''}`, '', safeUrl, 'Use HTTPS or loopback HTTP, without credentials, query, or fragment.');
    const suffix = provider === 'keycloak' ? '/protocol/openid-connect/token' : provider === 'okta' ? '/v1/token' : provider === 'auth0' ? '/oauth/token' : '';
    const tokenUrl = issuer.replace(/\/$/, '') + suffix;
    const clientId = await ask(`${id} OAuth client ID`);
    const clientSecretEnv = await ask(`${id} client-secret environment variable name`, `CANTON_${id}_CLIENT_SECRET`, v => envName.test(v), 'Enter an environment variable name, not a secret.');
    const audience = await ask(`${id} audience${provider === 'auth0' ? '' : ' (optional)'}`, '', provider === 'auth0' ? plain : v => !v || plain(v));
    const scope = await ask(`${id} scope (optional)`, '', v => !v || plain(v));
    if (provider === 'auth0') return authSchema.parse({ type: 'auth0', tokenUrl, clientId, clientSecretEnv, audience, ...(scope ? { scope } : {}) });
    const tokenEndpointAuthMethod = await choice(`${id} token client authentication (client_secret_basic/client_secret_post)`, ['client_secret_basic', 'client_secret_post'], provider === 'keycloak' ? 'client_secret_post' : 'client_secret_basic');
    return authSchema.parse({ type: 'oidc', tokenUrl, clientId, clientSecretEnv, tokenEndpointAuthMethod, ...(audience ? { audience } : {}), ...(scope ? { scope } : {}) });
  };
  try {
    write('Create a testnet profile. Type cancel or press Ctrl-C to stop. Enter environment variable names only; setup never asks for secret values.\n');
    const directory = resolve(options.profilesDir ?? resolve(process.cwd(), 'profiles'));
    const names = listProfiles(directory).map(p => p.name);
    const name = await ask('Profile name', 'testnet', v => profileName.test(v) && !names.includes(v), 'Use a new name with letters, digits, underscores, or hyphens. Existing profiles are preserved.');
    const party = await ask('Party ID');
    const signingKeyEnv = await ask('Signing-key environment variable name', 'CANTON_TEST_SIGNING_KEY', v => envName.test(v), 'Enter an environment variable name, not a key.');
    let signingFingerprint: string | undefined;
    if (process.env[signingKeyEnv]) {
      try { signingFingerprint = await SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) }).keys.fingerprint(getPublicKeyFromPrivate(process.env[signingKeyEnv]!)); write('Derived signing fingerprint from the configured environment variable.\n'); }
      catch { write('Signing key could not be parsed. Enter the expected public fingerprint; doctor will check the configured key.\n'); }
    } else write('Signing-key environment variable is unset. Enter the expected public fingerprint; load the key before doctor/run.\n');
    signingFingerprint ??= await ask('Expected signing public-key fingerprint');
    const urlA = await ask('A Ledger API URL', '', safeUrl, 'Use HTTPS or loopback HTTP without embedded credentials, query, or fragment.');
    const authA = await auth('A');
    const urlB = await ask('B Ledger API URL', '', v => safeUrl(v) && v !== urlA, 'Use a different safe Ledger API URL.');
    const authB = await auth('B');
    const config = configSchema.parse({ mode: 'testnet', party, signingKeyEnv, signingFingerprint, synchronizerId: 'pending', packageId: bundledPackageId,
      requestTimeoutMs: 1500, endpoints: { A: { url: urlA, participantId: 'pending-A', auth: authA }, B: { url: urlB, participantId: 'pending-B', auth: authB } } });
    const discover = async (id: EndpointId) => {
      const auth = config.endpoints[id].auth;
      if (!process.env[auth.type === 'static' ? auth.tokenEnv : auth.clientSecretEnv]) { write(`${id} discovery skipped: credential environment variable is unset.\n`); return {}; }
      const transport = new Transport(id, config); transport.deadline = Date.now() + 3000;
      const [participant, synchronizers] = await Promise.allSettled([
        transport.raw('GET', '/v2/parties/participant-id'), transport.raw('GET', '/v2/state/connected-synchronizers', undefined, { party }),
      ]);
      let participantId: string | undefined, syncs: string[] | undefined;
      try {
        if (participant.status === 'fulfilled') participantId = z.object({ participantId: z.string().min(1) }).parse(participant.value).participantId;
        else write(`${id} participant discovery unavailable (${faultKind(participant.reason)}).\n`);
      } catch { write(`${id} participant discovery returned an unsupported response.\n`); }
      try {
        if (synchronizers.status === 'fulfilled') syncs = z.object({ connectedSynchronizers: z.array(z.object({ synchronizerId: z.string().min(1) })) }).parse(synchronizers.value).connectedSynchronizers.map(s => s.synchronizerId);
        else write(`${id} synchronizer discovery unavailable (${faultKind(synchronizers.reason)}).\n`);
      } catch { write(`${id} synchronizer discovery returned an unsupported response.\n`); }
      return { participantId, syncs };
    };
    const [a, b] = await Promise.all([discover('A'), discover('B')]);
    config.endpoints.A.participantId = a.participantId ?? await ask('A participant ID (manual fallback)');
    config.endpoints.B.participantId = b.participantId && b.participantId !== config.endpoints.A.participantId ? b.participantId :
      await ask('B participant ID (manual fallback)', '', v => plain(v) && v !== config.endpoints.A.participantId, 'A and B must identify different participants.');
    const common = [...new Set((a.syncs ?? []).filter(id => b.syncs?.includes(id)))];
    if (common.length === 1) { config.synchronizerId = common[0]; write('Selected the single synchronizer visible on both participants.\n'); }
    else if (common.length > 1) {
      common.forEach((id, index) => write(`${index + 1}. ${JSON.stringify(id)}\n`));
      config.synchronizerId = common[Number(await ask('Common synchronizer number', '1', v => positive(v, common.length), `Choose 1–${common.length}.`)) - 1];
    } else config.synchronizerId = await ask('Synchronizer ID (manual fallback; doctor checks both participants)');
    config.packageId = await ask('Package ID (verified bundled DAR default)', bundledPackageId, v => /^[a-f0-9]{64}$/.test(v), 'Enter a 64-character lowercase hexadecimal package ID.');
    config.count = Number(await ask('Operation count', '30', v => positive(v, 10000), 'Enter an integer from 1 to 10000.'));
    config.intervalMs = Number(await ask('Workload interval in milliseconds', '2000', v => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)), 'Enter a nonnegative integer.'));
    const scenario = await choice('Scenario (baseline/failover)', ['baseline', 'failover'], 'baseline');
    if (scenario === 'failover') config.scenario = { type: 'failover', faultedEndpoint: await choice('Endpoint to fault (A/B)', ['A', 'B'], 'A') as EndpointId,
      minSurvivorOperations: Number(await ask('Minimum fresh survivor operations', '1', v => positive(v, config.count), `Enter an integer from 1 to ${config.count}.`)),
      recoveryTimeoutMs: Number(await ask('Client-observed recovery bound in milliseconds', '60000', v => positive(v), 'Enter a positive integer.')) };
    if (config.scenario.type === 'failover') config.primary = config.scenario.faultedEndpoint;
    write('Topology is an operator attestation. Read discovery does not prove multi-hosting or independent submission.\n');
    config.topologyConfirmed = ['yes', 'y'].includes(await choice('Independently verified multi-hosting and independent submission on both participants? (yes/no)', ['yes', 'no', 'y', 'n'], 'no'));
    // Discovery uses a short timeout; saved runs retain the standard request timeout.
    config.requestTimeoutMs = 10000;
    const profile = saveProfile(name, config, directory);
    write(`Saved profile ${profile.path}. Load its referenced environment variables before doctor/run.\n`);
    return profile;
  } catch (e) {
    if (e instanceof Cancelled) { write('\nSetup cancelled. No profile was saved.\n'); return undefined; }
    throw e;
  } finally { rl.close(); }
}
