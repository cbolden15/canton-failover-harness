import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import type { Ledger } from '../src/ledger.js';
import { Config, EndpointId, Fault, Operation, Receipt, Snapshot, configSchema, operationDigest, sleep } from '../src/model.js';
import { Runner } from '../src/runner.js';

type Options = {
  config?: Partial<Config>;
  lostResponse?: boolean;
  retryResult?: 'conflict' | 'acknowledged';
  convergeA?: boolean;
  recoverAAfterReads?: number;
  alternateStaleReads?: number;
  alternate?: 'current' | 'empty' | 'stale' | 'unavailable' | 'integrity' | 'auth' | 'permission' | 'deadline';
};

function fixture(t: test.TestContext, options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stalled-reconciliation-'));
  const config = configSchema.parse({
    mode: 'simulation', party: 'simulation-party', synchronizerId: 'simulation-sync', packageId: 'a'.repeat(64),
    signingKeyEnv: 'UNUSED_SIMULATION_KEY', signingFingerprint: 'simulation-fingerprint',
    endpoints: {
      A: { url: 'http://localhost/a', participantId: 'participant-A', auth: { type: 'static', tokenEnv: 'UNUSED_SIMULATION_TOKEN' } },
      B: { url: 'http://localhost/b', participantId: 'participant-B', auth: { type: 'static', tokenEnv: 'UNUSED_SIMULATION_TOKEN' } },
    },
    topologyConfirmed: true, count: 2, intervalMs: 0, pollMs: 10, retryAfterMs: 40,
    operationTimeoutMs: 350, runTimeoutMs: 1500, convergenceTimeoutMs: 80,
    ...options.config,
  });
  const runId = randomUUID();
  const journal = new Journal(join(dir, 'journal.sqlite'));
  journal.acquire(); journal.initialize(config, runId);
  journal.set('rootId', 'state-0'); journal.set('bootstrap', 'confirmed');
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const receipts: Receipt[] = [];
  const calls: { endpoint: EndpointId; operation: Operation }[] = [];
  const reads: Record<EndpointId, number> = { A: 0, B: 0 };
  const requests: { endpoint: EndpointId; deadline: number; startedAt: number }[] = [];
  let aCurrent = false;
  const view = (endpoint: EndpointId, prefix = receipts.length): Snapshot => ({
    endpoint, offset: prefix,
    states: [{ contractId: `state-${prefix}`, owner: config.party, runId, nextSequence: prefix + 1, previousReceiptId: prefix ? receipts[prefix - 1].contractId : null }],
    receipts: receipts.slice(0, prefix).map(r => ({ ...r })),
  });
  const makeLedger = (endpoint: EndpointId): Ledger => {
    let deadline = Infinity;
    return {
      endpoint,
      setDeadline(until) { deadline = until; },
      async preflight() {},
      async create() { assert.fail('A pinned run must never create another root'); },
      async snapshot() {
        requests.push({ endpoint, deadline, startedAt: Date.now() });
        reads[endpoint]++;
        if (endpoint === 'A') {
          if (options.recoverAAfterReads && reads.A >= options.recoverAAfterReads) aCurrent = true;
          if (config.count === 1 && options.convergeA !== false && journal.operation(1)?.status === 'committed') aCurrent = true;
          return view(endpoint, aCurrent ? receipts.length : 0);
        }
        if (reads.B <= (options.alternateStaleReads ?? 0)) return view(endpoint, 0);
        switch (options.alternate) {
          case 'empty': return { endpoint, offset: 0, states: [], receipts: [] };
          case 'stale': return view(endpoint, 0);
          case 'unavailable':
            if (journal.operation(1)?.status !== 'committed') throw new Fault('availability', 'Synthetic alternate outage');
            break;
          case 'auth': case 'permission': throw new Fault(options.alternate, 'Synthetic alternate rejection');
          case 'deadline':
            await sleep(Math.max(0, deadline - Date.now()));
            throw new Fault('availability', 'Synthetic alternate request exhausted its deadline');
          case 'integrity': {
            const snapshot = view(endpoint);
            snapshot.receipts[0].payloadDigest = 'incorrect-digest';
            return snapshot;
          }
        }
        return view(endpoint);
      },
      async advance(_runId, op, beforeExecute) {
        beforeExecute(); calls.push({ endpoint, operation: { ...op } });
        if (op.sequence <= receipts.length) {
          if (options.retryResult !== 'acknowledged') throw new Fault('conflict', 'Synthetic consumed input');
          return;
        }
        assert.equal(op.sequence, receipts.length + 1);
        assert.equal(op.inputStateId, `state-${receipts.length}`);
        receipts.push({
          contractId: `receipt-${op.sequence}`, owner: config.party, runId, sequence: op.sequence,
          operationId: `${runId}:${op.sequence}`, payloadDigest: op.payloadDigest, inputStateId: op.inputStateId,
          previousReceiptId: op.sequence === 1 ? null : `receipt-${op.sequence - 1}`,
        });
        if (endpoint === 'B' && options.convergeA !== false) aCurrent = true;
        if (endpoint === 'A' && options.lostResponse !== false) throw new Fault('availability', 'Synthetic response lost after commit');
      },
    };
  };
  const ledgers = { A: makeLedger('A'), B: makeLedger('B') };
  const events = () => (journal.db.prepare('SELECT kind, data FROM events ORDER BY id').all() as { kind: string; data: string }[])
    .map(row => ({ kind: row.kind, data: JSON.parse(row.data) as Record<string, unknown> }));
  return { config, runId, journal, ledgers, runner: new Runner(config, journal, ledgers), receipts, calls, reads, requests, events };
}

test('stalled A recovers its committed lost-response operation from B and keeps B active', async t => {
  const f = fixture(t);
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.equal(f.journal.get('active'), 'B');
  assert.deepEqual(f.calls.map(c => [c.endpoint, c.operation.sequence, c.operation.inputStateId]), [['A', 1, 'state-0'], ['B', 2, 'state-1']]);
  assert.equal(f.journal.operations().length, 2);
  assert.ok(f.journal.operations().every(op => op.status === 'committed'));
  const failovers = f.events().filter(e => e.kind === 'failover');
  assert.equal(failovers.length, 1);
  assert.equal(failovers[0].data.from, 'A'); assert.equal(failovers[0].data.to, 'B');
  assert.equal(typeof failovers[0].data.reason, 'string');
});

test('successful stale reads and acknowledged retries do not postpone alternate reconciliation', async t => {
  const f = fixture(t, { lostResponse: false, retryResult: 'acknowledged', alternateStaleReads: 2 });
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  const retries = f.calls.filter(c => c.endpoint === 'A');
  assert.ok(retries.length >= 3, 'The fixture must exercise repeated acknowledged attempts');
  assert.ok(retries.every(c => c.operation.sequence === 1 && c.operation.inputStateId === 'state-0' && c.operation.payloadDigest === operationDigest(f.runId, 1)));
  assert.deepEqual(f.calls.filter(c => c.endpoint === 'B').map(c => c.operation.sequence), [2]);
});

test('repeated conflicts do not postpone reconciliation of a persisted unknown operation', async t => {
  const f = fixture(t, { alternateStaleReads: 2 });
  const op: Operation = { sequence: 1, inputStateId: 'state-0', payloadDigest: operationDigest(f.runId, 1), status: 'planned' };
  f.journal.plan(op);
  await assert.rejects(f.ledgers.A.advance(f.runId, op, () => f.journal.attempt(1, 'A')), { kind: 'availability' });
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  const retries = f.calls.filter(c => c.endpoint === 'A');
  assert.ok(retries.length >= 3, 'The fixture must exercise repeated conflicts');
  assert.ok(retries.every(c => c.operation.sequence === 1 && c.operation.inputStateId === 'state-0' && c.operation.payloadDigest === operationDigest(f.runId, 1)));
  assert.deepEqual(f.calls.filter(c => c.endpoint === 'B').map(c => c.operation.sequence), [2]);
});

test('B can authorize an unplanned next operation when A lags the committed journal prefix', async t => {
  const f = fixture(t);
  const op: Operation = { sequence: 1, inputStateId: 'state-0', payloadDigest: operationDigest(f.runId, 1), status: 'planned' };
  f.journal.plan(op);
  await assert.rejects(f.ledgers.A.advance(f.runId, op, () => f.journal.attempt(1, 'A')), { kind: 'availability' });
  f.journal.commit(f.receipts[0], 'state-1');
  await f.runner.run();
  assert.deepEqual(f.calls.map(c => [c.endpoint, c.operation.sequence]), [['A', 1], ['B', 2]]);
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
});

for (const alternate of ['empty', 'stale'] as const) {
  test(`${alternate} B evidence cannot authorize a switch or a different logical operation`, async t => {
    const f = fixture(t, { alternate, config: { operationTimeoutMs: 140 } });
    await assert.rejects(f.runner.run(), { kind: 'availability' });
    assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
    assert.equal(f.journal.get('active'), 'A');
    assert.equal(f.journal.operations().length, 1);
    assert.equal(f.journal.operation(1)?.status, 'unknown');
    assert.ok(f.reads.B >= 1, 'The alternate must be probed despite successful stale A reads');
    assert.ok(f.reads.B < f.reads.A, 'Alternate probes must be rate bounded');
    assert.ok(f.calls.every(c => c.endpoint === 'A' && c.operation.sequence === 1 && c.operation.inputStateId === 'state-0' && c.operation.payloadDigest === operationDigest(f.runId, 1)));
    assert.equal(f.events().filter(e => e.kind === 'failover').length, 0);
  });
}

test('recoverable B probe failures are attributed to B without failing over healthy A', async t => {
  const f = fixture(t, { lostResponse: false, retryResult: 'acknowledged', alternate: 'unavailable', recoverAAfterReads: 9, config: { count: 1, failureThreshold: 1 } });
  await f.runner.run();
  assert.equal(f.journal.get('result'), 'SIMULATION_PASS');
  assert.equal(f.journal.get('active'), 'A');
  assert.ok(f.events().some(e => e.kind === 'endpoint_error' && e.data.endpoint === 'B' && e.data.kind === 'availability'));
  assert.equal(f.events().filter(e => e.kind === 'failover').length, 0);
  assert.ok(f.calls.every(c => c.endpoint === 'A'));
});

for (const alternate of ['integrity', 'auth', 'permission'] as const) {
  test(`fatal ${alternate} evidence from B stops reconciliation`, async t => {
    const f = fixture(t, { alternate });
    await assert.rejects(f.runner.run(), { kind: alternate });
    assert.equal(f.journal.get('result'), alternate === 'integrity' ? 'FAIL' : 'INCONCLUSIVE');
    assert.equal(f.journal.operation(1)?.status, 'unknown');
    assert.equal(f.journal.get('active'), 'A');
    assert.ok(f.events().some(e => e.kind === 'endpoint_error' && e.data.endpoint === 'B' && e.data.kind === alternate));
  });
}

test('B recovery still requires A to converge before simulation can pass', async t => {
  const f = fixture(t, { convergeA: false });
  await assert.rejects(f.runner.run(), { kind: 'availability', message: /both participants have not converged/ });
  assert.ok(f.journal.operations().every(op => op.status === 'committed'));
  assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
  assert.deepEqual(f.calls.map(c => [c.endpoint, c.operation.sequence]), [['A', 1], ['B', 2]]);
});

test('a stalled alternate request uses the existing operation deadline and cannot trigger another write', async t => {
  const f = fixture(t, { alternate: 'deadline', config: { operationTimeoutMs: 120, runTimeoutMs: 500 } });
  await assert.rejects(f.runner.run(), { kind: 'availability' });
  const b = f.requests.filter(r => r.endpoint === 'B');
  assert.equal(b.length, 1);
  assert.ok(b[0].startedAt < b[0].deadline);
  assert.ok(b[0].deadline - f.requests[0].startedAt <= f.config.operationTimeoutMs);
  assert.deepEqual(f.calls.map(c => [c.endpoint, c.operation.sequence]), [['A', 1]]);
  assert.equal(f.journal.get('result'), 'INCONCLUSIVE');
});
