import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SDK, CustomLogAdapter } from '@canton-network/wallet-sdk';
import { runSetup } from '../src/setup.js';
import { listProfiles } from '../src/profiles.js';
import { bundledPackageId } from '../src/assets.js';
import { Config } from '../src/model.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'canton-setup-'));
  const suffix = randomUUID().replaceAll('-', '');
  const envs = [`SETUP_KEY_${suffix}`, `SETUP_A_${suffix}`, `SETUP_B_${suffix}`];
  t.after(() => { envs.forEach(name => delete process.env[name]); rmSync(dir, { recursive: true, force: true }); });
  return { dir, envs };
}
async function wizard(dir: string, lines: string[]) {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const profile = await runSetup({ profilesDir: dir, input: Readable.from([lines.join('\n') + '\n']), output });
  return { profile, text, config: profile ? JSON.parse(readFileSync(profile.path, 'utf8')) as Config : undefined };
}
const manualTail = ['participant-A', 'participant-B', 'synthetic-sync', '', '', '', '', ''];

test('manual setup saves a baseline with env references and retries invalid fields early', async t => {
  const { dir, envs } = fixture(t);
  const r = await wizard(dir, ['../escape', 'manual', 'synthetic-party', 'invalid env name', envs[0], 'public-fingerprint',
    'http://remote.example.invalid', 'https://a.example.invalid', 'static', envs[1], 'https://a.example.invalid', 'https://b.example.invalid', 'static', envs[2], ...manualTail]);
  assert.equal(r.profile?.name, 'manual');
  assert.equal(r.config?.packageId, bundledPackageId);
  assert.equal(r.config?.count, 30);
  assert.equal(r.config?.topologyConfirmed, false);
  assert.deepEqual(r.config?.scenario, { type: 'baseline' });
  assert.equal(r.config?.signingKeyEnv, envs[0]);
  assert.match(r.text, /Invalid input/);
  assert.match(r.text, /credential environment variable is unset/);
  assert.deepEqual(r.config?.endpoints.A.auth, { type: 'static', tokenEnv: envs[1] });
});

test('setup presets retain their required token formats and configurable client authentication', async t => {
  const { dir, envs } = fixture(t);
  const cases = [
    ['keycloak', 'https://keycloak.example.invalid/realms/synthetic', 'client_secret_post', '/realms/synthetic/protocol/openid-connect/token'],
    ['okta', 'https://okta.example.invalid/oauth2/default', 'client_secret_basic', '/oauth2/default/v1/token'],
    ['genericOIDC', 'https://oidc.example.invalid/custom/token', 'client_secret_post', '/custom/token'],
  ];
  for (const [provider, issuer, method, tokenPath] of cases) {
    const r = await wizard(dir, [provider, 'synthetic-party', envs[0], 'public-fingerprint', 'https://a.example.invalid', provider,
      issuer, 'synthetic-client', envs[1], '', 'ledger.read', method, 'https://b.example.invalid', 'static', envs[2], ...manualTail]);
    const auth = r.config!.endpoints.A.auth;
    assert.equal(auth.type, 'oidc');
    if (auth.type === 'oidc') {
      assert.equal(new URL(auth.tokenUrl).pathname, tokenPath);
      assert.equal(auth.tokenEndpointAuthMethod, method);
      assert.equal(auth.scope, 'ledger.read');
      assert.equal(auth.clientSecretEnv, envs[1]);
    }
  }
  const r = await wizard(dir, ['auth0', 'synthetic-party', envs[0], 'public-fingerprint', 'https://a.example.invalid', 'auth0',
    'https://tenant.auth0.example.invalid', 'synthetic-client', envs[1], 'synthetic-ledger-audience', '', 'https://b.example.invalid', 'static', envs[2], ...manualTail]);
  const auth = r.config!.endpoints.A.auth;
  assert.equal(auth.type, 'auth0');
  if (auth.type === 'auth0') { assert.equal(auth.tokenUrl, 'https://tenant.auth0.example.invalid/oauth/token'); assert.equal(auth.audience, 'synthetic-ledger-audience'); }
});

test('authenticated GET discovery selects one common synchronizer and derives fingerprint locally', async t => {
  const { dir, envs } = fixture(t);
  const keys = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) }).keys;
  const pair = keys.generate(); const fingerprint = await keys.fingerprint(pair.publicKey);
  process.env[envs[0]] = pair.privateKey; process.env[envs[1]] = 'synthetic-token-A'; process.env[envs[2]] = 'synthetic-token-B';
  const requests: { method: string | undefined; path: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    const id = url.pathname.startsWith('/a/') ? 'A' : 'B';
    if (url.pathname.endsWith('participant-id')) res.end(JSON.stringify({ participantId: `discovered-${id}` }));
    else { assert.equal(url.searchParams.get('party'), 'synthetic-party'); res.end(JSON.stringify({ connectedSynchronizers: [{ synchronizerId: 'common-sync' }, { synchronizerId: `only-${id}` }] })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const r = await wizard(dir, ['discovered', 'synthetic-party', envs[0], `${url}/a`, 'static', envs[1], `${url}/b`, 'static', envs[2], '', '3', '0', 'failover', 'B', '0', '2', '1000', 'yes']);
  assert.equal(r.config?.signingFingerprint, fingerprint);
  assert.equal(r.config?.synchronizerId, 'common-sync');
  assert.equal(r.config?.endpoints.A.participantId, 'discovered-A');
  assert.equal(r.config?.endpoints.B.participantId, 'discovered-B');
  assert.equal(r.config?.topologyConfirmed, true);
  assert.equal(r.config?.primary, 'B');
  assert.deepEqual(r.config?.scenario, { type: 'failover', faultedEndpoint: 'B', minSurvivorOperations: 2, recoveryTimeoutMs: 1000 });
  assert.equal(requests.length, 4); assert.ok(requests.every(r => r.method === 'GET'));
  assert.ok(requests.every(r => r.authorization === `Bearer synthetic-token-${r.path.startsWith('/a/') ? 'A' : 'B'}`));
  assert.ok(!r.text.includes(pair.privateKey)); assert.ok(!r.text.includes('synthetic-token-'));
  assert.ok(!readFileSync(r.profile!.path, 'utf8').includes(pair.privateKey));
});

test('multiple discovered common synchronizers require a bounded choice', async t => {
  const { dir, envs } = fixture(t);
  process.env[envs[1]] = 'synthetic-token-A'; process.env[envs[2]] = 'synthetic-token-B';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url!.includes('participant-id') ? { participantId: req.url!.startsWith('/a/') ? 'A' : 'B' } : { connectedSynchronizers: [{ synchronizerId: 'sync-one' }, { synchronizerId: 'sync-two' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const r = await wizard(dir, ['multiple', 'synthetic-party', envs[0], 'public-fingerprint', `${url}/a`, 'static', envs[1], `${url}/b`, 'static', envs[2], '9', '2', '', '', '', '', '']);
  assert.equal(r.config?.synchronizerId, 'sync-two');
  assert.match(r.text, /Common synchronizer number/); assert.match(r.text, /Choose 1–2/);
});

test('discovery errors use manual fallback without printing remote bodies or secrets', async t => {
  const { dir, envs } = fixture(t);
  process.env[envs[1]] = 'synthetic-secret-A'; process.env[envs[2]] = 'synthetic-secret-B';
  const server = createServer((_req, res) => { res.writeHead(503); res.end('remote-body-secret-must-not-appear'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const r = await wizard(dir, ['fallback', 'synthetic-party', envs[0], 'public-fingerprint', `${url}/a`, 'static', envs[1], `${url}/b`, 'static', envs[2], ...manualTail]);
  assert.equal(r.config?.endpoints.A.participantId, 'participant-A');
  assert.match(r.text, /discovery unavailable \(availability\)/);
  assert.ok(!r.text.includes('remote-body-secret')); assert.ok(!r.text.includes('synthetic-secret-'));
});

test('EOF and explicit cancellation stop without saving a profile', async t => {
  const { dir } = fixture(t);
  const eof = await wizard(dir, []); assert.equal(eof.profile, undefined); assert.match(eof.text, /cancelled/);
  const cancel = await wizard(dir, ['cancel']); assert.equal(cancel.profile, undefined);
  assert.deepEqual(listProfiles(dir), []);
});

test('invalid signing-key env value uses a public-fingerprint fallback without exposing the key', async t => {
  const { dir, envs } = fixture(t);
  process.env[envs[0]] = 'synthetic-invalid-private-key-must-not-appear';
  const r = await wizard(dir, ['invalid-key', 'synthetic-party', envs[0], 'expected-public-fingerprint',
    'https://a.example.invalid', 'static', envs[1], 'https://b.example.invalid', 'static', envs[2], ...manualTail]);
  assert.equal(r.config?.signingFingerprint, 'expected-public-fingerprint');
  assert.match(r.text, /Signing key could not be parsed/);
  assert.ok(!r.text.includes(process.env[envs[0]]!));
  assert.ok(!readFileSync(r.profile!.path, 'utf8').includes(process.env[envs[0]]!));
});

test('nonTTY default input exits promptly without consuming stdin or saving', { skip: Boolean(process.stdin.isTTY) }, async t => {
  const { dir } = fixture(t); let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  assert.equal(await runSetup({ profilesDir: dir, output }), undefined);
  assert.match(text, /needs a terminal/);
  assert.deepEqual(listProfiles(dir), []);
});
