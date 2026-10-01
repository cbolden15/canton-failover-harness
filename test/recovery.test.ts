import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, Fault, operationDigest, validateSnapshot } from '../src/model.js';
import { Simulator } from '../src/simulator.js';
import { CantonLedger } from '../src/ledger.js';
import { Journal } from '../src/journal.js';
import { Runner } from '../src/runner.js';
import { report } from '../src/report.js';

async function fixture(t: test.TestContext, overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'failover-test-'));
  const simulator = new Simulator(join(dir, 'ledger.sqlite'));
  const config = await simulator.start(overrides);
  const path = join(dir, 'journal.sqlite');
  let journal = new Journal(path); journal.acquire(); journal.initialize(config, randomUUID());
  const ledgers = { A: new CantonLedger('A', config), B: new CantonLedger('B', config) };
  t.after(async () => { journal.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, simulator, ledgers, path, get journal() { return journal; }, get runner() { return new Runner(config, journal, ledgers); }, reopen() { journal.close(); journal = new Journal(path); journal.acquire(); } };
}

test('real SDK prepare/sign path, paginated receipts, lost response, and automatic switching', async t => {
  const f = await fixture(t, { count: 8, failureThreshold: 2 });
  f.simulator.pageSize = 2; f.simulator.dropAfterCommit.add(2);
  let timer: ReturnType<typeof setTimeout>;
  f.simulator.onCommit = sequence => {
    if (sequence === 3) { f.simulator.offline.add('A'); timer = setTimeout(() => f.simulator.offline.delete('A'), 150); }
  };
  t.after(() => clearTimeout(timer));
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.equal(f.journal.operations().length, 8);
  assert.equal(report(f.journal).failovers, 1);
  assert.ok(f.simulator.executions.some(e => e.endpoint === 'B'));
  assert.equal(f.simulator.executions.filter(e => e.sequence === 2).length, 1);
  assert.ok(f.simulator.executions.every(e => e.hashVersion === 'HASHING_SCHEME_VERSION_V3' && e.fingerprint === f.config.signingFingerprint));
});

test('restart after commit but before journal confirmation reconciles without re-execution', async t => {
  const f = await fixture(t, { count: 3 }); await f.runner.bootstrap();
  const runId = f.journal.get<string>('runId')!;
  const op = { sequence: 1, inputStateId: f.journal.get<string>('rootId')!, payloadDigest: operationDigest(runId, 1), status: 'planned' as const };
  f.journal.plan(op);
  await f.ledgers.A.advance(runId, op, () => f.journal.attempt(1, 'A'));
  assert.equal(f.journal.operation(1)?.status, 'unknown');
  f.reopen(); await f.runner.run('B');
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.equal(f.simulator.executions.filter(e => e.sequence === 1).length, 1);
});

test('restart before execution retries the same persisted input, not a new operation', async t => {
  const f = await fixture(t, { count: 2 }); await f.runner.bootstrap();
  const runId = f.journal.get<string>('runId')!;
  const op = { sequence: 1, inputStateId: f.journal.get<string>('rootId')!, payloadDigest: operationDigest(runId, 1), status: 'planned' as const };
  f.journal.plan(op); f.journal.attempt(1, 'A'); f.reopen();
  await f.runner.run('B');
  assert.equal(f.journal.operation(1)?.inputStateId, op.inputStateId);
  assert.equal(f.simulator.executions.find(e => e.sequence === 1)?.endpoint, 'B');
  assert.equal(f.journal.operation(1)?.status, 'committed');
});

test('two participant submissions consuming one input yield exactly one receipt', async t => {
  const f = await fixture(t, { count: 1 }); await f.runner.bootstrap();
  const runId = f.journal.get<string>('runId')!;
  const op = { sequence: 1, inputStateId: f.journal.get<string>('rootId')!, payloadDigest: operationDigest(runId, 1), status: 'planned' as const };
  f.journal.plan(op);
  const outcomes = await Promise.allSettled([f.ledgers.A.advance(runId, op, randomUUID), f.ledgers.B.advance(runId, op, randomUUID)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const receipts = (await f.ledgers.B.snapshot(runId)).receipts;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].inputStateId, op.inputStateId);
});

test('unknown root creation is never replayed on resume', async t => {
  const f = await fixture(t, { operationTimeoutMs: 150 });
  f.journal.set('bootstrap', 'unknown'); f.journal.set('bootstrapEndpoint', 'A'); f.journal.attempt(0, 'A');
  await assert.rejects(f.runner.bootstrap(), /Root outcome unresolved/);
  f.reopen(); await assert.rejects(f.runner.bootstrap(), /Root outcome unresolved/);
  assert.equal(f.simulator.executions.length, 0);
});

test('lost root response is resolved through matching participant snapshots', async t => {
  const f = await fixture(t); f.simulator.dropAfterCommit.add(0);
  await f.runner.bootstrap(); assert.equal(f.journal.get('bootstrap'), 'confirmed');
  assert.equal(f.simulator.executions.length, 1);
});

test('both participants unavailable stops within deadline and never reports success', async t => {
  const f = await fixture(t, { operationTimeoutMs: 150, runTimeoutMs: 400 }); await f.runner.bootstrap();
  f.simulator.offline.add('A'); f.simulator.offline.add('B');
  const start = Date.now(); await assert.rejects(f.runner.run(), /unresolved/);
  assert.ok(Date.now() - start < 1500); assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
});

test('final convergence requires both participants; completed work alone does not pass', async t => {
  const f = await fixture(t, { count: 1, convergenceTimeoutMs: 100 });
  f.simulator.onCommit = sequence => { if (sequence === 1) f.simulator.offline.add('B'); };
  await assert.rejects(f.runner.run(), /not converged/);
  assert.equal(f.journal.operation(1)?.status, 'committed'); assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
  f.simulator.offline.delete('B'); await f.runner.run(); assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
});

test('different identity, duplicate runner, and unconfirmed topology are rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => f.journal.assertConfig({ ...f.config, party: 'another-party' }), /differs/);
  const second = new Journal(f.path); try { assert.throws(() => second.acquire(), /Another runner/); } finally { second.close(); }
  await assert.rejects(new Runner({ ...f.config, topologyConfirmed: false }, f.journal, f.ledgers).bootstrap(), /Confirm multi-hosting/);
});

test('receipt tampering is a failed integrity check', async t => {
  const f = await fixture(t, { count: 1 }); await f.runner.run();
  const snapshot = await f.ledgers.A.snapshot(f.journal.get<string>('runId')!);
  snapshot.receipts[0].payloadDigest = 'tampered';
  assert.throws(() => validateSnapshot(snapshot, f.journal.get<string>('runId')!, f.config.party, f.journal.get<string>('rootId'), 1), (e: unknown) => e instanceof Fault && e.kind === 'integrity');
});
