import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SDK, CustomLogAdapter } from '@canton-network/wallet-sdk';
import { Fault, configSchema } from '../src/model.js';
import { doctor, formatDoctor, loadConfigChecked } from '../src/doctor.js';
import { bundledPackageId, bundledDarVerified } from '../src/assets.js';

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
  const suffix = randomUUID().replaceAll('-', '');
  const tokenEnv = `DOCTOR_TOKEN_${suffix}`; const keyEnv = `DOCTOR_KEY_${suffix}`;
  const keys = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) }).keys;
  const pair = keys.generate(); process.env[keyEnv] = pair.privateKey; process.env[tokenEnv] = 'synthetic-doctor-token';
  const state = { aStatus: 200, bIdentity: 'participant-B', connected: true, registered: true, incomplete: false, repeatPage: false, delayA: false, requests: [] as { method: string; route: string; endpoint: string }[] };
  const http = createServer(async (req, res) => {
    const endpoint = req.url!.startsWith('/a/') ? 'A' : 'B';
    const route = new URL(req.url!, 'http://localhost').pathname.slice(2);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    state.requests.push({ method: req.method!, route, endpoint });
    if (endpoint === 'A' && state.delayA) return;
    if (endpoint === 'A' && state.aStatus !== 200) { res.writeHead(state.aStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ secret: 'never-print-remote-details' })); return; }
    let response: unknown = {};
    if (route === '/v2/authenticated-user') response = { user: { id: 'synthetic-user' } };
    if (route === '/v2/parties/participant-id') response = { participantId: endpoint === 'A' ? 'participant-A' : state.bIdentity };
    if (route === '/v2/state/connected-synchronizers') response = { connectedSynchronizers: state.connected ? [{ synchronizerId: 'synthetic-sync' }] : [] };
    if (route.includes('/v2/packages/')) response = { packageStatus: state.registered ? 'PACKAGE_STATUS_REGISTERED' : 'PACKAGE_STATUS_UNKNOWN' };
    if (route === '/v2/state/ledger-end') response = { offset: 1 };
    if (route === '/v2/state/active-contracts-page') response = { activeAtOffset: 1, ...(state.repeatPage ? { nextPageToken: 'repeated' } : !body.pageToken ? { nextPageToken: 'second-page' } : {}), activeContracts: state.incomplete ? [{ secret: 'never-print-acs-details' }] : [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const config = configSchema.parse({ mode: 'simulation', party: 'synthetic-party', synchronizerId: 'synthetic-sync', packageId: bundledPackageId, signingKeyEnv: keyEnv, signingFingerprint: await keys.fingerprint(pair.publicKey), topologyConfirmed: true, requestTimeoutMs: 1000, endpoints: { A: { url: `${url}/a`, participantId: 'participant-A', auth: { type: 'static', tokenEnv } }, B: { url: `${url}/b`, participantId: 'participant-B', auth: { type: 'static', tokenEnv } } } });
  const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(config));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); delete process.env[tokenEnv]; delete process.env[keyEnv]; rmSync(dir, { recursive: true, force: true }); });
  return { state, config, path, keyEnv, tokenEnv, save: () => writeFileSync(path, JSON.stringify(config)) };
}

test('doctor collects safe field-specific config errors and still checks independent local prerequisites', async t => {
  const f = await fixture(t);
  writeFileSync(f.path, JSON.stringify({ mode: 'secret-value-never-print', party: 42, packageId: 'never-print-this-either', endpoints: { A: {} } }));
  assert.throws(() => loadConfigChecked(f.path), (error: unknown) => error instanceof Fault && error.kind === 'configuration' && error.message.includes('signingKeyEnv') && error.message.includes('endpoints.B') && !error.message.includes('secret-value') && !error.message.includes('never-print'));
  const report = await doctor(f.path);
  assert.equal(report.ready, false);
  assert.ok(report.checks.filter(c => c.id.startsWith('config.')).length >= 5);
  assert.ok(report.checks.some(c => c.id === 'node'));
  assert.ok(report.checks.some(c => c.id === 'dar'));
  assert.equal(f.state.requests.length, 0);
  assert.ok(!formatDoctor(report).includes('never-print'));
});

test('doctor verifies both participants and complete paginated ACS without write routes', async t => {
  const f = await fixture(t);
  const report = await doctor(f.path);
  assert.equal(bundledDarVerified(), true);
  assert.equal(report.ready, true);
  assert.equal(report.checks.find(c => c.id === 'dar')?.status, 'pass');
  assert.equal(report.checks.find(c => c.id === 'signer')?.status, 'pass');
  assert.equal(report.checks.find(c => c.id === 'writes')?.status, 'warn');
  for (const endpoint of ['A', 'B']) {
    assert.equal(report.checks.find(c => c.id === `${endpoint}.acs`)?.status, 'pass');
    assert.equal(f.state.requests.filter(r => r.endpoint === endpoint && r.route === '/v2/state/active-contracts-page').length, 2);
  }
  assert.ok(f.state.requests.every(r => r.method === 'GET' || (r.method === 'POST' && r.route === '/v2/state/active-contracts-page')));
  assert.ok(!f.state.requests.some(r => /prepare|execute/.test(r.route)));
  assert.ok(formatDoctor(report).includes('Independent writes remain untested'));
});

test('doctor reports all independent problems: missing signer, failing A, wrong B identity, topology and missing package', async t => {
  const f = await fixture(t);
  delete process.env[f.keyEnv]; f.state.aStatus = 503; f.state.bIdentity = 'wrong-identity'; f.state.registered = false; f.state.connected = false;
  f.config.topologyConfirmed = false; f.save();
  const report = await doctor(f.path);
  assert.equal(report.ready, false);
  for (const id of ['signer', 'topology', 'A.authenticated-user', 'B.identity', 'B.connectivity', 'B.package']) {
    const check = report.checks.find(c => c.id === id)!;
    assert.equal(check.status, 'fail'); assert.ok(check.action, `${id} must be actionable`);
  }
  assert.equal(report.checks.find(c => c.id === 'B.acs')?.status, 'pass');
  assert.ok(f.state.requests.some(r => r.endpoint === 'B'));
  assert.ok(!formatDoctor(report).includes('never-print-remote-details'));
});

test('doctor reports wrong signer, missing auth environment and permission failures safely', async t => {
  const f = await fixture(t);
  f.config.signingFingerprint = 'wrong-fingerprint'; f.state.aStatus = 403; f.save();
  let report = await doctor(f.path);
  assert.equal(report.checks.find(c => c.id === 'signer')?.status, 'fail');
  assert.ok(report.checks.find(c => c.id === 'A.acs')?.action?.includes('grant'));
  delete process.env[f.tokenEnv]; report = await doctor(f.path);
  assert.equal(report.checks.find(c => c.id === 'A.auth-env')?.status, 'fail');
  assert.ok(report.checks.find(c => c.id === 'A.auth-env')?.action?.includes(f.tokenEnv));
  assert.equal(report.checks.find(c => c.id === 'B.authenticated-user')?.status, 'fail');
  assert.ok(!formatDoctor(report).includes('synthetic-doctor-token'));
});

test('doctor rejects incomplete or looping snapshots without including response payloads', async t => {
  const f = await fixture(t);
  f.state.incomplete = true;
  let report = await doctor(f.path);
  assert.equal(report.checks.find(c => c.id === 'A.acs')?.status, 'fail');
  assert.ok(!formatDoctor(report).includes('never-print-acs-details'));
  f.state.incomplete = false; f.state.repeatPage = true; report = await doctor(f.path);
  assert.equal(report.checks.find(c => c.id === 'B.acs')?.status, 'fail');
  assert.ok(report.checks.find(c => c.id === 'B.acs')?.message.includes('pagination'));
});

test('doctor bounds an unavailable A endpoint while still completing B checks', async t => {
  const f = await fixture(t); f.state.delayA = true; f.config.requestTimeoutMs = 100; f.save();
  const start = Date.now(); const report = await doctor(f.path);
  assert.ok(Date.now() - start < 1000);
  assert.equal(report.checks.find(c => c.id === 'A.acs')?.status, 'fail');
  assert.equal(report.checks.find(c => c.id === 'B.acs')?.status, 'pass');
  assert.ok(report.checks.find(c => c.id === 'A.identity')?.action?.includes('reachability'));
});
