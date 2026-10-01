import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPackContents, assertSimulationReport, npm, packageMetadata, root, run } from './smoke-utils.mjs';
import { requireSupportedNode } from './runtime.mjs';

requireSupportedNode();
const temp = mkdtempSync(join(tmpdir(), 'canton-release-'));
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], root));
  assertPackContents(packed.files);
  const prefix = join(temp, 'installed');
  mkdirSync(prefix);
  writeFileSync(join(prefix, 'package.json'), '{"private":true}\n');
  npm(['install', '--omit=dev', '--no-audit', '--no-fund', join(temp, packed.filename)], prefix);
  const installed = join(prefix, 'node_modules', packageMetadata.name);
  assert(!existsSync(join(installed, 'src')));
  assert(!existsSync(join(prefix, 'node_modules', 'typescript')));
  const outside = join(temp, 'outside-source');
  mkdirSync(outside);
  const executable = join(prefix, 'node_modules', '.bin', 'canton-failover');
  assert.match(run(executable, ['--help'], outside), /Canton failover/);
  assert.equal(run(executable, ['--version'], outside).trim(), packageMetadata.version);
  const assets = pathToFileURL(join(installed, 'dist', 'assets.js')).href;
  run(process.execPath, ['--input-type=module', '-e', 'const assets = await import(process.argv[1]); if (!assets.bundledDarVerified()) process.exit(1);', assets], outside);
  const out = join(outside, 'demo');
  run(executable, ['demo', '--json', '--out', out], outside);
  assertSimulationReport(out);
  npm(['start', '--', '--version'], installed);
  console.log('Packed install smoke passed: installed bin, help/version, bundled DAR, and SIMULATION_FAILOVER_PASS (simulation).');
} finally { rmSync(temp, { recursive: true, force: true }); }
