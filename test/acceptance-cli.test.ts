import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/journal.js';
import { configSchema } from '../src/model.js';

test('CLI requires matching fault endpoints and exports explicit failover acceptance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  const config = configSchema.parse({
    ...JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')),
    mode: 'simulation',
    scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 1, recoveryTimeoutMs: 1000 },
  });
  const journal = new Journal(path);
  journal.initialize(config, 'cli-acceptance');
  journal.close();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000,
  });
  const missing = run('mark', '--journal', path, '--label', 'fault-start');
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stderr.split('\n').find(line => line.startsWith('{'))!).error, 'configuration');
  const start = run('mark', '--journal', path, '--label', 'fault-start', '--endpoint', 'A');
  assert.equal(start.status, 0, start.stderr);
  const mismatch = run('mark', '--journal', path, '--label', 'fault-end', '--endpoint', 'B');
  assert.equal(mismatch.status, 1, mismatch.stderr);
  const end = run('mark', '--journal', path, '--label', 'fault-end', '--endpoint', 'A');
  assert.equal(end.status, 0, end.stderr);
  const exported = run('report', '--journal', path, '--out', join(dir, 'report'));
  assert.equal(exported.status, 0, exported.stderr);
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.result, 'INCONCLUSIVE');
  assert.equal(summary.acceptanceResult, 'INCONCLUSIVE');
  assert.deepEqual(summary.scenario, config.scenario);
  const report = JSON.parse(readFileSync(join(dir, 'report', 'report.json'), 'utf8'));
  assert.equal(report.acceptance.status, 'failed');
  assert.deepEqual(report.events.filter((e: { kind: string }) => e.kind.startsWith('fault_')).map((e: { kind: string }) => e.kind), ['fault_start', 'fault_end']);
});
