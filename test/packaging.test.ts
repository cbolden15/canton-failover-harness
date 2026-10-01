import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { supportedNode } from '../scripts/runtime.mjs';
import { assertPackContents, copyCleanSource, npm } from '../scripts/smoke-utils.mjs';

test('launchers reject unsupported Node before importing the SQLite app', () => {
  assert.equal(supportedNode('24.9.0'), false);
  assert.equal(supportedNode('23.10.0'), false);
  assert.equal(supportedNode('24.10.0'), true);
  assert.equal(supportedNode('26.0.0'), true);
  for (const path of ['../scripts/start.mjs', '../bin/canton-failover.mjs']) {
    const launcher = new URL(path, import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "Object.defineProperty(process.versions, 'node', { value: '24.9.0' }); await import(process.argv[1]);", launcher], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Node.js 24\.10 or newer/);
    assert.doesNotMatch(result.stderr, /SQLite|node:sqlite/);
    assert.equal(result.stdout, '');
  }
});

test('tarball allowlist excludes synthetic private files and development sources', () => {
  const temp = mkdtempSync(join(tmpdir(), 'canton-pack-list-'));
  try {
    copyCleanSource(temp);
    for (const path of ['dist/cli.js', 'dist/assets.js', '.env', 'runs/run.sqlite', 'profiles/example.json', '.codegraph/index.db', 'test/private.key', 'src/private.env', 'scripts/dev.mjs', 'dist/private.key']) {
      mkdirSync(dirname(join(temp, path)), { recursive: true });
      writeFileSync(join(temp, path), '// synthetic packaging fixture\n');
    }
    const [packed] = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--json'], temp));
    assertPackContents(packed.files);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
