import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { Journal } from './journal.js';
import { report, writeReport } from './report.js';
import { Simulator } from './simulator.js';
import { Runner } from './runner.js';
import { CantonLedger } from './ledger.js';
import { faultKind, loadConfig, type EndpointId } from './model.js';
import { FaultProxy } from './fault-proxy.js';
import { freshRunDirectory } from './experience.js';
import { browserRuns, doctorOutputSchema, liveDefaults, prepareBrowserRun } from './ui-live.js';
import { uiPage } from './ui-page.js';

type DisplayIdentities = { externalPartyId: string; participants: { A: string; B: string } };
function displayIdentities(journal: Journal): DisplayIdentities | null {
  const saved = journal.get<DisplayIdentities>('displayIdentities');
  if (saved) return saved;
  // Older live journals can use their original config, only when its run identity matches.
  const configPath = journal.get<string>('configPath');
  if (!configPath) return null;
  try {
    const config = loadConfig(configPath);
    journal.assertConfig(config);
    return { externalPartyId: config.party, participants: { A: config.endpoints.A.participantId, B: config.endpoints.B.participantId } };
  } catch { return null; }
}

/** Browser projection deliberately excludes contracts, config, and free-form event data. */
export function trafficSnapshot(journal: Journal) {
  const r = report(journal);
  const keys = ['sequence', 'endpoint', 'from', 'to', 'kind', 'reason', 'result', 'attemptId'] as const;
  const lastActivity = r.events.findLast(e => ['dispatching', 'operation_committed', 'root_confirmed', 'converged', 'stopped', 'command_error'].includes(e.kind));
  return {
    runId: r.runId, mode: r.mode, activeEndpoint: r.activeEndpoint,
    identities: displayIdentities(journal),
    faultSource: r.faultSource, survivorConfirmed: r.acceptance.qualifyingSequences.length,
    survivorRequired: r.scenario.type === 'failover' ? r.scenario.minSurvivorOperations : 0,
    committed: r.committed, plannedTotal: r.plannedTotal, failovers: r.failovers,
    completedAt: r.completedAt, result: r.acceptanceResult,
    stopped: lastActivity?.kind === 'stopped' || lastActivity?.kind === 'command_error',
    operations: r.operations.map(o => ({ sequence: o.sequence, status: o.status })),
    attempts: r.attempts.map(a => {
      const row = a as Record<string, unknown>;
      return { id: row.id, sequence: row.sequence, endpoint: row.endpoint, result: row.result };
    }),
    events: r.events.map(e => ({ id: e.id, at: e.at, kind: e.kind,
      data: Object.fromEntries(keys.filter(k => k in e.data).map(k => [k, e.data[k]])) })),
  };
}

export async function startUi(options: { journal?: string; port?: number; proxyConfig?: string; liveConfig?: string; envFile?: string; runsDirectory?: string } = {}) {
  if (options.liveConfig && options.proxyConfig) throw new Error('Use --live-config or --proxy-config, not both');
  if (options.liveConfig && !options.journal) throw new Error('--live-config requires --journal');
  if (options.envFile && !options.liveConfig) throw new Error('--env-file requires --live-config');
  const upstreamPath = options.liveConfig ?? options.proxyConfig;
  let upstream = upstreamPath ? loadConfig(resolve(upstreamPath)) : undefined;
  if (options.liveConfig && upstream?.mode !== 'testnet') throw new Error('--live-config requires a testnet config');
  if (options.liveConfig && !existsSync(resolve(options.journal!))) {
    const empty = new Journal(resolve(options.journal!)); empty.close();
  }
  if (options.proxyConfig && !options.journal) throw new Error('--proxy-config requires an initialized --journal');
  let journal = options.journal ? new Journal(resolve(options.journal), false) : undefined;
  if (journal && !journal.get('runId') && !options.liveConfig) { journal.close(); throw new Error('Journal is not initialized'); }
  let proxy: FaultProxy | undefined;
  let proxyConfigPath: string | undefined;
  let faultedEndpoint: EndpointId | undefined;
  if (upstream) {
    try {
      const config = upstream;
      if (journal!.get('runId')) journal!.assertConfig(config);
      if (config.scenario.type !== 'failover') throw new Error('Proxy controls require a failover scenario');
      faultedEndpoint = config.scenario.faultedEndpoint;
      const markers = journal!.events().filter(e => e.kind === 'fault_start' || e.kind === 'fault_end');
      if (markers.some(e => e.data.source !== 'client-proxy')) throw new Error('This journal already contains infrastructure outage markers; keep exercising that original scenario');
      proxy = new FaultProxy(config);
      const routed = await proxy.start();
      if (markers.length === 1) proxy.block(faultedEndpoint);
      proxyConfigPath = join(resolve(options.journal!, '..'), `proxy-config-${randomUUID()}.json`);
      writeFileSync(proxyConfigPath, JSON.stringify(routed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e) { await proxy?.close(); journal?.close(); throw e; }
  }
  let configuring = false;
  let liveEnv: NodeJS.ProcessEnv = {};
  const setupEnabled = !options.journal;
  let runner: Runner | undefined;
  let running: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let liveError: string | undefined;
  let readiness: ReturnType<typeof doctorOutputSchema.parse> | undefined;
  let checking = false;
  let stoppingLive = false;
  let closing = false;
  let out: string | undefined;
  const demo = async (manualProxy = false) => {
    out = freshRunDirectory('demo');
    journal?.close();
    journal = new Journal(join(out, 'journal.sqlite'));
    const current = journal;
    const simulator = new Simulator(join(out, 'simulation.sqlite'));
    let restore: ReturnType<typeof setTimeout> | undefined;
    try {
      current.acquire();
      const config = await simulator.start({ count: manualProxy ? 60 : 16, intervalMs: manualProxy ? 1000 : 700, runTimeoutMs: 120000, convergenceTimeoutMs: 120000,
        scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
      if (!manualProxy) simulator.dropAfterCommit.add(4);
      if (!manualProxy) simulator.onCommit = sequence => {
        if (sequence === 4) { simulator.offline.add('A'); current.mark('fault-start', 'A', true); }
        if (sequence === config.count) restore = setTimeout(() => {
          current.mark('fault-end', 'A', true); simulator.offline.delete('A');
        }, 100);
      };
      current.initialize(config, randomUUID());
      let routed = config;
      if (manualProxy) {
        proxy = new FaultProxy(config); faultedEndpoint = 'A';
        routed = await proxy.start();
      }
      runner = new Runner(routed, current, { A: new CantonLedger('A', routed), B: new CantonLedger('B', routed) });
      if (closing) runner.stop();
      await runner.run();
    } catch (e) {
      current.set('result', ['integrity', 'acceptance'].includes(faultKind(e)) ? 'FAIL' : 'INCONCLUSIVE');
      current.event('command_error', { kind: faultKind(e) });
    } finally {
      if (restore) clearTimeout(restore);
      if (manualProxy) { await proxy?.close(); proxy = undefined; }
      await simulator.close();
      writeReport(current, out!);
      current.close();
      journal = new Journal(join(out!, 'journal.sqlite'), false);
      runner = undefined;
    }
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const address = server.address();
    const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    };
    if (req.headers.host !== host && req.headers.host !== host.replace('127.0.0.1', 'localhost')) return send(403, { error: 'Loopback host required' });
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(uiPage); return;
      }
      if (req.method === 'GET' && req.url === '/api/traffic') {
        const markers = journal?.events().filter(e => e.kind === 'fault_start' || e.kind === 'fault_end') ?? [];
        return send(200, { readOnly: Boolean(options.journal) && !proxy, canSetup: setupEnabled, canDemo: !options.journal, running: Boolean(running) || configuring,
          live: options.liveConfig ? { initialized: Boolean(journal?.get('runId')), completed: Boolean(journal?.get('completedAt')), stopping: stoppingLive, checking, readiness, identities: upstream ? { externalPartyId: upstream.party, participants: { A: upstream.endpoints.A.participantId, B: upstream.endpoints.B.participantId } } : null, plannedTotal: upstream?.count, error: liveError, configPath: resolve(options.liveConfig), journalPath: journal!.path } : null,
          proxy: proxy ? { endpoint: faultedEndpoint, blocked: [...proxy.blocked],
            canBlock: !closing && journal?.get('bootstrap') === 'confirmed' && !journal.get('completedAt') && markers.length === 0,
            canRestore: !closing && markers.length === 1 && proxy.blocked.has(faultedEndpoint!) } : null,
          snapshot: journal?.get('runId') ? trafficSnapshot(journal) : null });
      }
      if (req.method === 'GET' && req.url === '/api/live/setup') {
        if (!setupEnabled) return send(403, { error: 'This viewer uses a server-selected configuration' });
        const runs = browserRuns(options.runsDirectory);
        return send(200, { defaults: liveDefaults, selectedRun: runs.find(r => r.journalPath === journal?.path)?.id ?? runs.find(r => !r.completed)?.id, runs: runs.map(r => ({ id: r.id, runId: r.runId, completed: r.completed, config: r.config })) });
      }
      if (req.method === 'POST' && req.url === '/api/live/configure') {
        if (!setupEnabled) return send(403, { error: 'This viewer uses a server-selected configuration' });
        if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Same-origin request required' });
        if (running || configuring || closing) return send(409, { error: 'Stop the workload before setup' });
        configuring = true;
        let nextProxy: FaultProxy | undefined;
        let nextJournal: Journal | undefined;
        try {
          if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required' });
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 65536) return send(413, { error: 'Setup request too large' });
            chunks.push(Buffer.from(chunk));
          }
          let input: unknown;
          try { input = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { return send(400, { error: 'Invalid setup request' }); }
          // Require explicit selection of the existing run, so ambiguous initialization never creates a second root.
          const selected = input && typeof input === 'object' && 'savedRun' in input ? input.savedRun : undefined;
          const existing = browserRuns(options.runsDirectory).find(r => r.journalPath === journal?.path);
          if (journal?.get('mode') === 'testnet' && journal.get('runId') && !journal.get('completedAt') && selected !== existing?.id) return send(409, { error: 'Resume the current unfinished run; its journal must be preserved' });
          const prepared = await prepareBrowserRun(input, options.runsDirectory);
          nextJournal = new Journal(prepared.journalPath, false);
          if (nextJournal.get('runId')) nextJournal.assertConfig(prepared.config);
          const markers = nextJournal.events().filter(e => e.kind === 'fault_start' || e.kind === 'fault_end');
          if (markers.some(e => e.data.source !== 'client-proxy')) return send(409, { error: 'Saved run contains infrastructure markers' });
          nextProxy = new FaultProxy(prepared.config);
          const routed = await nextProxy.start();
          const target = prepared.config.scenario.type === 'failover' ? prepared.config.scenario.faultedEndpoint : undefined;
          if (markers.length === 1) nextProxy.block(target!);
          const routedPath = join(resolve(prepared.journalPath, '..'), `proxy-config-${randomUUID()}.json`);
          writeFileSync(routedPath, JSON.stringify(routed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          if (closing) return send(409, { error: 'Viewer is stopping' });
          await proxy?.close(); journal?.close();
          proxy = nextProxy; journal = nextJournal; nextProxy = undefined; nextJournal = undefined;
          faultedEndpoint = target; proxyConfigPath = routedPath;
          options.liveConfig = prepared.configPath; options.journal = prepared.journalPath; options.envFile = undefined;
          liveEnv = prepared.env; upstream = prepared.config; liveError = undefined; readiness = undefined;
          return send(200, { configured: true });
        } catch (e) {
          // Only validation errors are safe to show; raw filesystem/SDK errors remain private.
          const message = e instanceof Error && /^(Invalid setup|Saved run|Check setup fields|Live setup|Primary participant|Confirm shared|Signing key)/.test(e.message) ? e.message : 'Could not configure this run; check setup fields';
          return send(400, { error: message });
        } finally { await nextProxy?.close(); nextJournal?.close(); configuring = false; }
      }
      if (req.method === 'POST' && (req.url === '/api/live/start' || req.url === '/api/live/stop' || req.url === '/api/live/check')) {
        if (!options.liveConfig || !journal || !proxyConfigPath) return send(403, { error: 'Live controls are not enabled' });
        if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Same-origin request required' });
        if (closing) return send(409, { error: 'Viewer is stopping' });
        if (req.url === '/api/live/stop') {
          if (!child || stoppingLive) return send(409, { error: 'No active workload to stop' });
          stoppingLive = true; child.kill('SIGINT');
          return send(202, { stopping: true });
        }
        if (running || configuring) return send(409, { error: 'Workload already running or setup in progress' });
        if (req.url !== '/api/live/check' && journal.get('completedAt')) return send(409, { error: 'Run completed; select a new journal for another test' });
        const command = req.url === '/api/live/check' ? 'doctor' : journal.get('runId') ? 'resume' : 'start';
        const cli = new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url);
        const args = [...(cli.pathname.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), fileURLToPath(cli), command,
          '--config', proxyConfigPath, '--journal', journal.path, '--json',
          ...(options.envFile ? ['--env-file', resolve(options.envFile)] : [])];
        liveError = undefined; stoppingLive = false; checking = command === 'doctor';
        // Reuse the CLI's readiness checks, journal lock, and unknown-outcome reconciliation.
        // Never return its raw output: credentials and transaction details stay server-side.
        child = spawn(process.execPath, args, { stdio: command === 'doctor' ? ['ignore', 'pipe', 'ignore'] : 'ignore', env: { ...process.env, ...liveEnv } });
        const currentChild = child;
        let output = '';
        currentChild.stdout?.on('data', chunk => { if (output.length < 262144) output += chunk.toString(); });
        running = new Promise<void>(done => {
          currentChild.once('error', () => { liveError = 'Workload could not launch. Check the server configuration; the journal is preserved.'; done(); });
          currentChild.once('close', code => {
            if (command === 'doctor') {
              try {
                const value = doctorOutputSchema.parse(JSON.parse(output));
                // Keep entered credential values out of any diagnostic projection.
                let safe = JSON.stringify(value);
                for (const secret of Object.values(liveEnv)) if (secret) safe = safe.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
                readiness = doctorOutputSchema.parse(JSON.parse(safe));
              } catch { liveError = 'Connection checks could not finish. Check the participant details and credentials in Live setup.'; }
            } else if (code !== 0 && !stoppingLive) liveError = 'Workload stopped before completion. Use Check connections to inspect prerequisites, then resume this same journal.';
            done();
          });
        }).finally(() => { child = undefined; stoppingLive = false; checking = false; running = undefined; });
        return send(202, { started: true, command });
      }
      const control = req.url?.match(/^\/api\/proxy\/(A|B)\/(block|restore)$/);
      if (req.method === 'POST' && control) {
        if (!proxy || !journal) return send(403, { error: 'Proxy controls are not enabled' });
        if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Same-origin request required' });
        if (closing) return send(409, { error: 'Viewer is stopping' });
        const endpoint = control[1] as EndpointId;
        if (endpoint !== faultedEndpoint) return send(409, { error: 'Only the configured fault endpoint can be blocked' });
        const markerJournal = new Journal(journal.path);
        try {
          if (markerJournal.get('bootstrap') !== 'confirmed') return send(409, { error: 'Wait for root confirmation before blocking traffic' });
          if (control[2] === 'block') {
            if (proxy.blocked.has(endpoint)) return send(409, { error: 'Traffic is already blocked' });
            // No async gap between cutting connections and recording the outage window.
            proxy.block(endpoint);
            try { markerJournal.mark('fault-start', endpoint, markerJournal.get('mode') === 'simulation', 'client-proxy'); }
            catch { proxy.restore(endpoint); return send(409, { error: 'Cannot start another outage window on this run' }); }
          } else {
            if (!proxy.blocked.has(endpoint)) return send(409, { error: 'Traffic is not blocked' });
            // End the acceptance window before reopening the route.
            markerJournal.mark('fault-end', endpoint, markerJournal.get('mode') === 'simulation', 'client-proxy');
            proxy.restore(endpoint);
          }
          return send(200, { endpoint, blocked: proxy.blocked.has(endpoint) });
        } finally { markerJournal.close(); }
      }
      if (req.method === 'POST' && (req.url === '/api/demo' || req.url === '/api/proxy-demo')) {
        if (options.journal) return send(403, { error: 'This viewer is read-only' });
        if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Same-origin request required' });
        if (running || configuring || closing) return send(409, { error: 'Simulation already running or server stopping' });
        running = demo(req.url === '/api/proxy-demo').catch(() => { console.error('Simulation report failed; journal preserved.'); }).finally(() => { running = undefined; });
        return send(202, { started: true });
      }
      send(404, { error: 'Not found' });
    } catch { send(503, { error: 'Journal snapshot unavailable; retry shortly' }); }
  });
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 8787, '127.0.0.1', done); });
  } catch (e) { await proxy?.close(); journal?.close(); throw e; }
  return { server, proxyConfigPath, close: async () => {
    closing = true; runner?.stop(); child?.kill('SIGINT');
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
    await proxy?.close();
    await running; journal?.close(); liveEnv = {};
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { journal: { type: 'string' }, port: { type: 'string' }, 'proxy-config': { type: 'string' }, 'live-config': { type: 'string' }, 'env-file': { type: 'string' } } });
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const ui = await startUi({ journal: values.journal, port, proxyConfig: values['proxy-config'], liveConfig: values['live-config'], envFile: values['env-file'] });
  console.log(`Open http://127.0.0.1:${port} (${values['live-config'] ? 'live workload controls' : values['proxy-config'] ? 'client fault proxy controls' : values.journal ? 'read-only journal viewer' : 'local simulation'})`);
  if (ui.proxyConfigPath && !values['live-config']) console.log(`Proxy config: ${ui.proxyConfigPath}\nRun or resume the CLI using this --config and the same --journal. Requests using the original config bypass these controls.`);
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void ui.close(); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
