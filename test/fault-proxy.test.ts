import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FaultProxy } from '../src/fault-proxy.js';
import { Simulator } from '../src/simulator.js';
import { Journal } from '../src/journal.js';
import { Runner } from '../src/runner.js';
import { CantonLedger } from '../src/ledger.js';
import { startUi } from '../src/ui.js';
import { report } from '../src/report.js';
import { loadConfig, type EndpointId, alternate } from '../src/model.js';

test('proxy cuts a committed execute reply without replaying it or changing the operation input', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-proxy-reply-'));
  const simulator = new Simulator();
  const config = await simulator.start({ count: 5, intervalMs: 40,
    scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
  const proxy = new FaultProxy(config);
  const routed = await proxy.start();
  const journal = new Journal(join(dir, 'journal.sqlite'));
  journal.initialize(config, 'proxy-lost-reply');
  t.after(async () => { await proxy.close(); await simulator.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  simulator.onCommit = sequence => {
    if (sequence === 1) {
      proxy.block('A'); journal.mark('fault-start', 'A', true, 'client-proxy');
    }
  };
  const runner = new Runner(routed, journal, { A: new CantonLedger('A', routed), B: new CantonLedger('B', routed) });
  const run = runner.run();
  const timer = setInterval(() => {
    if (report(journal).acceptance.qualifyingSequences.length >= 2 && proxy.blocked.has('A')) {
      journal.mark('fault-end', 'A', true, 'client-proxy'); proxy.restore('A');
    }
  }, 5);
  try { await run; } finally { clearInterval(timer); }
  assert.equal(report(journal).acceptanceResult, 'SIMULATION_CLIENT_PROXY_FAILOVER_PASS');
  assert.equal(simulator.executions.filter(e => e.sequence === 1).length, 1);
  assert.equal(simulator.executions.find(e => e.sequence === 1)?.input, journal.operation(1)?.inputStateId);
  assert.ok(journal.events().some(e => e.kind === 'operation_committed' && e.data.sequence === 1 && e.data.endpoint === 'B'));
  assert.equal(simulator.offline.size, 0, 'participant itself was never stopped');
});

for (const faulted of ['A', 'B'] as EndpointId[]) test(`UI controls disconnect ${faulted}, preserve survivor traffic, restore, and label client-proxy evidence`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-proxy-ui-'));
  const simulator = new Simulator();
  const config = await simulator.start({ count: 10, intervalMs: 80, primary: faulted,
    scenario: { type: 'failover', faultedEndpoint: faulted, minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const journal = new Journal(join(dir, 'journal.sqlite'));
  journal.initialize(config, `proxy-ui-${faulted}`);
  const ui = await startUi({ proxyConfig: configPath, journal: journal.path, port: 0 });
  t.after(async () => { await ui.close(); journal.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = ui.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const control = (endpoint: EndpointId, action: string, origin = base) => fetch(`${base}/api/proxy/${endpoint}/${action}`, { method: 'POST', headers: { Origin: origin } });
  assert.equal((await control(faulted, 'block', 'https://example.com')).status, 403);
  assert.equal((await control(faulted, 'block')).status, 409, 'root must first be confirmed');
  assert.equal((await control(alternate(faulted), 'block')).status, 409);
  const routed = loadConfig(ui.proxyConfigPath!);
  journal.assertConfig(routed);
  assert.notEqual(routed.endpoints.A.url, config.endpoints.A.url);
  assert.equal((await fetch(`${routed.endpoints.A.url}/v2/state/ledger-end`, { headers: { Origin: base } })).status, 403, 'browsers cannot use the forwarding route directly');
  const runner = new Runner(routed, journal, { A: new CantonLedger('A', routed), B: new CantonLedger('B', routed) });
  await runner.bootstrap();
  assert.equal((await control(faulted, 'block')).status, 200);
  assert.throws(() => journal.mark('fault-end', faulted, true), /source must match/);
  assert.equal((await control(faulted, 'block')).status, 409);
  const run = runner.run();
  let runError: unknown;
  void run.catch(e => { runError = e; });
  const until = Date.now() + 5000;
  while (report(journal).acceptance.qualifyingSequences.length < 2 && Date.now() < until && !runError) await new Promise(done => setTimeout(done, 10));
  if (runError || report(journal).acceptance.qualifyingSequences.length < 2) {
    runner.stop(); await run.catch(() => {});
    assert.fail('Survivor did not confirm the required operations within five seconds');
  }
  const state = await (await fetch(`${base}/api/traffic`)).json() as { proxy: { blocked: EndpointId[] }; snapshot: { faultSource: string } };
  assert.deepEqual(state.proxy.blocked, [faulted]);
  assert.equal(state.snapshot.faultSource, 'client-proxy');
  assert.equal((await control(faulted, 'restore')).status, 200);
  assert.equal((await control(faulted, 'restore')).status, 409);
  await run;
  const result = report(journal);
  assert.equal(result.acceptanceResult, 'SIMULATION_CLIENT_PROXY_FAILOVER_PASS');
  assert.match(result.measurement, /infrastructure remains online/);
  assert.ok(result.events.filter(e => e.kind === 'fault_start' || e.kind === 'fault_end').every(e => e.data.source === 'client-proxy' && e.data.operatorAttested === false));
  assert.equal((await control(faulted, 'block')).status, 409, 'one outage window per run');
  assert.ok(simulator.executions.filter(e => e.sequence > 0).every(e => e.endpoint === alternate(faulted)));
  assert.equal(simulator.offline.size, 0);
});

test('restarting proxy controls preserves an open window and generates fresh routes for the same root', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canton-proxy-restart-'));
  const simulator = new Simulator();
  const config = await simulator.start({ count: 3,
    scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 1, recoveryTimeoutMs: 2000 } });
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const journal = new Journal(join(dir, 'journal.sqlite')); journal.initialize(config, 'proxy-restart');
  const runner = new Runner(config, journal, { A: new CantonLedger('A', config), B: new CantonLedger('B', config) });
  await runner.bootstrap();
  const root = journal.get('rootId');
  let ui = await startUi({ proxyConfig: configPath, journal: journal.path, port: 0 });
  t.after(async () => { await ui.close(); journal.close(); await simulator.close(); rmSync(dir, { recursive: true, force: true }); });
  let address = ui.server.address(); assert.ok(address && typeof address !== 'string');
  let base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/proxy/A/block`, { method: 'POST', headers: { Origin: base } })).status, 200);
  const oldConfig = ui.proxyConfigPath;
  await ui.close();
  ui = await startUi({ proxyConfig: configPath, journal: journal.path, port: 0 });
  address = ui.server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const state = await (await fetch(`${base}/api/traffic`)).json() as { proxy: { blocked: string[]; canRestore: boolean } };
  assert.deepEqual(state.proxy.blocked, ['A']); assert.equal(state.proxy.canRestore, true);
  assert.notEqual(ui.proxyConfigPath, oldConfig);
  assert.equal(journal.get('rootId'), root);
  assert.equal((await fetch(`${base}/api/proxy/A/restore`, { method: 'POST', headers: { Origin: base } })).status, 200);
  assert.equal(journal.events().filter(e => e.kind === 'fault_start').length, 1);
  assert.equal(journal.events().filter(e => e.kind === 'fault_end').length, 1);
});
