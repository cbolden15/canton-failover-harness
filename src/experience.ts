import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Journal } from './journal.js';
import { Config, Fault } from './model.js';
import { report } from './report.js';

export function freshRunDirectory(kind: 'demo' | 'run', parent = resolve('runs')): string {
  const path = join(parent, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function commandLine(args: string[]): string {
  // The command is for the current platform's normal interactive shell.
  const quote = process.platform === 'win32'
    ? (s: string) => `'${s.replaceAll("'", "''")}'`
    : (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return (process.platform === 'win32' ? '& ' : '') + args.map(quote).join(' ');
}

export function listRuns(parent = resolve('runs')): { path: string; runId: string; result: string; configPath?: string }[] {
  if (!existsSync(parent)) return [];
  const runs: { path: string; runId: string; result: string; configPath?: string }[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(parent, entry.name, 'journal.sqlite');
    if (!existsSync(path)) continue;
    let journal: Journal | undefined;
    try {
      journal = new Journal(path, false);
      const runId = journal.get<string>('runId');
      // A demo's ephemeral endpoints and signing key cannot be resumed later.
      if (runId && journal.get('mode') !== 'simulation') runs.push({ path, runId, result: journal.get<string>('result') ?? 'INCONCLUSIVE', configPath: journal.get<string>('configPath') });
    } catch { /* Unrelated or incomplete directories are not selectable runs. */ }
    finally { journal?.close(); }
  }
  return runs;
}

export function progressText(journal: Journal): string {
  const r = report(journal);
  const phase = r.bootstrap === 'confirmed' ? `Active ${r.activeEndpoint}` : `Root ${r.bootstrap ?? 'not initialized'}`;
  const latest = r.events.filter(e => e.kind === 'operation_committed').at(-1);
  const confirmation = latest ? ` | last receipt ${latest.data.sequence} via ${latest.data.endpoint ?? 'ledger'}` : '';
  const scenario = r.scenario;
  const outage = scenario.type === 'failover' ? ` | fresh survivor ${r.acceptance.qualifyingSequences.length}/${scenario.minSurvivorOperations} | ${r.acceptance.reason}` : '';
  return `${phase} | committed ${r.committed}/${r.plannedTotal} | unresolved ${r.unresolved.length} | acceptance ${r.acceptanceResult}${confirmation}${outage}`;
}

/** Presentation only: reads journal state, with explicit operator marker actions. */
export function watchRun(journal: Journal, config: Config, stop: () => void, interactive: boolean): () => void {
  let previous = '';
  const show = () => {
    try {
      const text = progressText(journal);
      if (text !== previous) { process.stdout.write(`${text}\n`); previous = text; }
    } catch { /* Progress rendering must not interrupt ledger recovery. */ }
  };
  show();
  const timer = setInterval(show, 1000);
  let controls: ReturnType<typeof createInterface> | undefined;
  if (interactive) {
    controls = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    if (config.scenario.type === 'failover') {
      console.log(`Wait for root confirmation, then apply the approved fault to ${config.scenario.faultedEndpoint} outside this tool.`);
      console.log('Type s + Enter once the fault is active. Type e + Enter before restoring it. Type status or q to stop safely.');
    } else console.log('Type status for progress, or q to stop safely.');
    controls.on('line', line => {
      const action = line.trim().toLowerCase();
      if (action === 'q') { stop(); return; }
      if (action === 'status') { previous = ''; show(); return; }
      if (!['s', 'e'].includes(action)) return;
      try {
        if (config.scenario.type !== 'failover') throw new Fault('configuration', 'This is a baseline run; outage acceptance is not configured');
        if (!journal.get('rootId')) throw new Fault('configuration', 'Wait for root confirmation before introducing the fault');
        journal.mark(action === 's' ? 'fault-start' : 'fault-end', config.scenario.faultedEndpoint);
        console.log(action === 's' ? 'Fault-start recorded. Keep the endpoint unavailable while the survivor submits fresh operations.' : 'Fault-end recorded. Restore the endpoint now so both participants can converge.');
      } catch (e) { console.error(e instanceof Fault ? e.message : 'Could not record marker; inspect the journal with status'); }
    });
  }
  return () => { clearInterval(timer); controls?.close(); };
}

export function renderResult(value: ReturnType<typeof report>, out?: string, resume?: string): string {
  const lines = [
    `${value.acceptanceResult} (${value.result})`,
    `Committed ${value.committed}/${value.plannedTotal}; unresolved ${value.unresolved.length}; failovers ${value.failovers}.`,
    `Acceptance: ${value.acceptance.reason}.`,
  ];
  if (out) lines.push(`Reports: ${join(out, 'report.json')} and ${join(out, 'operations.csv')}`);
  if (resume && !['PASS', 'SIMULATION_PASS'].includes(value.result)) lines.push(`Resume with the same journal:\n${resume}`);
  return lines.join('\n');
}

export const reportDirectory = (journalPath: string, explicit?: string): string => explicit ? resolve(explicit) : dirname(resolve(journalPath));
