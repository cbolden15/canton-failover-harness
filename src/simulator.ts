import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { SDK, CustomLogAdapter } from '@canton-network/wallet-sdk';
import { Config, EndpointId, Receipt, RunState, configSchema } from './model.js';

/** Local protocol fixture, not a Canton node. It models consuming contracts only. */
export class Simulator {
  readonly db: DatabaseSync;
  readonly offline = new Set<EndpointId>();
  readonly dropAfterCommit = new Set<number>();
  readonly rejectBeforeCommit = new Set<number>();
  readonly executions: { endpoint: EndpointId; sequence: number; input?: string; hashVersion: string; fingerprint: string }[] = [];
  onCommit?: (sequence: number, endpoint: EndpointId) => void;
  pageSize = 200;
  private server?: Server;
  private config?: Config;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS contracts(id TEXT PRIMARY KEY, kind TEXT, payload TEXT); CREATE TABLE IF NOT EXISTS counter(n INTEGER); INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter);');
  }
  async start(overrides: Partial<Config> = {}): Promise<Config> {
    const keys = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) }).keys;
    const pair = keys.generate(); const fingerprint = await keys.fingerprint(pair.publicKey);
    const suffix = randomUUID().replaceAll('-', '');
    process.env[`SIM_KEY_${suffix}`] = pair.privateKey;
    process.env[`SIM_TOKEN_${suffix}`] = 'local-simulation-only';
    this.server = createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}'); }); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No simulation address');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { type: 'static', tokenEnv: `SIM_TOKEN_${suffix}` };
    this.config = configSchema.parse({ mode: 'simulation', party: 'simulation-party::namespace', synchronizerId: 'simulation-sync', packageId: 'a'.repeat(64), signingKeyEnv: `SIM_KEY_${suffix}`, signingFingerprint: fingerprint, topologyConfirmed: true, count: 5, intervalMs: 0, pollMs: 5, retryAfterMs: 5, requestTimeoutMs: 1000, operationTimeoutMs: 2000, runTimeoutMs: 10000, convergenceTimeoutMs: 2000, endpoints: { A: { url: `${base}/a`, participantId: 'participant-A', auth }, B: { url: `${base}/b`, participantId: 'participant-B', auth } }, ...overrides });
    return this.config;
  }
  contracts(): { id: string; kind: string; payload: string }[] { return this.db.prepare('SELECT * FROM contracts ORDER BY rowid').all() as unknown as { id: string; kind: string; payload: string }[]; }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const endpoint: EndpointId = req.url?.startsWith('/a/') ? 'A' : 'B';
    const route = new URL(req.url!, 'http://localhost').pathname.slice(2);
    const send = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (this.offline.has(endpoint)) { send({}, 503); return; }
    if (req.headers.authorization !== 'Bearer local-simulation-only') { send({}, 401); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const c = this.config!;
    if (route === '/v2/authenticated-user') return send({ user: { id: 'simulation-user' } });
    if (route === '/v2/state/connected-synchronizers') return send({ connectedSynchronizers: [{ synchronizerId: c.synchronizerId, synchronizerAlias: 'global', permission: 'Submission' }] });
    if (route === '/v2/parties/participant-id') return send({ participantId: `participant-${endpoint}` });
    if (route === `/v2/packages/${c.packageId}/status`) return send({ packageStatus: 'PACKAGE_STATUS_REGISTERED' });
    if (route === '/v2/state/ledger-end') return send({ offset: (this.db.prepare('SELECT n FROM counter').get() as { n: number }).n });
    if (route === '/v2/state/active-contracts-page') {
      const all = this.contracts(); const start = Number(body.pageToken ?? 0); const end = start + this.pageSize;
      return send({ activeAtOffset: body.activeAtOffset, ...(end < all.length ? { nextPageToken: String(end) } : {}), activeContracts: all.slice(start, end).map(row => ({ contractEntry: { JsActiveContract: { synchronizerId: c.synchronizerId, createdEvent: { contractId: row.id, templateId: `${c.packageId}:Failover:${row.kind}`, createArgument: JSON.parse(row.payload) } } } })) });
    }
    if (route === '/v2/interactive-submission/prepare') {
      const preparedTransaction = Buffer.from(JSON.stringify(body)).toString('base64');
      return send({ preparedTransaction, preparedTransactionHash: createHash('sha256').update(preparedTransaction).digest('base64'), hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V3' });
    }
    if (route === '/v2/interactive-submission/executeAndWait') {
      const prepared = JSON.parse(Buffer.from(body.preparedTransaction, 'base64').toString());
      const command = prepared.commands[0];
      const sequence = command.ExerciseCommand ? Number(command.ExerciseCommand.choiceArgument.sequence) : 0;
      this.executions.push({ endpoint, sequence, input: command.ExerciseCommand?.contractId, hashVersion: body.hashingSchemeVersion, fingerprint: body.partySignatures.signatures[0].signatures[0].signedBy });
      if (this.rejectBeforeCommit.delete(sequence)) return send({}, 503);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (command.CreateCommand) {
          this.db.prepare('INSERT INTO contracts VALUES (?,?,?)').run(randomUUID(), 'RunState', JSON.stringify(command.CreateCommand.createArguments));
        } else {
          const e = command.ExerciseCommand;
          const row = this.db.prepare('SELECT payload FROM contracts WHERE id=? AND kind=?').get(e.contractId, 'RunState') as { payload: string } | undefined;
          if (!row) { this.db.exec('ROLLBACK'); return send({ code: 'CONTRACT_NOT_FOUND' }, 409); }
          const state = JSON.parse(row.payload) as RunState;
          if (Number(state.nextSequence) !== sequence) { this.db.exec('ROLLBACK'); return send({ code: 'INVALID_SEQUENCE' }, 400); }
          const receiptId = randomUUID();
          const receipt: Omit<Receipt, 'contractId'> = { owner: state.owner, runId: state.runId, sequence, operationId: `${state.runId}:${sequence}`, payloadDigest: e.choiceArgument.payloadDigest, inputStateId: e.contractId, previousReceiptId: state.previousReceiptId };
          this.db.prepare('DELETE FROM contracts WHERE id=?').run(e.contractId);
          this.db.prepare('INSERT INTO contracts VALUES (?,?,?)').run(receiptId, 'Receipt', JSON.stringify(receipt));
          this.db.prepare('INSERT INTO contracts VALUES (?,?,?)').run(randomUUID(), 'RunState', JSON.stringify({ owner: state.owner, runId: state.runId, nextSequence: sequence + 1, previousReceiptId: receiptId }));
        }
        this.db.exec('UPDATE counter SET n=n+1; COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      this.onCommit?.(sequence, endpoint);
      if (this.dropAfterCommit.delete(sequence)) { res.destroy(); return; }
      return send({ updateId: randomUUID() });
    }
    send({}, 404);
  }
  async close(): Promise<void> {
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server!.close(e => e ? reject(e) : resolve())); }
    if (this.config) { delete process.env[this.config.signingKeyEnv]; const a = this.config.endpoints.A.auth; if (a.type === 'static') delete process.env[a.tokenEnv]; }
    this.db.close();
  }
}
