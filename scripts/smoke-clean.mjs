import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSimulationReport, copyCleanSource, npm } from './smoke-utils.mjs';
import { requireSupportedNode } from './runtime.mjs';

requireSupportedNode();
const temp = mkdtempSync(join(tmpdir(), 'canton-clean-'));
try {
  const project = join(temp, 'source');
  copyCleanSource(project);
  assert(!existsSync(join(project, 'dist')));
  assert(!existsSync(join(project, 'node_modules')));
  npm(['ci', '--no-audit', '--no-fund'], project);
  const out = join(temp, 'demo');
  npm(['start', '--', 'demo', '--json', '--out', out], project);
  assertSimulationReport(out);
  console.log('Clean install/start smoke passed: persisted SIMULATION_FAILOVER_PASS (simulation).');
} finally { rmSync(temp, { recursive: true, force: true }); }
