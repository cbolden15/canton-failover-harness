import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Journal } from './journal.js';
import { report, writeReport } from './report.js';
import { Simulator } from './simulator.js';
import { Runner } from './runner.js';
import { CantonLedger } from './ledger.js';
import { faultKind } from './model.js';
import { freshRunDirectory } from './experience.js';
import { uiPage } from './ui-page.js';

/** Browser projection deliberately excludes contracts, config, and free-form event data. */
export function trafficSnapshot(journal: Journal) {
  const r = report(journal);
  const keys = ['sequence', 'endpoint', 'from', 'to', 'kind', 'reason', 'result', 'attemptId'] as const;
  const lastActivity = r.events.findLast(e => ['dispatching', 'operation_committed', 'root_confirmed', 'converged', 'stopped', 'command_error'].includes(e.kind));
  return {
    runId: r.runId, mode: r.mode, activeEndpoint: r.activeEndpoint,
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

export async function startUi(options: { journal?: string; port?: number } = {}) {
  let journal = options.journal ? new Journal(resolve(options.journal), false) : undefined;
  if (journal && !journal.get('runId')) { journal.close(); throw new Error('Journal is not initialized'); }
  let runner: Runner | undefined;
  let running: Promise<void> | undefined;
  let closing = false;
  let out: string | undefined;
  const demo = async () => {
    out = freshRunDirectory('demo');
    journal?.close();
    journal = new Journal(join(out, 'journal.sqlite'));
    const current = journal;
    const simulator = new Simulator(join(out, 'simulation.sqlite'));
    let restore: ReturnType<typeof setTimeout> | undefined;
    try {
      current.acquire();
      const config = await simulator.start({ count: 16, intervalMs: 700, runTimeoutMs: 30000,
        scenario: { type: 'failover', faultedEndpoint: 'A', minSurvivorOperations: 2, recoveryTimeoutMs: 2000 } });
      simulator.dropAfterCommit.add(4);
      simulator.onCommit = sequence => {
        if (sequence === 4) { simulator.offline.add('A'); current.mark('fault-start', 'A', true); }
        if (sequence === config.count) restore = setTimeout(() => {
          current.mark('fault-end', 'A', true); simulator.offline.delete('A');
        }, 100);
      };
      current.initialize(config, randomUUID());
      runner = new Runner(config, current, { A: new CantonLedger('A', config), B: new CantonLedger('B', config) });
      if (closing) runner.stop();
      await runner.run();
    } catch (e) {
      current.set('result', ['integrity', 'acceptance'].includes(faultKind(e)) ? 'FAIL' : 'INCONCLUSIVE');
      current.event('command_error', { kind: faultKind(e) });
    } finally {
      if (restore) clearTimeout(restore);
      await simulator.close();
      writeReport(current, out!);
      current.close();
      journal = new Journal(join(out!, 'journal.sqlite'), false);
      runner = undefined;
    }
  };
  const server = createServer((req, res) => {
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
        return send(200, { readOnly: Boolean(options.journal), running: Boolean(running),
          snapshot: journal?.get('runId') ? trafficSnapshot(journal) : null });
      }
      if (req.method === 'POST' && req.url === '/api/demo') {
        if (options.journal) return send(403, { error: 'This viewer is read-only' });
        if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Same-origin request required' });
        if (running || closing) return send(409, { error: 'Simulation already running or server stopping' });
        running = demo().catch(() => { console.error('Simulation report failed; journal preserved.'); }).finally(() => { running = undefined; });
        return send(202, { started: true });
      }
      send(404, { error: 'Not found' });
    } catch { send(503, { error: 'Journal snapshot unavailable; retry shortly' }); }
  });
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 8787, '127.0.0.1', done); });
  } catch (e) { journal?.close(); throw e; }
  return { server, close: async () => {
    closing = true; runner?.stop();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
    await running; journal?.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { journal: { type: 'string' }, port: { type: 'string' } } });
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const ui = await startUi({ journal: values.journal, port });
  console.log(`Open http://127.0.0.1:${port} (${values.journal ? 'read-only journal viewer' : 'local simulation'})`);
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void ui.close(); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
