#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EndpointId, Fault, faultKind } from './model.js';
import { Journal } from './journal.js';
import { CantonLedger } from './ledger.js';
import { Runner } from './runner.js';
import { writeReport, report } from './report.js';
import { Simulator } from './simulator.js';
import { doctor, formatDoctor, loadConfigChecked } from './doctor.js';
import { listProfiles, resolveProfile } from './profiles.js';
import { runSetup } from './setup.js';
import { commandLine, freshRunDirectory, listRuns, progressText, renderResult, reportDirectory, watchRun } from './experience.js';

const help = `Canton failover test harness (Node.js 24.10+)

  No command: guided menu in a terminal; help when piped.
  demo      [--out DIRECTORY] [--json]
  setup     [--env-file FILE]
  doctor    --profile NAME | --config CONFIG [--env-file FILE] [--json]
  start     --profile NAME | --config CONFIG [--journal JOURNAL] [--json]
  init      --config CONFIG --journal JOURNAL [--run-id ID]
  run       --config CONFIG --journal JOURNAL [--primary A|B]
  resume    --journal JOURNAL [--config CONFIG] [--primary A|B]
  status    --journal JOURNAL [--json]
  report    --journal JOURNAL [--out DIRECTORY] [--json]
  mark      --journal JOURNAL --label fault-start|fault-end|recovery [--endpoint A|B]

All config commands accept --profile NAME instead of --config and explicit --env-file FILE.
Use --human for readable piped output; --json for automation. No .env is loaded implicitly.
start checks readiness, creates one root, and runs the workload. Live start/init/run/resume write to the ledger.
An unknown init is never automatically resubmitted. Keep its journal and resume.
Reports are exported automatically after run completion, failure, or graceful interruption.
demo uses a local simulation; it makes no Canton network calls.
`;
let jsonOutput = process.argv.includes('--json') || (!process.stdout.isTTY && !process.argv.includes('--human'));
let failureContext: Record<string, unknown> = {};
const emit = (value: unknown, human: string) => console.log(jsonOutput ? JSON.stringify(value, null, 2) : human);
const executable = resolve(fileURLToPath(import.meta.url));
const invocation = executable.endsWith('.ts') ? [process.execPath, '--import', import.meta.resolve('tsx'), executable] : [process.execPath, executable];
function resumeCommand(configPath: string, journalPath: string, envFile?: string): string {
  return commandLine([...invocation, 'resume', '--config', configPath, '--journal', journalPath, ...(envFile ? ['--env-file', envFile] : [])]);
}

async function choose(title: string, options: string[]): Promise<number | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  try {
    console.log(`\n${title}`);
    options.forEach((label, i) => console.log(`${i + 1}. ${label}`));
    while (true) {
      const answer = (await rl.question('Choose a number (Enter to cancel): ')).trim();
      if (!answer) return undefined;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      console.log('Choose one of the listed numbers.');
    }
  } catch (e) { if (closed) return undefined; throw e; }
  finally { rl.close(); }
}
async function profileChoice(): Promise<string | undefined> {
  const profiles = listProfiles();
  if (!profiles.length) { console.log('No profiles yet. Choose Configure participants or run canton-failover setup.'); return undefined; }
  const selected = await choose('Choose a saved profile', profiles.map(p => p.name));
  return selected === undefined ? undefined : profiles[selected].path;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, profile: { type: 'string' }, journal: { type: 'string' }, out: { type: 'string' },
    primary: { type: 'string' }, 'run-id': { type: 'string' }, label: { type: 'string' }, endpoint: { type: 'string' },
    'env-file': { type: 'string' }, json: { type: 'boolean' }, human: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.json && values.human) throw new Fault('configuration', 'Choose either --json or --human');
  jsonOutput = values.json || (!process.stdout.isTTY && !values.human);
  if (values.version) { console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  if (values.help) { console.log(help); return; }
  const envFile = values['env-file'] ? resolve(values['env-file']) : undefined;
  if (envFile) {
    try { loadEnvFile(envFile); }
    catch { throw new Fault('configuration', `Could not load environment file ${envFile}; check that it exists and is readable`); }
  }
  if (values.config && values.profile) throw new Fault('configuration', 'Choose either --config or --profile');
  let configPath = values.config ? resolve(values.config) : values.profile ? resolveProfile(values.profile) : undefined;
  let journalPath = values.journal ? resolve(values.journal) : undefined;
  let command = positionals[0];
  let guided = false;
  if (!command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || values.json) { console.log(help); return; }
    guided = true; jsonOutput = false;
    const selected = await choose('Canton failover', ['Try the local demo', 'Configure participants', 'Check a profile (doctor)', 'Start a new run', 'Resume a run']);
    if (selected === undefined) return;
    command = ['demo', 'setup', 'doctor', 'start', 'resume'][selected];
    if (command === 'doctor' || command === 'start') { configPath = configPath ?? await profileChoice(); if (!configPath) return; }
    if (command === 'resume') {
      const runs = listRuns();
      if (!runs.length) { console.log('No resumable live runs in ./runs. Use resume --journal PATH --config CONFIG for a run stored elsewhere.'); return; }
      const selectedRun = await choose('Choose the journal to resume', runs.map(r => `${r.runId} — ${r.result}`));
      if (selectedRun === undefined) return;
      journalPath = runs[selectedRun].path;
      configPath = configPath ?? runs[selectedRun].configPath ?? await profileChoice();
      if (!configPath) return;
    }
  }
  if (positionals.length > 1 || !['demo', 'setup', 'doctor', 'preflight', 'start', 'init', 'run', 'resume', 'report', 'mark', 'status'].includes(command)) throw new Fault('configuration', 'Unknown command; use --help');
  if (values.endpoint && !['A', 'B'].includes(values.endpoint)) throw new Fault('configuration', '--endpoint must be A or B');
  if (values.primary && !['A', 'B'].includes(values.primary)) throw new Fault('configuration', '--primary must be A or B');
  if (values['run-id'] && !/^[A-Za-z0-9_-]{1,100}$/.test(values['run-id'])) throw new Fault('configuration', 'Run ID must be 1–100 letters, digits, underscores, or hyphens');
  if (command === 'setup') {
    if (!process.stdin.isTTY || jsonOutput) throw new Fault('configuration', 'Setup needs an interactive terminal; edit config.example.json for noninteractive setup');
    const profile = await runSetup();
    if (profile) console.log(`Profile saved: ${profile.path}\nNext: ${commandLine([...invocation, 'doctor', '--profile', profile.name, ...(envFile ? ['--env-file', envFile] : [])])}`);
    return;
  }
  if (command === 'demo') {
    const out = values.out ? resolve(values.out) : freshRunDirectory('demo');
    if (existsSync(join(out, 'journal.sqlite')) || existsSync(join(out, 'simulation.sqlite'))) throw new Fault('configuration', 'Demo directory already contains a journal; omit --out for a fresh directory');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const simulator = new Simulator(join(out, 'simulation.sqlite'));
    const journal = new Journal(join(out, 'journal.sqlite'));
    let restore: ReturnType<typeof setTimeout> | undefined;
    let finishWatch = () => {};
    let runner: Runner | undefined;
    const interrupt = () => { runner?.stop(); if (!jsonOutput) console.log('Stopping after the current bounded request; preserving the journal.'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      journal.acquire();
      const config = await simulator.start({ count: 8, scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
      simulator.dropAfterCommit.add(2);
      simulator.onCommit = sequence => {
        if (sequence === 2) { simulator.offline.add('A'); journal.mark('fault-start', 'A', true); }
        if (sequence === config.count) restore = setTimeout(() => { journal.mark('fault-end', 'A', true); simulator.offline.delete('A'); }, 50);
      };
      journal.initialize(config, randomUUID());
      runner = new Runner(config, journal, { A: new CantonLedger('A', config), B: new CantonLedger('B', config) });
      if (!jsonOutput) { console.log(`SIMULATION — local demo. Output: ${out}`); finishWatch = watchRun(journal, config, interrupt, false); }
      try { await runner.run(); }
      catch (e) {
        journal.set('result', ['integrity', 'acceptance'].includes(faultKind(e)) ? 'FAIL' : 'INCONCLUSIVE');
        failureContext = { note: 'Simulation endpoints are temporary; start a fresh demo to try again.' };
        try { writeReport(journal, out); failureContext.reports = out; }
        catch { failureContext.reportError = 'Report export failed; the journal is preserved. Use report --journal to retry.'; }
        throw e;
      } finally { finishWatch(); }
      const result = writeReport(journal, out);
      emit({ result: result.result, scenario: result.scenario, acceptanceResult: result.acceptanceResult, committed: result.committed, failovers: result.failovers, reports: out }, renderResult(result, out));
    } finally {
      finishWatch(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (restore) clearTimeout(restore); await simulator.close(); journal.close();
    }
    return;
  }
  if (['report', 'mark', 'status'].includes(command)) {
    if (!journalPath) throw new Fault('configuration', '--journal is required');
    if (!existsSync(journalPath)) throw new Fault('configuration', 'Journal does not exist; use start for a new run');
    const journal = new Journal(journalPath, command === 'mark');
    try {
      if (!journal.get('runId')) throw new Fault('configuration', 'Journal is not initialized');
      if (command === 'mark') {
        const label = values.label;
        if (!label || !['fault-start', 'fault-end', 'recovery'].includes(label)) throw new Fault('configuration', '--label must be fault-start, fault-end, or recovery');
        journal.mark(label as 'fault-start' | 'fault-end' | 'recovery', values.endpoint as EndpointId | undefined);
        emit({ recorded: label, endpoint: values.endpoint }, `Recorded ${label}${label === 'fault-end' ? '. Restore the endpoint now for convergence.' : '.'}`);
      } else if (command === 'status') { const value = report(journal); emit(value, `${progressText(journal)}\n${value.acceptance.reason}`); }
      else {
        const out = reportDirectory(journalPath, values.out); const value = writeReport(journal, out);
        emit({ result: value.result, scenario: value.scenario, acceptanceResult: value.acceptanceResult, committed: value.committed, plannedTotal: value.plannedTotal, unresolved: value.unresolved, reports: out }, renderResult(value, out));
      }
    } finally { journal.close(); }
    return;
  }
  if (!configPath && command === 'resume' && journalPath && existsSync(journalPath)) {
    const saved = new Journal(journalPath, false);
    try { configPath = saved.get<string>('configPath'); } finally { saved.close(); }
  }
  if (!configPath) throw new Fault('configuration', '--config or --profile is required; run setup to save a profile');
  if (command === 'doctor' || command === 'preflight') {
    const result = await doctor(configPath); emit(result, formatDoctor(result)); process.exitCode = result.ready ? 0 : 1; return;
  }
  const config = loadConfigChecked(configPath);
  if (command === 'start') {
    const readiness = await doctor(configPath);
    if (!jsonOutput) console.log(formatDoctor(readiness));
    if (!readiness.ready) { failureContext = { doctor: readiness }; throw new Fault('configuration', 'Readiness checks failed; fix the listed prerequisites before starting'); }
    if (guided) {
      const answer = await choose('Start the configured workload? This creates a ledger root and submits signed transactions.', ['Start the run', 'Cancel']);
      if (answer !== 0) return;
    }
    journalPath = journalPath ?? join(freshRunDirectory('run'), 'journal.sqlite');
  }
  if (!journalPath) throw new Fault('configuration', '--journal is required; use start to create a new run directory');
  if (['run', 'resume'].includes(command) && !existsSync(journalPath)) throw new Fault('configuration', 'Journal does not exist; use start for a new run');
  const out = reportDirectory(journalPath, values.out);
  const resume = resumeCommand(configPath, journalPath, envFile);
  const journal = new Journal(journalPath);
  let acquired = false; let workStarted = false; let finishWatch = () => {}; let runner: Runner | undefined;
  const interrupt = () => { runner?.stop(); if (!jsonOutput) console.log('Stopping after the current bounded request; preserving the journal.'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    journal.acquire(); acquired = true;
    if (command === 'init' || command === 'start') journal.initialize(config, values['run-id'] ?? randomUUID());
    journal.assertConfig(config); workStarted = true; journal.set('configPath', configPath);
    runner = new Runner(config, journal, { A: new CantonLedger('A', config), B: new CantonLedger('B', config) });
    if (!jsonOutput) { console.log(`Journal: ${journalPath}`); finishWatch = watchRun(journal, config, interrupt, Boolean(process.stdin.isTTY && process.stdout.isTTY && command !== 'init')); }
    if (command === 'init') await runner.bootstrap(); else await runner.run(values.primary as EndpointId | undefined);
    finishWatch();
    const value = writeReport(journal, out);
    emit({ result: value.result, scenario: value.scenario, acceptanceResult: value.acceptanceResult, bootstrap: value.bootstrap, committed: value.committed, failovers: value.failovers, reports: out, resumeCommand: resume }, command === 'init' ? `Root confirmed.\nContinue with:\n${resume}\nReports: ${out}` : renderResult(value, out, resume));
  } catch (e) {
    finishWatch();
    if (acquired && workStarted && journal.get('runId')) {
      journal.set('result', ['integrity', 'acceptance'].includes(faultKind(e)) ? 'FAIL' : 'INCONCLUSIVE'); journal.event('command_error', { kind: faultKind(e) });
      failureContext = { resumeCommand: resume };
      try { writeReport(journal, out); failureContext.reports = out; }
      catch { failureContext.reportError = 'Report export failed; the journal is preserved. Use report --journal to retry.'; }
    }
    throw e;
  } finally { finishWatch(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); journal.close(); }
}

main().catch(e => {
  const kind = faultKind(e);
  const message = e instanceof Fault ? e.message : 'Invalid input or unsupported response; use doctor to check prerequisites';
  if (jsonOutput) console.error(JSON.stringify({ error: kind, message, ...failureContext }));
  else {
    console.error(`${kind}: ${message}`);
    if (failureContext.reports) console.error(`Reports: ${failureContext.reports}`);
    if (failureContext.resumeCommand) console.error(`Resume with the same journal:\n${failureContext.resumeCommand}`);
    if (failureContext.reportError) console.error(failureContext.reportError);
    if (failureContext.note) console.error(failureContext.note);
  }
  process.exitCode = kind === 'integrity' ? 3 : kind === 'availability' ? 2 : 1;
});
