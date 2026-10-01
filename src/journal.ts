import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, EndpointId, Fault, Operation, Receipt, Scenario, identity } from './model.js';

export class Journal {
  readonly db: DatabaseSync;
  private lock?: DatabaseSync;
  constructor(readonly path: string, writable = true) {
    if (writable) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    else if (!existsSync(path)) throw new Fault('configuration', 'Journal does not exist');
    this.db = new DatabaseSync(path, { readOnly: !writable });
    if (writable) {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (sequence INTEGER PRIMARY KEY, inputStateId TEXT NOT NULL, payloadDigest TEXT NOT NULL, status TEXT NOT NULL, receiptId TEXT, successorId TEXT);
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, endpoint TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);`);
      if (this.get('schema') && this.get('schema') !== 1) throw new Fault('configuration', 'Unsupported journal schema');
      this.set('schema', 1);
    }
  }
  acquire(): void {
    const lock = new DatabaseSync(`${this.path}.lock`);
    chmodSync(`${this.path}.lock`, 0o600);
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { lock.close(); throw new Fault('configuration', 'Another runner owns this journal'); }
    this.lock = lock;
  }
  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, JSON.stringify(value)); }
  delete(key: string): void { this.db.prepare('DELETE FROM meta WHERE key=?').run(key); }
  events(): { id: number; at: string; kind: string; data: Record<string, unknown> }[] {
    return (this.db.prepare('SELECT id,at,kind,data FROM events ORDER BY id').all() as unknown as { id: number; at: string; kind: string; data: string }[]).map(e => ({ ...e, data: JSON.parse(e.data) }));
  }
  event(kind: string, data: unknown = {}): void { this.db.prepare('INSERT INTO events(at,kind,data) VALUES (?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(data)); }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  initialize(c: Config, runId: string): void {
    if (this.get('runId')) throw new Fault('configuration', 'Journal already initialized; use resume');
    this.transaction(() => {
      this.set('identity', identity(c)); this.set('runId', runId); this.set('count', c.count);
      this.set('scenario', c.scenario); this.set('mode', c.mode); this.set('active', c.primary); this.set('createdAt', new Date().toISOString());
      this.set('bootstrap', 'planned'); this.event('run_created', { runId, count: c.count, mode: c.mode });
    });
  }
  assertConfig(c: Config): void {
    const stored = this.get<Scenario>('scenario') ?? { type: 'baseline' };
    if (JSON.stringify(stored) !== JSON.stringify(c.scenario)) throw new Fault('configuration', 'Scenario differs from this journal');
    if (this.get('identity') !== identity(c) || this.get('count') !== c.count) throw new Fault('configuration', 'Config identity or operation count differs from this journal');
  }
  operations(): Operation[] { return this.db.prepare('SELECT * FROM operations ORDER BY sequence').all() as unknown as Operation[]; }
  operation(sequence: number): Operation | undefined { return this.db.prepare('SELECT * FROM operations WHERE sequence=?').get(sequence) as unknown as Operation | undefined; }
  plan(operation: Operation): void {
    this.db.prepare('INSERT INTO operations(sequence,inputStateId,payloadDigest,status) VALUES (?,?,?,?)').run(operation.sequence, operation.inputStateId, operation.payloadDigest, 'planned');
    this.event('operation_planned', { sequence: operation.sequence });
  }
  attempt(sequence: number, endpoint: EndpointId): string {
    const id = randomUUID();
    this.transaction(() => {
      if (sequence > 0) this.db.prepare("UPDATE operations SET status='unknown' WHERE sequence=?").run(sequence);
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?)').run(id, sequence, endpoint, new Date().toISOString(), null, 'dispatching');
      this.event('dispatching', { sequence, endpoint, attemptId: id });
    });
    return id;
  }
  attemptResult(id: string, result: string): void {
    this.db.prepare('UPDATE attempts SET finishedAt=?,result=? WHERE id=?').run(new Date().toISOString(), result, id);
    this.event('attempt_result', { attemptId: id, result });
  }
  commit(receipt: Receipt, successorId: string, endpoint?: EndpointId): void {
    const op = this.operation(receipt.sequence);
    if (!op || op.inputStateId !== receipt.inputStateId || op.payloadDigest !== receipt.payloadDigest) throw new Fault('integrity', 'Ledger receipt differs from persisted intent');
    if (op.status === 'committed') {
      if (op.receiptId !== receipt.contractId || op.successorId !== successorId) throw new Fault('integrity', 'Previously committed operation changed');
      return;
    }
    this.transaction(() => {
      this.db.prepare("UPDATE operations SET status='committed',receiptId=?,successorId=? WHERE sequence=?").run(receipt.contractId, successorId, receipt.sequence);
      this.event('operation_committed', { sequence: receipt.sequence, receiptId: receipt.contractId, endpoint });
    });
  }
  mark(label: 'fault-start' | 'fault-end' | 'recovery', endpoint?: EndpointId, simulated = false): void {
    this.transaction(() => {
      if (!this.get('runId')) throw new Fault('configuration', 'Journal is not initialized');
      if (this.get('completedAt') || this.events().some(e => e.kind === 'converged')) throw new Fault('configuration', 'Completed runs cannot accept marker edits');
      const scenario = this.get<Scenario>('scenario') ?? { type: 'baseline' };
      if (scenario.type === 'baseline') { this.event('operator_marker', { label, endpoint, simulated }); return; }
      if (label === 'recovery') { this.event('operator_marker', { label, endpoint, simulated }); return; }
      if (endpoint !== scenario.faultedEndpoint) throw new Fault('configuration', 'Fault marker endpoint must match the configured scenario');
      const windows = this.events().filter(e => e.kind === 'fault_start' || e.kind === 'fault_end');
      if (label === 'fault-start' ? windows.length !== 0 : windows.length !== 1 || windows[0].kind !== 'fault_start' || windows[0].data.endpoint !== endpoint)
        throw new Fault('configuration', 'Fault markers require exactly one ordered, matching start/end window');
      this.event(label.replace('-', '_'), { endpoint, simulated, operatorAttested: true });
    });
  }
  close(): void { this.lock?.close(); this.db.close(); }
}
