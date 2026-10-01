import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, Fault, operationDigest, Receipt } from '../src/model.js';
import { Simulator } from '../src/simulator.js';
import { CantonLedger } from '../src/ledger.js';
import { Journal } from '../src/journal.js';
import { Runner } from '../src/runner.js';
import { acceptance } from '../src/acceptance.js';
import { report } from '../src/report.js';

const scenario = { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 1, recoveryTimeoutMs: 1000 } as const;
async function fixture(t: test.TestContext, overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'failover-acceptance-'));
  const simulator = new Simulator(join(dir, 'ledger.sqlite'));
  const config = await simulator.start({ count: 3, convergenceTimeoutMs: 100, ...overrides });
  const path = join(dir, 'journal.sqlite');
  const journal = new Journal(path); journal.initialize(config, randomUUID());
  const ledgers = { A: new CantonLedger('A', config), B: new CantonLedger('B', config) };
  t.after(async () => { journal.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, simulator, journal, ledgers, path, runner: new Runner(config, journal, ledgers) };
}

test('a no-fault workload cannot earn configured failover acceptance', async t => {
  const f = await fixture(t, { scenario });
  await assert.rejects(f.runner.run(), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  const r = report(f.journal);
  assert.equal(r.result, 'INCONCLUSIVE');
  assert.equal(r.acceptanceResult, 'INCONCLUSIVE');
  assert.deepEqual(r.scenario, scenario);
  assert.equal(r.committed, 3);
});

test('a closed window followed by restored-only workload fails acceptance', async t => {
  const f = await fixture(t, { scenario });
  await f.runner.bootstrap();
  f.journal.mark('fault-start', 'A');
  f.journal.event('endpoint_error', { endpoint: 'A', kind: 'availability', sequence: 1 });
  f.journal.mark('fault-end', 'A');
  await assert.rejects(f.runner.run(), (e: unknown) => e instanceof Fault && e.kind === 'acceptance');
  assert.equal(report(f.journal).result, 'FAIL');
  assert.equal(report(f.journal).acceptanceResult, 'FAIL');
  assert.equal(report(f.journal).acceptance.qualifyingSequences.length, 0);
});

test('an A submission discovered through B during outage cannot qualify', async t => {
  const f = await fixture(t, { count: 1, scenario, convergenceTimeoutMs: 500 });
  f.simulator.onCommit = sequence => {
    if (sequence === 1) { f.journal.mark('fault-start', 'A'); f.simulator.offline.add('A'); }
  };
  const running = f.runner.run();
  await waitFor(() => f.journal.operation(1)?.status === 'committed');
  const committed = f.journal.events().find(e => e.kind === 'operation_committed');
  assert.equal(committed?.data.endpoint, 'B');
  f.journal.mark('fault-end', 'A'); f.simulator.offline.delete('A');
  await assert.rejects(running, (e: unknown) => e instanceof Fault && e.kind === 'acceptance');
  assert.deepEqual(report(f.journal).acceptance.qualifyingSequences, []);
});

async function waitFor(condition: () => boolean) {
  const until = Date.now() + 1500;
  while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'Expected local simulation progress before deadline');
}

test('fresh survivor progress passes only after window closes and final convergence', async t => {
  const f = await fixture(t, { scenario, convergenceTimeoutMs: 1000 });
  await f.runner.bootstrap();
  f.journal.mark('fault-start', 'A'); f.simulator.offline.add('A');
  const running = f.runner.run();
  await waitFor(() => f.journal.operation(3)?.status === 'committed');
  assert.equal(report(f.journal).acceptanceResult, 'INCONCLUSIVE');
  assert.equal(f.journal.get('completedAt'), undefined);
  assert.equal(acceptance(f.journal).status, 'pending');
  assert.deepEqual(acceptance(f.journal).qualifyingSequences, [1, 2, 3]);
  assert.match(acceptance(f.journal).reason, /record fault-end/);
  assert.equal(f.journal.events().filter(e => e.kind === 'converged').length, 0);
  f.journal.mark('fault-end', 'A');
  // Closing the operator window alone cannot establish participant convergence.
  assert.equal(report(f.journal).acceptanceResult, 'INCONCLUSIVE');
  f.simulator.offline.delete('A');
  await running;
  const r = report(f.journal);
  assert.equal(r.result, 'SIMULATION_PASS');
  assert.equal(r.acceptanceResult, 'SIMULATION_FAILOVER_PASS');
  assert.deepEqual(r.acceptance.qualifyingSequences, [1, 2, 3]);
  assert.ok(r.acceptance.recoveryMs !== null && r.acceptance.recoveryMs <= 1000);
  assert.throws(() => f.journal.mark('recovery'), /Completed runs/);
  const reopened = new Journal(f.path, false);
  try { assert.deepEqual(report(reopened), r); } finally { reopened.close(); }
});

test('an open fault window stays inconclusive through the convergence deadline', async t => {
  const f = await fixture(t, { scenario });
  await f.runner.bootstrap();
  f.journal.mark('fault-start', 'A');
  f.journal.set('completedAt', 'stale-completion');
  await assert.rejects(f.runner.run(), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.equal(report(f.journal).acceptanceResult, 'INCONCLUSIVE');
  assert.equal(report(f.journal).completedAt, null);
});

test('fault markers enforce one matching, ordered endpoint-aware window', async t => {
  const f = await fixture(t, { scenario });
  assert.throws(() => f.journal.mark('fault-start'), /endpoint/);
  assert.throws(() => f.journal.mark('fault-start', 'B'), /endpoint/);
  assert.throws(() => f.journal.mark('fault-end', 'A'), /ordered/);
  assert.equal(f.journal.events().filter(e => e.kind.startsWith('fault_')).length, 0);
  f.journal.mark('fault-start', 'A');
  assert.throws(() => f.journal.mark('fault-start', 'A'), /ordered/);
  assert.throws(() => f.journal.mark('fault-end', 'B'), /endpoint/);
  f.journal.mark('fault-end', 'A');
  assert.throws(() => f.journal.mark('fault-end', 'A'), /ordered/);
});

test('resume cannot change the failover scenario or relax acceptance bounds', async t => {
  const f = await fixture(t, { scenario });
  for (const changed of [
    { type: 'baseline' } as const,
    { ...scenario, faultedEndpoint: 'B' } as const,
    { ...scenario, minSurvivorOperations: 2 },
    { ...scenario, recoveryTimeoutMs: 2000 },
  ]) assert.throws(() => f.journal.assertConfig({ ...f.config, scenario: changed }), /Scenario/);
  f.journal.assertConfig(f.config);
  f.journal.delete('scenario');
  assert.throws(() => f.journal.assertConfig(f.config), /Scenario/);
  f.journal.assertConfig({ ...f.config, scenario: { type: 'baseline' } });
});

function dispatch(journal: Journal, sequence: number, endpoint: 'A' | 'B') {
  const runId = journal.get<string>('runId')!;
  const payloadDigest = operationDigest(runId, sequence);
  if (!journal.operation(sequence)) journal.plan({ sequence, inputStateId: `input-${sequence}`, payloadDigest, status: 'planned' });
  journal.attempt(sequence, endpoint);
}
function confirm(journal: Journal, sequence: number, endpoint: 'A' | 'B') {
  const runId = journal.get<string>('runId')!;
  const receipt: Receipt = { contractId: `receipt-${sequence}`, owner: 'simulation-party::namespace', runId, sequence,
    operationId: `${runId}:${sequence}`, payloadDigest: operationDigest(runId, sequence), inputStateId: `input-${sequence}`, previousReceiptId: null };
  journal.commit(receipt, `successor-${sequence}`, endpoint);
}

test('equal-millisecond events use IDs, excluding pre-window and pre-unavailability dispatches', async t => {
  const f = await fixture(t, { scenario });
  dispatch(f.journal, 1, 'B'); // Pre-window submission discovered through survivor later.
  f.journal.mark('fault-start', 'A');
  dispatch(f.journal, 2, 'B'); // Inside window, but before observed unavailability.
  f.journal.event('endpoint_error', { endpoint: 'A', kind: 'availability' });
  confirm(f.journal, 1, 'B'); confirm(f.journal, 2, 'B');
  dispatch(f.journal, 3, 'B'); confirm(f.journal, 3, 'B');
  f.journal.mark('fault-end', 'A');
  f.journal.db.prepare('UPDATE events SET at=?').run('2026-09-30T00:00:00.000Z');
  assert.deepEqual(acceptance(f.journal).qualifyingSequences, [3]);
  assert.equal(acceptance(f.journal).recoveryMs, 0);
  assert.equal(acceptance(f.journal).status, 'eligible');
  assert.equal(report(f.journal).acceptanceResult, 'INCONCLUSIVE');
});

test('all dispatches must be exclusive to survivor and inside the outage window', async t => {
  const f = await fixture(t, { scenario });
  f.journal.mark('fault-start', 'A');
  f.journal.event('endpoint_error', { endpoint: 'A', kind: 'availability' });
  dispatch(f.journal, 1, 'A'); dispatch(f.journal, 1, 'B'); confirm(f.journal, 1, 'B');
  dispatch(f.journal, 2, 'B'); confirm(f.journal, 2, 'A');
  f.journal.mark('fault-end', 'A');
  assert.deepEqual(acceptance(f.journal).qualifyingSequences, []);
  assert.equal(acceptance(f.journal).status, 'failed');
});

test('late recovery and backward client timestamps cannot pass acceptance', async t => {
  const f = await fixture(t, { scenario });
  f.journal.mark('fault-start', 'A');
  f.journal.event('endpoint_error', { endpoint: 'A', kind: 'availability' });
  dispatch(f.journal, 1, 'B'); confirm(f.journal, 1, 'B');
  f.journal.mark('fault-end', 'A');
  const setTime = (kind: string, ms: number) => f.journal.db.prepare('UPDATE events SET at=? WHERE kind=?').run(new Date(ms).toISOString(), kind);
  setTime('fault_start', 0); setTime('endpoint_error', 100); setTime('dispatching', 101); setTime('operation_committed', 1001); setTime('fault_end', 2000);
  assert.equal(acceptance(f.journal).status, 'failed');
  assert.match(acceptance(f.journal).reason, /exceeded/);
  setTime('operation_committed', 99);
  assert.equal(acceptance(f.journal).status, 'failed');
  assert.deepEqual(acceptance(f.journal).qualifyingSequences, []);
  setTime('fault_start', 3000);
  assert.equal(acceptance(f.journal).status, 'pending');
});

test('malformed persisted markers are inconclusive rather than integrity failures', async t => {
  const f = await fixture(t, { scenario });
  f.journal.event('fault_start', { endpoint: 'A' });
  f.journal.event('fault_end', { endpoint: 'B' });
  assert.equal(acceptance(f.journal).status, 'pending');
  await assert.rejects(f.runner.run(), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.equal(report(f.journal).result, 'INCONCLUSIVE');
});

test('baseline configurations and legacy journals retain explicit baseline acceptance', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.config.scenario, { type: 'baseline' });
  f.journal.delete('scenario');
  f.journal.mark('fault-start'); f.journal.mark('fault-end');
  await f.runner.run();
  assert.equal(report(f.journal).acceptanceResult, 'SIMULATION_BASELINE_PASS');
  assert.deepEqual(report(f.journal).scenario, { type: 'baseline' });
});

test('closed insufficient outage evidence fails even if final convergence remains unavailable', async t => {
  const f = await fixture(t, { scenario });
  await f.runner.bootstrap();
  f.journal.mark('fault-start', 'A');
  f.journal.event('endpoint_error', { endpoint: 'A', kind: 'availability' });
  f.journal.mark('fault-end', 'A'); f.simulator.offline.add('A');
  await assert.rejects(f.runner.run('B'), (e: unknown) => e instanceof Fault && e.kind === 'acceptance');
  assert.equal(report(f.journal).result, 'FAIL');
  assert.equal(f.journal.events().some(e => e.kind === 'converged'), false);
});
