import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptance } from './acceptance.js';
import { Scenario } from './model.js';
import { Journal } from './journal.js';

export function report(journal: Journal): ReturnType<typeof reportSnapshot> {
  // Keep marker evidence, metadata, and operation tables at one local snapshot.
  journal.db.exec('BEGIN');
  try { const value = reportSnapshot(journal); journal.db.exec('COMMIT'); return value; }
  catch (e) { journal.db.exec('ROLLBACK'); throw e; }
}
function reportSnapshot(journal: Journal) {
  const operations = journal.operations();
  const events = journal.events();
  const scenario = journal.get<Scenario>('scenario') ?? { type: 'baseline' };
  const evidence = acceptance(journal);
  const result = journal.get<string>('result') ?? 'INCONCLUSIVE';
  const passed = ['PASS', 'SIMULATION_PASS'].includes(result) && evidence.status === 'eligible' && events.some(e => e.kind === 'converged');
  const acceptanceResult = passed ? `${journal.get('mode') === 'simulation' ? 'SIMULATION_' : ''}${scenario.type === 'baseline' ? 'BASELINE_PASS' : 'FAILOVER_PASS'}` : result === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE';
  const attempts = journal.db.prepare('SELECT * FROM attempts ORDER BY startedAt,id').all();
  const commits = events.filter(e => e.kind === 'operation_committed');
  const gaps = commits.slice(1).map((e, i) => Date.parse(e.at) - Date.parse(commits[i].at));
  return {
    result, scenario, acceptanceResult, acceptance: evidence, mode: journal.get('mode'), runId: journal.get('runId'),
    plannedTotal: journal.get('count'), committed: operations.filter(o => o.status === 'committed').length,
    unresolved: operations.filter(o => o.status !== 'committed').map(o => ({ sequence: o.sequence, status: o.status })),
    bootstrap: journal.get('bootstrap'), activeEndpoint: journal.get('active'),
    createdAt: journal.get('createdAt'), completedAt: journal.get('completedAt') ?? null,
    failovers: events.filter(e => e.kind === 'failover').length,
    longestObservedCommitGapMs: gaps.length ? Math.max(...gaps) : null,
    measurement: 'Client confirmation timestamps; commit gaps include configured workload intervals. Outage windows are operator-attested; survivor progress and recovery are client-observed. This is not ledger finality latency or a production RTO guarantee.',
    operations, attempts, events,
  };
}
export function writeReport(journal: Journal, out: string): ReturnType<typeof report> {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const value = report(journal);
  writeFileSync(join(out, 'report.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const csv = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const rows = ['sequence,status,inputStateId,receiptId,successorId', ...value.operations.map(o => [o.sequence, o.status, o.inputStateId, o.receiptId, o.successorId].map(csv).join(','))];
  writeFileSync(join(out, 'operations.csv'), rows.join('\n') + '\n', { mode: 0o600 });
  return value;
}
