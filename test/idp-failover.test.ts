import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, configSchema, operationDigest } from '../src/model.js';
import { Simulator } from '../src/simulator.js';
import { CantonLedger } from '../src/ledger.js';
import { Journal } from '../src/journal.js';
import { Runner } from '../src/runner.js';

async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'idp-failover-test-'));
  const simulator = new Simulator(join(dir, 'ledger.sqlite'));
  const base = await simulator.start({ count: 1, failureThreshold: 1 });
  const secretEnv = `IDP_TEST_SECRET_${randomUUID().replaceAll('-', '')}`;
  process.env[secretEnv] = 'synthetic-client-secret';
  const state = { statusA: 200, onceA: false, requestsA: 0, requestsB: 0 };
  const idp = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the synthetic client credentials body. */ }
    const endpoint = req.url === '/a/token' ? 'A' : 'B';
    if (endpoint === 'A') state.requestsA++; else state.requestsB++;
    const status = endpoint === 'A' ? state.statusA : 200;
    if (endpoint === 'A' && state.onceA) { state.statusA = 200; state.onceA = false; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { access_token: 'local-simulation-only', token_type: 'Bearer', expires_in: 3600 } : { error_description: 'synthetic-private-provider-details' }));
  });
  await new Promise<void>(resolve => idp.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const auth = (endpoint: string) => ({ type: 'oidc', tokenUrl: `${url}/${endpoint}/token`, clientId: 'synthetic-client', clientSecretEnv: secretEnv });
  const config = configSchema.parse({ ...base, endpoints: { A: { ...base.endpoints.A, auth: auth('a') }, B: { ...base.endpoints.B, auth: auth('b') } } });
  const journal = new Journal(join(dir, 'journal.sqlite')); journal.acquire(); journal.initialize(config, randomUUID());
  const ledgers = { A: new CantonLedger('A', config), B: new CantonLedger('B', config) };
  const runner = new Runner(config, journal, ledgers);
  t.after(async () => {
    journal.close(); await simulator.close();
    idp.closeAllConnections(); await new Promise<void>(resolve => idp.close(() => resolve()));
    delete process.env[secretEnv]; rmSync(dir, { recursive: true, force: true });
  });
  await runner.bootstrap();
  assert.equal(state.requestsA, 1, 'A preflight and bootstrap must warm its token cache');
  assert.equal(state.requestsB, 1, 'B preflight and bootstrap must warm its independent cache');
  const runId = journal.get<string>('runId')!;
  const operation = { sequence: 1, inputStateId: journal.get<string>('rootId')!, payloadDigest: operationDigest(runId, 1), status: 'planned' as const };
  journal.plan(operation);
  return { state, simulator, config, journal, ledgers, runner, runId, operation };
}

test('simulation: invalidated A token plus IdP503 fails over through real SDK transport with the same operation identity', async t => {
  const f = await fixture(t);
  // Persist a real rejected A execute before renewal, then resume the same journal operation.
  f.simulator.rejectBeforeCommit.add(1);
  await assert.rejects(f.ledgers.A.advance(f.runId, f.operation, () => f.journal.attempt(1, 'A')), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.equal(f.journal.operation(1)?.status, 'unknown');
  f.ledgers.A.transport.tokens.invalidate(); f.state.statusA = 503;
  f.simulator.onCommit = (sequence, endpoint) => { if (sequence === 1 && endpoint === 'B') f.state.statusA = 200; };
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.ok(f.state.requestsA >= 3, 'A must encounter a renewal outage and recover for convergence');
  assert.equal(f.state.requestsB, 1, 'B continues using its independent warm cache');
  const executions = f.simulator.executions.filter(e => e.sequence === 1);
  assert.deepEqual(executions.map(e => e.endpoint), ['A', 'B']);
  assert.ok(executions.every(e => e.input === f.operation.inputStateId), 'retry consumes the original input contract');
  const committed = f.journal.operation(1)!;
  assert.equal(committed.inputStateId, f.operation.inputStateId);
  assert.equal(committed.payloadDigest, f.operation.payloadDigest);
  assert.equal(committed.status, 'committed');
  const snapshot = await f.ledgers.B.snapshot(f.runId);
  assert.equal(snapshot.states.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.receipts[0].operationId, `${f.runId}:1`);
  assert.equal(snapshot.receipts[0].payloadDigest, f.operation.payloadDigest);
  assert.equal(snapshot.receipts[0].inputStateId, f.operation.inputStateId);
  const events = f.journal.db.prepare('SELECT kind,data FROM events ORDER BY id').all() as { kind: string; data: string }[];
  assert.ok(events.some(e => e.kind === 'endpoint_error' && JSON.parse(e.data).kind === 'availability'));
  assert.ok(events.some(e => e.kind === 'failover' && JSON.parse(e.data).from === 'A' && JSON.parse(e.data).to === 'B'));
  assert.ok(events.every(e => !e.data.includes('synthetic-private-provider-details')));
});

test('simulation: genuine IdP credential rejection stops rather than switching participants', async t => {
  const f = await fixture(t);
  f.ledgers.A.transport.tokens.invalidate(); f.state.statusA = 401;
  await assert.rejects(f.runner.run(), (e: unknown) => e instanceof Fault && e.kind === 'auth' && !e.message.includes('private-provider'));
  assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
  assert.equal(f.simulator.executions.filter(e => e.sequence === 1).length, 0);
  assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM events WHERE kind='failover'").get()?.n, 0);
});

test('simulation: IdP429 retries as throttled without counting a participant outage', async t => {
  const f = await fixture(t);
  f.ledgers.A.transport.tokens.invalidate(); f.state.statusA = 429; f.state.onceA = true;
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.deepEqual(f.simulator.executions.filter(e => e.sequence === 1).map(e => e.endpoint), ['A']);
  const errors = f.journal.db.prepare("SELECT data FROM events WHERE kind='endpoint_error'").all() as { data: string }[];
  assert.deepEqual(errors.map(e => JSON.parse(e.data).kind), ['throttled']);
  assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM events WHERE kind='failover'").get()?.n, 0);
});
