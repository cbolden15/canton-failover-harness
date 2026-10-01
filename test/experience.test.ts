import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulator } from '../src/simulator.js';
import { Journal } from '../src/journal.js';
import { CantonLedger } from '../src/ledger.js';
import { Runner } from '../src/runner.js';
import { commandLine, listRuns } from '../src/experience.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function invoke(args: string[], cwd: string, env = process.env) {
  const child = spawn(process.execPath, ['--import', loader, cli, ...args], { cwd, env, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
function temp(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'canton-experience-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('repeat demos create fresh reports and simulation runs are not offered for resume', { timeout: 15000 }, async t => {
  const dir = temp(t);
  const first = await invoke(['demo', '--json'], dir).done;
  const second = await invoke(['demo', '--json'], dir).done;
  assert.equal(first.code, 0, first.stderr); assert.equal(second.code, 0, second.stderr);
  const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
  assert.notEqual(a.reports, b.reports);
  for (const value of [a, b]) {
    assert.equal(value.acceptanceResult, 'SIMULATION_FAILOVER_PASS');
    assert.ok(existsSync(join(value.reports, 'operations.csv')));
    assert.equal(JSON.parse(readFileSync(join(value.reports, 'report.json'), 'utf8')).acceptanceResult, value.acceptanceResult);
  }
  assert.deepEqual(listRuns(join(dir, 'runs')), []);
  const reused = await invoke(['demo', '--out', a.reports, '--json'], dir).done;
  assert.equal(reused.code, 1); assert.match(reused.stderr, /already contains a journal/);
});

test('start loads only an explicit env file, writes auto reports, and resumes using stored config', { timeout: 15000 }, async t => {
  const dir = temp(t), sim = new Simulator(join(dir, 'simulation.sqlite'));
  t.after(() => sim.close());
  const config = await sim.start({ count: 2 });
  const auth = config.endpoints.A.auth; assert.equal(auth.type, 'static'); if (auth.type !== 'static') return;
  const env = { ...process.env }; delete env[config.signingKeyEnv]; delete env[auth.tokenEnv];
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.env'), `${config.signingKeyEnv}=${process.env[config.signingKeyEnv]}\n${auth.tokenEnv}=${process.env[auth.tokenEnv]}\n`, { mode: 0o600 });
  const missing = await invoke(['doctor', '--config', 'config.json', '--json'], dir, env).done;
  assert.equal(missing.code, 1);
  assert.ok(JSON.parse(missing.stdout).checks.some((c: {id: string; status: string}) => c.id === 'signer' && c.status === 'fail'));
  const started = await invoke(['start', '--config', 'config.json', '--env-file', '.env', '--json'], dir, env).done;
  assert.equal(started.code, 0, started.stderr);
  assert.ok(!started.stdout.includes(process.env[config.signingKeyEnv]!));
  const summary = JSON.parse(started.stdout);
  assert.equal(summary.acceptanceResult, 'SIMULATION_BASELINE_PASS');
  assert.match(summary.resumeCommand, /--env-file/);
  const resumed = await invoke(['resume', '--journal', join(summary.reports, 'journal.sqlite'), '--env-file', '.env', '--json'], dir, env).done;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).committed, 2);
  assert.equal(sim.executions.filter(e => e.sequence === 0).length, 1);
  assert.equal(sim.executions.length, 3);
});

test('SIGINT after an ambiguous execute exports an inconclusive report and resumes the same input', { timeout: 15000 }, async t => {
  const dir = temp(t), sim = new Simulator(join(dir, 'simulation.sqlite'));
  t.after(() => sim.close());
  const config = await sim.start({ count: 2 });
  const configPath = join(dir, 'config.json'), path = join(dir, 'journal.sqlite');
  writeFileSync(configPath, JSON.stringify(config));
  sim.dropAfterCommit.add(1);
  const running = invoke(['start', '--config', configPath, '--journal', path, '--json'], dir);
  t.after(() => { if (running.child.exitCode === null) running.child.kill('SIGKILL'); });
  sim.onCommit = sequence => { if (sequence === 1) running.child.kill('SIGINT'); };
  const stopped = await running.done;
  assert.equal(stopped.code, 2, stopped.stderr);
  const error = JSON.parse(stopped.stderr.split('\n').find(line => line.startsWith('{'))!);
  assert.equal(error.reports, dir); assert.match(error.resumeCommand, /resume/);
  const stored = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(stored.result, 'INCONCLUSIVE');
  assert.ok(stored.unresolved.some((op: { sequence: number; status: string }) => op.sequence === 1 && op.status === 'unknown'));
  assert.equal(sim.executions.filter(e => e.sequence === 2).length, 0);
  const journal = new Journal(path, false); const input = journal.operation(1)?.inputStateId; journal.close();
  sim.onCommit = undefined;
  const resumed = await invoke(['resume', '--journal', path, '--json'], dir).done;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).acceptanceResult, 'SIMULATION_BASELINE_PASS');
  assert.equal(sim.executions.filter(e => e.sequence === 1).length, 1);
  const recovered = new Journal(path, false); assert.equal(recovered.operation(1)?.inputStateId, input); recovered.close();
});

test('stop interrupts a long workload interval without dispatching the next operation', { timeout: 5000 }, async t => {
  const dir = temp(t), sim = new Simulator(join(dir, 'simulation.sqlite'));
  t.after(() => sim.close());
  const config = await sim.start({ count: 2, intervalMs: 60000, runTimeoutMs: 120000 });
  const journal = new Journal(join(dir, 'journal.sqlite')); t.after(() => journal.close());
  journal.initialize(config, 'interrupt-interval');
  const runner = new Runner(config, journal, { A: new CantonLedger('A', config), B: new CantonLedger('B', config) });
  const running = runner.run();
  const until = Date.now() + 2500;
  while (journal.operation(1)?.status !== 'committed' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(journal.operation(1)?.status, 'committed');
  const at = Date.now(); runner.stop();
  await assert.rejects(running, /interrupted/);
  assert.ok(Date.now() - at < 500);
  assert.equal(sim.executions.filter(e => e.sequence === 2).length, 0);
});

test('generated commands preserve shell metacharacters in paths', { skip: process.platform === 'win32' }, () => {
  const value = "path with spaces ' \" $NOT_A_VARIABLE `not-a-command`";
  const command = commandLine([process.execPath, '-e', 'process.stdout.write(process.argv[1])', value]);
  const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, value);
});
