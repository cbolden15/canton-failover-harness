import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const endpointIds = ['A', 'B'] as const;
export type EndpointId = typeof endpointIds[number];
const safeUrl = z.url().refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.search && !u.hash &&
    (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
}, 'Use HTTPS, or HTTP on loopback only; no credentials or query parameters in URLs');
export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oidc'), tokenUrl: safeUrl, clientId: z.string().min(1), clientSecretEnv: z.string().min(1), tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'), audience: z.string().min(1).optional(), scope: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal('auth0'), tokenUrl: safeUrl, audience: z.string().min(1), clientId: z.string().min(1), clientSecretEnv: z.string().min(1), scope: z.string().optional() }).strict(),
  z.object({ type: z.literal('static'), tokenEnv: z.string().min(1) }).strict(),
]);
const endpoint = z.object({ url: safeUrl, participantId: z.string().min(1), auth: authSchema }).strict();
export const scenarioSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline') }).strict(),
  z.object({ type: z.literal('failover'), faultedEndpoint: z.enum(endpointIds), minSurvivorOperations: z.number().int().positive(), recoveryTimeoutMs: z.number().int().positive() }).strict(),
]);
export type Scenario = z.infer<typeof scenarioSchema>;
export const configSchema = z.object({
  mode: z.enum(['testnet', 'simulation']),
  scenario: scenarioSchema.default({ type: 'baseline' }),
  party: z.string().min(1), synchronizerId: z.string().min(1), packageId: z.string().regex(/^[a-f0-9]{64}$/),
  signingKeyEnv: z.string().min(1), signingFingerprint: z.string().min(1),
  endpoints: z.object({ A: endpoint, B: endpoint }).strict(),
  topologyConfirmed: z.boolean().default(false),
  primary: z.enum(endpointIds).default('A'), count: z.number().int().min(1).max(10000).default(300),
  intervalMs: z.number().int().min(0).default(2000), requestTimeoutMs: z.number().int().min(50).max(120000).default(10000),
  pollMs: z.number().int().min(1).default(2000), failureThreshold: z.number().int().min(1).max(10).default(2),
  retryAfterMs: z.number().int().min(0).default(10000), operationTimeoutMs: z.number().int().min(100).default(120000),
  runTimeoutMs: z.number().int().min(100).default(1800000), convergenceTimeoutMs: z.number().int().min(50).default(120000),
}).strict().superRefine((c, ctx) => {
  if (c.scenario.type === 'failover' && c.scenario.minSurvivorOperations > c.count)
    ctx.addIssue({ code: 'custom', message: 'minSurvivorOperations must not exceed operation count' });
  if (c.endpoints.A.url === c.endpoints.B.url || c.endpoints.A.participantId === c.endpoints.B.participantId)
    ctx.addIssue({ code: 'custom', message: 'A and B must identify distinct participants and endpoints' });
});
export type Config = z.infer<typeof configSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export const loadConfig = (path: string): Config => configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
export const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
export const operationDigest = (runId: string, sequence: number): string => digest(`${runId}:${sequence}`);
export const identity = (c: Config): string => digest(JSON.stringify({ mode: c.mode, party: c.party, synchronizerId: c.synchronizerId, packageId: c.packageId, signingFingerprint: c.signingFingerprint, participants: endpointIds.map(id => c.endpoints[id].participantId) }));
export const alternate = (id: EndpointId): EndpointId => id === 'A' ? 'B' : 'A';
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export type ErrorKind = 'availability' | 'auth' | 'permission' | 'conflict' | 'configuration' | 'integrity' | 'throttled' | 'acceptance';
export class Fault extends Error {
  constructor(public readonly kind: ErrorKind, message: string, public readonly status?: number) { super(message); }
}
export const faultKind = (e: unknown): ErrorKind => e instanceof Fault ? e.kind : 'configuration';

export interface RunState { contractId: string; owner: string; runId: string; nextSequence: number; previousReceiptId: string | null }
export interface Receipt { contractId: string; owner: string; runId: string; sequence: number; operationId: string; payloadDigest: string; inputStateId: string; previousReceiptId: string | null }
export interface Snapshot { endpoint: EndpointId; offset: number; states: RunState[]; receipts: Receipt[] }
export interface Operation { sequence: number; inputStateId: string; payloadDigest: string; status: 'planned' | 'unknown' | 'committed'; receiptId?: string; successorId?: string }

/** Validate a complete run prefix, never infer failure from an empty snapshot. */
export function validateSnapshot(snapshot: Snapshot, runId: string, owner: string, rootId: string | undefined, count: number): { state: RunState; receipts: Receipt[] } | undefined {
  const states = snapshot.states.filter(s => s.runId === runId);
  const receipts = snapshot.receipts.filter(r => r.runId === runId).sort((a, b) => a.sequence - b.sequence);
  if (!states.length && !receipts.length) return undefined;
  const bad = (message: string): never => { throw new Fault('integrity', message); };
  if (states.length !== 1) bad('Run has missing or multiple active state contracts');
  const state = states[0];
  if (state.owner !== owner || receipts.length > count || state.nextSequence !== receipts.length + 1) bad('Run state and receipts disagree');
  let previous: string | null = null;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (r.owner !== owner || r.sequence !== i + 1 || r.operationId !== `${runId}:${i + 1}` || r.payloadDigest !== operationDigest(runId, i + 1) || r.previousReceiptId !== previous)
      bad('Receipt sequence, payload, owner, or chain is inconsistent');
    if (i === 0 && rootId && r.inputStateId !== rootId) bad('Receipt does not descend from pinned root');
    previous = r.contractId;
  }
  if (state.previousReceiptId !== previous) bad('State does not reference the final receipt');
  if (!receipts.length && rootId && state.contractId !== rootId) bad('Unexpected replacement root');
  return { state, receipts };
}
