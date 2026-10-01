import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Simulator } from '../src/simulator.js';
import { Journal } from '../src/journal.js';
import { CantonLedger } from '../src/ledger.js';
import { Runner } from '../src/runner.js';

test('SIGKILL after ledger commit releases runner lock and preserves unknown intent for recovery', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'failover-process-'));
  const sim = new Simulator(join(dir, 'ledger.sqlite'));
  let journal: Journal | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const config = await sim.start({ count: 2, operationTimeoutMs: 5000 });
    const path = join(dir, 'journal.sqlite');
    const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const ledgers = { A: new CantonLedger('A', config), B: new CantonLedger('B', config) };
    journal = new Journal(path); journal.acquire(); journal.initialize(config, randomUUID());
    await new Runner(config, journal, ledgers).bootstrap(); journal.close(); journal = undefined;
    sim.onCommit = sequence => { if (sequence === 1) child!.kill('SIGKILL'); };
    const root = fileURLToPath(new URL('..', import.meta.url));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', '--config', configPath, '--journal', path], { cwd: root, env: process.env, stdio: 'pipe' });
    let output = ''; child.stdout?.on('data', b => { output += b; }); child.stderr?.on('data', b => { output += b; });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child!.once('error', reject); child!.once('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(exit.signal, 'SIGKILL', output);
    sim.onCommit = undefined;
    journal = new Journal(path); journal.acquire(); assert.equal(journal.operation(1)?.status, 'unknown');
    await new Runner(config, journal, ledgers).run('B');
    assert.equal(journal.get('result'), 'SIMULATION_PASS');
    assert.equal(sim.executions.filter(e => e.sequence === 1).length, 1);
  } finally { child?.kill('SIGKILL'); journal?.close(); await sim.close(); rmSync(dir, { recursive: true, force: true }); }
});
