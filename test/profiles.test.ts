import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, Config } from '../src/model.js';
import { listProfiles, resolveProfile, saveProfile } from '../src/profiles.js';

const config = configSchema.parse({ mode: 'testnet', party: 'synthetic-party', synchronizerId: 'synthetic-sync', packageId: 'a'.repeat(64),
  signingKeyEnv: 'SYNTHETIC_SIGNING_KEY', signingFingerprint: 'synthetic-fingerprint', endpoints: {
    A: { url: 'https://a.example.invalid', participantId: 'participant-A', auth: { type: 'static', tokenEnv: 'SYNTHETIC_A_TOKEN' } },
    B: { url: 'https://b.example.invalid', participantId: 'participant-B', auth: { type: 'static', tokenEnv: 'SYNTHETIC_B_TOKEN' } },
  } });
function directory(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'canton-profiles-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
test('profiles persist validated config with private permissions and never overwrite', t => {
  const dir = directory(t);
  const profile = saveProfile('healthy', config, dir);
  assert.equal(profile.path, join(dir, 'healthy.json'));
  assert.equal(statSync(profile.path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(profile.path, 'utf8')), config);
  assert.deepEqual(listProfiles(dir), [profile]);
  assert.equal(resolveProfile('healthy', dir), profile.path);
  assert.throws(() => saveProfile('healthy', config, dir), /exists/);
  assert.deepEqual(JSON.parse(readFileSync(profile.path, 'utf8')), config);
});
test('profile APIs reject traversal and invalid config without writing files', t => {
  const dir = directory(t);
  for (const name of ['../escape', '/escape', 'x/y', '.', 'x.json', '', 'has space']) {
    assert.throws(() => saveProfile(name, config, dir), /name/);
    assert.throws(() => resolveProfile(name, dir), /name/);
  }
  assert.throws(() => saveProfile('invalid', { ...config, secret: 'must-not-persist' } as Config, dir), /configuration/);
  assert.deepEqual(listProfiles(dir), []);
  assert.throws(() => resolveProfile('missing', dir), /not found/);
});
test('profile resolution and listing ignore symlink files', t => {
  const dir = directory(t); const targetDir = directory(t);
  const target = saveProfile('target', config, targetDir);
  symlinkSync(target.path, join(dir, 'linked.json'));
  assert.deepEqual(listProfiles(dir), []);
  assert.throws(() => resolveProfile('linked', dir), /not found/);
});
