import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import { configSchema, type Config } from '../src/model.js';
import { browserRuns, browserProfiles, prepareBrowserRun } from '../src/ui-live.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'canton-detection-'));
  const runs = join(dir, 'runs'), profiles = join(dir, 'profiles');
  mkdirSync(runs); mkdirSync(profiles);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = configSchema.parse({ mode: 'testnet', party: 'previous-party', synchronizerId: 'previous-sync',
    packageId: 'a'.repeat(64), signingKeyEnv: 'PRIOR_TEST_KEY', signingFingerprint: 'previous-fingerprint', topologyConfirmed: true,
    count: 3, scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 1, recoveryTimeoutMs: 1000 },
    endpoints: { A: { url: 'http://127.0.0.1:10001', participantId: 'previous-A', auth: { type: 'static', tokenEnv: 'PRIOR_TEST_TOKEN_A' } },
      B: { url: 'http://127.0.0.1:10002', participantId: 'previous-B', auth: { type: 'static', tokenEnv: 'PRIOR_TEST_TOKEN_B' } } } });
  const journal = (name: string, c: Config = config) => { const path = join(runs, name, 'journal.sqlite'); const j = new Journal(path); j.initialize(c, name); return j; };
  return { dir, runs, profiles, config, journal };
}

test('detect CLI run from its journal snapshot after the original config moves; ignore simulations', t => {
  const f = fixture(t);
  const previous = f.journal('previous-cli'); previous.set('configPath', join(f.dir, 'missing-config.json')); previous.close();
  const simulation = f.journal('simulation', { ...f.config, mode: 'simulation' }); simulation.close();
  const found = browserRuns(f.runs, f.profiles);
  assert.equal(found.length, 1); assert.equal(found[0].source, 'CLI'); assert.equal(found[0].canResume, true);
  assert.equal(found[0].config.party, 'previous-party'); assert.equal(found[0].config.endpoints.A.url, f.config.endpoints.A.url);
  const before = new Journal(found[0].journalPath, false); assert.equal(before.get('bootstrap'), 'planned'); before.close();
});

test('legacy config paths must match journal identity, count and scenario', t => {
  const f = fixture(t), path = join(f.dir, 'legacy.json');
  writeFileSync(path, JSON.stringify(f.config));
  const legacy = f.journal('legacy-cli'); legacy.delete('runConfig'); legacy.set('configPath', path); legacy.close();
  assert.equal(browserRuns(f.runs, f.profiles).length, 1);
  for (const changed of [{ ...f.config, party: 'other-party' }, { ...f.config, count: 4 }, { ...f.config, scenario: { type: 'baseline' } }]) {
    writeFileSync(path, JSON.stringify(changed)); assert.equal(browserRuns(f.runs, f.profiles).length, 0);
  }
});

test('old generated proxy URLs are excluded and recovered only from a matching original profile', t => {
  const f = fixture(t);
  const routed = { ...f.config, endpoints: {
    A: { ...f.config.endpoints.A, url: `http://127.0.0.1:15001/${'a'.repeat(48)}` },
    B: { ...f.config.endpoints.B, url: `http://127.0.0.1:15002/${'a'.repeat(48)}` } } };
  const old = f.journal('old-proxy', routed); old.close();
  assert.equal(browserRuns(f.runs, f.profiles).length, 0);
  writeFileSync(join(f.profiles, 'wrong.json'), JSON.stringify({ ...f.config, count: 4 }));
  assert.equal(browserRuns(f.runs, f.profiles).length, 0);
  writeFileSync(join(f.profiles, 'correct.json'), JSON.stringify(f.config));
  const found = browserRuns(f.runs, f.profiles); assert.equal(found.length, 1);
  assert.equal(found[0].config.endpoints.A.url, f.config.endpoints.A.url);
});

test('reuse completed settings as a fresh journal and preserve locally available credential references', async t => {
  const f = fixture(t);
  const old = f.journal('completed'); old.set('completedAt', new Date().toISOString()); old.close();
  writeFileSync(join(f.profiles, 'saved.json'), JSON.stringify(f.config));
  process.env.PRIOR_TEST_TOKEN_A = 'synthetic-local-token';
  t.after(() => { delete process.env.PRIOR_TEST_TOKEN_A; });
  const clone = await prepareBrowserRun({ reuseSource: 'completed', config: f.config }, f.runs, f.profiles);
  assert.notEqual(clone.journalPath, join(f.runs, 'completed', 'journal.sqlite'));
  assert.ok(clone.env.CANTON_A_TOKEN === process.env.PRIOR_TEST_TOKEN_A);
  assert.equal(clone.connectionConfig.endpoints.A.auth.type, 'static');
  const saved = JSON.parse(readFileSync(clone.configPath, 'utf8'));
  assert.equal(saved.endpoints.A.auth.tokenEnv, 'PRIOR_TEST_TOKEN_A');
  assert.ok(!readFileSync(clone.configPath, 'utf8').includes('synthetic-local-token'));
  const fresh = new Journal(clone.journalPath, false); assert.equal(fresh.get('runId'), undefined); fresh.close();
  const resumed = await prepareBrowserRun({ savedRun: clone.id }, f.runs, f.profiles);
  assert.equal(resumed.journalPath, clone.journalPath);
  assert.ok(resumed.env.CANTON_A_TOKEN === process.env.PRIOR_TEST_TOKEN_A);
  assert.equal(browserProfiles(f.profiles)[0].id, 'profile:saved');
  await assert.rejects(prepareBrowserRun({ reuseSource: '../../other-file' }, f.runs, f.profiles));
  await assert.rejects(prepareBrowserRun({ savedRun: clone.id, reuseSource: 'profile:saved' }, f.runs, f.profiles));
});
