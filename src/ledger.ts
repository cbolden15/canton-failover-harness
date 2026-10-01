import { SDK, CustomLogAdapter, signTransactionHash, getPublicKeyFromPrivate, type SDKInterface } from '@canton-network/wallet-sdk';
import { z } from 'zod';
import { Config, EndpointId, Fault, Operation, Snapshot } from './model.js';
import { Transport } from './transport.js';

const integer = z.union([z.string().regex(/^\d+$/), z.number()]).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const stateSchema = z.object({ owner: z.string(), runId: z.string(), nextSequence: integer.pipe(z.number().positive()), previousReceiptId: z.string().nullable() });
const receiptSchema = z.object({ owner: z.string(), runId: z.string(), sequence: integer.pipe(z.number().positive()), operationId: z.string(), payloadDigest: z.string(), inputStateId: z.string(), previousReceiptId: z.string().nullable() });
const silentLogger = new CustomLogAdapter(() => {});

export interface Ledger {
  endpoint: EndpointId;
  setDeadline(deadline: number): void;
  preflight(): Promise<unknown>;
  snapshot(runId: string): Promise<Snapshot>;
  create(runId: string, beforeExecute: () => string): Promise<void>;
  advance(runId: string, operation: Operation, beforeExecute: () => string): Promise<void>;
}

export class CantonLedger implements Ledger {
  readonly transport: Transport;
  private sdk?: Promise<SDKInterface>;
  private fingerprintVerified = false;
  constructor(readonly endpoint: EndpointId, private readonly config: Config) { this.transport = new Transport(endpoint, config); }
  setDeadline(deadline: number): void { this.transport.deadline = deadline; }
  private wallet(): Promise<SDKInterface> {
    return this.sdk ??= SDK.create({ ledgerProvider: this.transport, logAdapter: silentLogger }).catch(e => { this.sdk = undefined; throw e; });
  }
  private async key(): Promise<string> {
    const key = process.env[this.config.signingKeyEnv];
    if (!key) throw new Fault('configuration', 'Signing key environment variable is unset');
    if (!this.fingerprintVerified) {
      try {
        const offline = SDK.createOffline({ logAdapter: silentLogger });
        if (await offline.keys.fingerprint(getPublicKeyFromPrivate(key)) !== this.config.signingFingerprint) throw new Error('mismatch');
      } catch { throw new Fault('configuration', 'Signing key does not match configured fingerprint'); }
      this.fingerprintVerified = true;
    }
    return key;
  }
  async preflight(): Promise<unknown> {
    await this.wallet();
    await this.key();
    const participant = z.object({ participantId: z.string() }).parse(await this.transport.raw('GET', '/v2/parties/participant-id'));
    if (participant.participantId !== this.config.endpoints[this.endpoint].participantId) throw new Fault('configuration', 'Participant identity differs from configuration');
    const syncs = z.object({ connectedSynchronizers: z.array(z.object({ synchronizerId: z.string() })).optional() }).parse(await this.transport.raw('GET', '/v2/state/connected-synchronizers', undefined, { party: this.config.party }));
    if (!syncs.connectedSynchronizers?.some(s => s.synchronizerId === this.config.synchronizerId)) throw new Fault('configuration', 'Configured party is not connected to the expected synchronizer');
    const pkg = z.object({ packageStatus: z.string() }).parse(await this.transport.raw('GET', `/v2/packages/${this.config.packageId}/status`));
    if (pkg.packageStatus !== 'PACKAGE_STATUS_REGISTERED') throw new Fault('configuration', 'Test package is not registered');
    await this.snapshot('__preflight__');
    return { endpoint: this.endpoint, participantId: participant.participantId, packageRegistered: true, readsAvailable: true, topology: this.config.topologyConfirmed ? 'operator-attested' : 'not-confirmed', writes: 'not-tested' };
  }
  async snapshot(runId: string): Promise<Snapshot> {
    const end = z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(await this.transport.raw('GET', '/v2/state/ledger-end'));
    const snapshot: Snapshot = { endpoint: this.endpoint, offset: end.offset, states: [], receipts: [] };
    let pageToken: string | undefined;
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (let pages = 0; pages < 10000; pages++) {
      const page = z.object({ activeAtOffset: z.number(), nextPageToken: z.string().optional(), activeContracts: z.array(z.unknown()) }).parse(await this.transport.raw('POST', '/v2/state/active-contracts-page', {
        activeAtOffset: end.offset, maxPageSize: 200, ...(pageToken ? { pageToken } : {}),
        eventFormat: { filtersByParty: { [this.config.party]: { cumulative: ['RunState', 'Receipt'].map(name => ({ identifierFilter: { TemplateFilter: { value: { templateId: `${this.config.packageId}:Failover:${name}`, includeCreatedEventBlob: false } } } })) } }, verbose: true },
      }));
      if (page.activeAtOffset !== end.offset) throw new Fault('integrity', 'Snapshot offset changed between pages');
      for (const raw of page.activeContracts) {
        const entry = z.object({ contractEntry: z.object({ JsActiveContract: z.object({ synchronizerId: z.string(), createdEvent: z.object({ contractId: z.string(), templateId: z.string(), createArgument: z.unknown() }) }) }) }).safeParse(raw);
        if (!entry.success) throw new Fault('integrity', 'Incomplete or unsupported active-contract response');
        const ac = entry.data.contractEntry.JsActiveContract;
        if (ac.synchronizerId !== this.config.synchronizerId) throw new Fault('integrity', 'Contract is assigned to an unexpected synchronizer');
        const e = ac.createdEvent;
        if (ids.has(e.contractId)) throw new Fault('integrity', 'Repeated contract in paginated snapshot');
        ids.add(e.contractId);
        if (e.templateId === `${this.config.packageId}:Failover:RunState`) {
          const s = stateSchema.parse(e.createArgument); if (s.runId === runId) snapshot.states.push({ contractId: e.contractId, ...s });
        } else if (e.templateId === `${this.config.packageId}:Failover:Receipt`) {
          const r = receiptSchema.parse(e.createArgument); if (r.runId === runId) snapshot.receipts.push({ contractId: e.contractId, ...r });
        } else throw new Fault('integrity', 'Unexpected template in snapshot');
      }
      if (!page.nextPageToken) return snapshot;
      if (seen.has(page.nextPageToken)) throw new Fault('integrity', 'Repeated pagination token');
      seen.add(page.nextPageToken); pageToken = page.nextPageToken;
    }
    throw new Fault('integrity', 'Snapshot exceeded pagination bound');
  }
  async create(runId: string, beforeExecute: () => string): Promise<void> {
    await this.submit(`${runId}:init`, { CreateCommand: { templateId: `${this.config.packageId}:Failover:RunState`, createArguments: { owner: this.config.party, runId, nextSequence: '1', previousReceiptId: null } } }, beforeExecute);
  }
  async advance(runId: string, op: Operation, beforeExecute: () => string): Promise<void> {
    await this.submit(`${runId}:${op.sequence}`, { ExerciseCommand: { templateId: `${this.config.packageId}:Failover:RunState`, contractId: op.inputStateId, choice: 'Advance', choiceArgument: { sequence: String(op.sequence), payloadDigest: op.payloadDigest } } }, beforeExecute);
  }
  private async submit(commandId: string, command: unknown, beforeExecute: () => string): Promise<void> {
    const sdk = await this.wallet();
    const key = await this.key();
    const prepared = await sdk.ledger.prepare({ partyId: this.config.party, synchronizerId: this.config.synchronizerId, commands: [command], commandId }).toJSON();
    const response = z.object({ preparedTransaction: z.string().min(1), preparedTransactionHash: z.base64().min(1), hashingSchemeVersion: z.string().regex(/^HASHING_SCHEME_VERSION_V[1-9]\d*$/) }).parse(prepared.response);
    const signature = signTransactionHash(response.preparedTransactionHash, key);
    // SDK 1.5.3 execute hardcodes hash V2 and infers fingerprint from party ID.
    // Preserve the actual prepare version and configured signing fingerprint here.
    const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await this.transport.raw('GET', '/v2/authenticated-user')).user.id;
    const submissionId = beforeExecute();
    await this.transport.raw('POST', '/v2/interactive-submission/executeAndWait', {
      userId,
      preparedTransaction: response.preparedTransaction, hashingSchemeVersion: response.hashingSchemeVersion,
      submissionId, deduplicationPeriod: { Empty: {} },
      partySignatures: { signatures: [{ party: this.config.party, signatures: [{ signature, signedBy: this.config.signingFingerprint, format: 'SIGNATURE_FORMAT_CONCAT', signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519' }] }] },
    });
  }
}
