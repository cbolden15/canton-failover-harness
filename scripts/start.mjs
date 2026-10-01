import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireSupportedNode } from './runtime.mjs';

requireSupportedNode();
const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../src/cli.ts', import.meta.url))) {
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  if (!existsSync(compiler)) {
    console.error('Install project dependencies with npm ci, then retry npm start.');
    process.exit(1);
  }
  const build = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  if (build.error || build.status !== 0) process.exit(build.status ?? 1);
}
if (!existsSync(new URL('../dist/cli.js', import.meta.url))) {
  console.error('Compiled CLI is missing. Run npm run build or reinstall the release package.');
  process.exit(1);
}
const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/canton-failover.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(child.status ?? 1);
