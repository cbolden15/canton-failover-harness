import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import { Simulator } from '../src/simulator.js';
import { startUi, trafficSnapshot } from '../src/ui.js';

test('live viewer reads the journal without writes and omits sensitive event data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-ui-'));
  const journal = new Journal(join(dir, 'journal.sqlite'));
  const simulator = new Simulator();
  const config = await simulator.start();
  journal.initialize(config, 'viewer-test');
  journal.event('endpoint_error', { endpoint: 'A', kind: 'availability', token: 'DO_NOT_EXPOSE', preparedTransaction: 'DO_NOT_EXPOSE' });
  journal.plan({ sequence: 1, inputStateId: 'private-contract', payloadDigest: 'private-payload', status: 'planned' });
  journal.attempt(1, 'A');
  const before = journal.events();
  const ui = await startUi({ journal: journal.path, port: 0 });
  t.after(async () => { await ui.close(); journal.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = ui.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/traffic`);
  const body = await response.json() as { readOnly: boolean; snapshot: ReturnType<typeof trafficSnapshot> };
  assert.equal(body.readOnly, true);
  assert.equal(body.snapshot.operations[0].status, 'unknown');
  assert.equal(body.snapshot.committed, 0);
  assert.equal(body.snapshot.result, 'INCONCLUSIVE');
  assert.deepEqual(body.snapshot.identities, { externalPartyId: config.party, participants: { A: config.endpoints.A.participantId, B: config.endpoints.B.participantId } });
  assert.ok(!JSON.stringify(body).includes('DO_NOT_EXPOSE'));
  assert.ok(!JSON.stringify(body).includes('private-contract'));
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers: { Origin: base } })).status, 403);
  assert.deepEqual(journal.events(), before);
  journal.event('stopped', { kind: 'availability' });
  assert.equal(trafficSnapshot(journal).stopped, true);
  journal.attempt(1, 'B');
  assert.equal(trafficSnapshot(journal).stopped, false, 'a resumed run must not retain the previous stopped display');
  journal.delete('displayIdentities');
  assert.equal(trafficSnapshot(journal).identities, null);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  journal.set('configPath', configPath);
  assert.deepEqual(trafficSnapshot(journal).identities, body.snapshot.identities);
  writeFileSync(configPath, JSON.stringify({ ...config, party: 'different-party' }));
  assert.equal(trafficSnapshot(journal).identities, null, 'changed config must not mislabel the original run');
});

test('simulation viewer blocks cross-origin starts and reports real receipt-confirmed failover', { timeout: 25000 }, async t => {
  const ui = await startUi({ port: 0 });
  t.after(() => ui.close());
  const address = ui.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers: { Origin: base } })).status, 202);
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers: { Origin: base } })).status, 409);
  let body: { running: boolean; snapshot: ReturnType<typeof trafficSnapshot> };
  do {
    await new Promise(resolve => setTimeout(resolve, 200));
    body = await (await fetch(`${base}/api/traffic`)).json() as typeof body;
  } while (body.running);
  assert.equal(body.snapshot.mode, 'simulation');
  assert.deepEqual(body.snapshot.identities, { externalPartyId: 'simulation-party::namespace', participants: { A: 'participant-A', B: 'participant-B' } });
  assert.equal(body.snapshot.result, 'SIMULATION_FAILOVER_PASS');
  assert.equal(body.snapshot.committed, 16);
  assert.equal(body.snapshot.activeEndpoint, 'B');
  assert.ok(body.snapshot.events.some(e => e.kind === 'failover'));
  assert.ok(body.snapshot.events.some(e => e.kind === 'operation_committed' && e.data.endpoint === 'B'));
});

test('UI launches configured workload, stops and resumes the same root through proxy controls (local endpoints)', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-ui-live-'));
  const simulator = new Simulator();
  // Test the live control path using local fake Ledger API endpoints, never real infrastructure.
  const config = await simulator.start({ mode: 'testnet', count: 30, intervalMs: 150,
    scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const journalPath = join(dir, 'journal.sqlite');
  let ui = await startUi({ liveConfig: configPath, journal: journalPath, port: 0 });
  t.after(async () => { await ui.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  let address = ui.server.address(); assert.ok(address && typeof address !== 'string');
  let base = `http://127.0.0.1:${address.port}`;
  const action = (path: string, origin = base) => fetch(base + path, { method: 'POST', headers: { Origin: origin } });
  type State = { running: boolean; live: { initialized: boolean; error?: string }; snapshot: ReturnType<typeof trafficSnapshot> | null };
  const state = async () => (await (await fetch(base + '/api/traffic')).json()) as State;
  const until = async (predicate: (s: State) => boolean) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const s = await state(); if (predicate(s)) return s;
      assert.ok(Date.now() < deadline, JSON.stringify(s));
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  assert.equal((await state()).live.initialized, false);
  assert.equal((await action('/api/live/start', 'https://example.com')).status, 403);
  assert.equal((await action('/api/live/start')).status, 202);
  assert.equal((await action('/api/live/start')).status, 409);
  const started = await until(s => (s.snapshot?.committed ?? 0) >= 1);
  const rootJournal = new Journal(journalPath, false); const root = rootJournal.get('rootId'); rootJournal.close();
  assert.equal((await action('/api/live/stop')).status, 202);
  await until(s => !s.running);
  await ui.close();
  ui = await startUi({ liveConfig: configPath, journal: journalPath, port: 0 });
  address = ui.server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  assert.equal((await state()).live.initialized, true);
  assert.equal((await action('/api/live/start')).status, 202);
  await until(s => s.running && (s.snapshot?.committed ?? 0) >= 2);
  assert.equal((await action('/api/proxy/A/block')).status, 200);
  await until(s => (s.snapshot?.survivorConfirmed ?? 0) >= 2);
  assert.equal((await action('/api/proxy/A/restore')).status, 200);
  const finished = await until(s => !s.running && s.snapshot?.committed === 30);
  assert.equal(finished.snapshot?.runId, started.snapshot?.runId);
  assert.equal(finished.snapshot?.result, 'CLIENT_PROXY_FAILOVER_PASS');
  assert.equal((await action('/api/live/start')).status, 409);
  const saved = new Journal(journalPath, false);
  assert.equal(saved.get('rootId'), root); saved.close();
  assert.equal(simulator.offline.size, 0);
});


test('default dashboard configures live connections without files, keeps secrets private, and resumes a saved run', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-browser-setup-'));
  const simulator = new Simulator();
  const config = await simulator.start({ mode: 'testnet', count: 25, intervalMs: 150,
    scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
  const credentials = { signingKey: process.env[config.signingKeyEnv]!, A: 'local-simulation-only', B: 'local-simulation-only' };
  let ui = await startUi({ port: 0, runsDirectory: dir });
  t.after(async () => { await ui.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  const baseUrl = () => { const address = ui.server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; };
  const get = async (path: string) => (await fetch(baseUrl() + path)).json();
  const post = (path: string, body?: unknown, origin = baseUrl()) => fetch(baseUrl() + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const until = async (predicate: (s: any) => boolean) => {
    const deadline = Date.now() + 15000;
    for (;;) { const s = await get('/api/traffic'); if (predicate(s)) return s; assert.ok(Date.now() < deadline, JSON.stringify(s)); await new Promise(resolve => setTimeout(resolve, 40)); }
  };
  const initial = await get('/api/traffic'); assert.equal(initial.canSetup, true); assert.equal(initial.canDemo, true);
  const page = await (await fetch(baseUrl())).text(); assert.match(page, /id="live-setup">Live test/); assert.match(page, /id="live-form"/);
  assert.equal((await post('/api/live/configure', { config, credentials }, 'https://example.com')).status, 403);
  const invalid = await post('/api/live/configure', { config: { ...config, endpoints: { ...config.endpoints, A: { ...config.endpoints.A, token: 'DO_NOT_EXPOSE' } } }, credentials });
  assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes('DO_NOT_EXPOSE'));
  assert.equal((await post('/api/live/configure', { config, credentials })).status, 200);
  const setup = await get('/api/live/setup'); assert.equal(setup.runs.length, 1);
  const selected = setup.runs[0]; assert.equal(selected.config.signingFingerprint, config.signingFingerprint);
  const configured = await get('/api/traffic'); assert.equal(configured.live.initialized, false); assert.equal(configured.canDemo, false);
  for (const secret of Object.values(credentials)) {
    assert.ok(!JSON.stringify(setup).includes(secret));
    assert.ok(!JSON.stringify(configured).includes(secret));
    assert.ok(!readFileSync(configured.live.configPath, 'utf8').includes(secret));
  }
  assert.equal(statSync(configured.live.configPath).mode & 0o777, 0o600);
  assert.equal((await post('/api/live/check')).status, 202);
  const checked = await until(s => !s.running && s.live.readiness);
  assert.equal(checked.live.readiness.ready, true);
  assert.equal(simulator.executions.length, 0, 'setup and connection checks never write to the ledger');
  assert.equal((await post('/api/live/start')).status, 202);
  const started = await until(s => s.snapshot?.committed >= 1);
  assert.equal((await post('/api/live/stop')).status, 202); await until(s => !s.running);
  assert.equal((await post('/api/live/configure', { config, credentials })).status, 409, 'unfinished run must not be replaced by another root');
  await ui.close(); ui = await startUi({ port: 0, runsDirectory: dir });
  assert.equal((await post('/api/live/configure', { savedRun: '../../private', credentials })).status, 400);
  assert.equal((await post('/api/live/configure', { savedRun: selected.id, credentials })).status, 200);
  assert.equal((await post('/api/live/start')).status, 202);
  await until(s => s.running && s.snapshot?.committed >= 2);
  assert.equal((await post('/api/proxy/A/block')).status, 200);
  await until(s => s.snapshot?.survivorConfirmed >= 2);
  assert.equal((await post('/api/proxy/A/restore')).status, 200);
  const finished = await until(s => !s.running && s.snapshot?.committed === 25);
  assert.equal(finished.snapshot.runId, started.snapshot.runId);
  assert.equal(finished.snapshot.result, 'CLIENT_PROXY_FAILOVER_PASS');
  assert.equal(simulator.executions.filter(e => e.sequence === 0).length, 1);
});
