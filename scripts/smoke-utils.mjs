import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const darFile = 'contracts/artifacts/canton-failover-receipts-0.1.0.dar';
export const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.status ?? result.error?.code ?? 'unknown'}).\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

export function npm(args, cwd) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

export function assertPackContents(files) {
  const paths = files.map(file => typeof file === 'string' ? file : file.path);
  for (const required of ['package.json', 'README.md', 'bin/canton-failover.mjs', 'scripts/runtime.mjs', 'scripts/start.mjs', 'dist/cli.js', 'dist/assets.js', 'config.example.json', '.env.example', darFile]) {
    assert(paths.includes(required), `Package is missing ${required}`);
  }
  for (const path of paths) {
    assert(/^(package\.json|\.env\.example|README\.md|bin\/canton-failover\.mjs|scripts\/(runtime|start)\.mjs|dist\/[\w-]+\.(js|d\.ts|js\.map)|docs\/[\w-]+\.md|examples\/auth\/[\w-]+\.json|config\.example\.json|contracts\/README\.md|contracts\/artifacts\/canton-failover-receipts-0\.1\.0\.dar)$/.test(path), `Unexpected packaged file: ${path}`);
    assert(!/(^|\/)(\.env|\.codegraph|runs|profiles)(\/|$)|\.sqlite|\.key$/.test(path), `Private file packaged: ${path}`);
  }
}

export function assertSimulationReport(out) {
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(report.mode, 'simulation');
  assert.equal(report.result, 'SIMULATION_PASS');
  assert.equal(report.acceptanceResult, 'SIMULATION_FAILOVER_PASS');
  assert.equal(report.committed, report.plannedTotal);
}

// Copy source and distributable examples only. Never inspect user profiles or secrets.
export function copyCleanSource(destination) {
  const copy = path => {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(join(root, path), join(destination, path));
  };
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'config.example.json', '.env.example', 'bin/canton-failover.mjs', 'scripts/start.mjs', 'scripts/runtime.mjs', 'contracts/README.md', darFile]) copy(path);
  for (const [directory, extension] of [['src', '.ts'], ['docs', '.md'], ['examples/auth', '.json']]) {
    for (const file of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (file.isFile() && /^[\w-]+\.[\w.]+$/.test(file.name) && file.name.endsWith(extension)) copy(`${directory}/${file.name}`);
    }
  }
}
