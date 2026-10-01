import { AbstractProvider } from '@canton-network/core-splice-provider';
import type { DappLedgerRpc as LedgerTypes } from '@canton-network/core-provider-dapp';
import type { RequestArgs } from '@canton-network/core-types';
import { AuthConfig, Fault, Config, EndpointId } from './model.js';

export class TokenCache {
  private token?: { value: string; expires: number };
  private pending?: Promise<string>;
  constructor(private readonly auth: AuthConfig, private readonly timeoutMs: number) {}
  invalidate(): void { this.token = undefined; }
  async get(deadline = Infinity): Promise<string> {
    if (this.auth.type === 'static') {
      const token = process.env[this.auth.tokenEnv];
      if (!token) throw new Fault('auth', 'Configured token environment variable is unset');
      return token;
    }
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    if (this.pending) return this.pending;
    this.pending = this.acquire(deadline).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async acquire(deadline: number): Promise<string> {
    if (this.auth.type === 'static') throw new Error('Expected client credentials configuration');
    const secret = process.env[this.auth.clientSecretEnv];
    if (!secret) throw new Fault('auth', 'Configured client secret environment variable is unset');
    const remaining = Math.min(this.timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new Fault('availability', 'Token request deadline reached');
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string;
    if (this.auth.type === 'auth0') {
      // Preserve existing Auth0 configurations and their JSON request format.
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ grant_type: 'client_credentials', client_id: this.auth.clientId, client_secret: secret, audience: this.auth.audience, ...(this.auth.scope ? { scope: this.auth.scope } : {}) });
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams({ grant_type: 'client_credentials' });
      if (this.auth.scope) form.set('scope', this.auth.scope);
      if (this.auth.audience) form.set('audience', this.auth.audience);
      if (this.auth.tokenEndpointAuthMethod === 'client_secret_post') {
        form.set('client_id', this.auth.clientId); form.set('client_secret', secret);
      } else {
        // RFC 6749 section 2.3.1 requires form-encoding each credential first.
        const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
        headers.authorization = `Basic ${Buffer.from(`${encode(this.auth.clientId)}:${encode(secret)}`).toString('base64')}`;
      }
      body = form.toString();
    }
    let response: Response;
    try {
      response = await fetch(this.auth.tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.ceil(remaining)),
        headers, body,
      });
    } catch { throw new Fault('availability', 'Identity provider token request failed or timed out'); }
    if (response.status === 429) throw new Fault('throttled', 'Identity provider rate limited the token request', 429);
    if (response.status >= 500) throw new Fault('availability', 'Identity provider returned a server error', response.status);
    if (!response.ok) throw new Fault('auth', `Identity provider rejected token request (${response.status})`, response.status);
    let text: string;
    try { text = await response.text(); }
    catch { throw new Fault('availability', 'Identity provider token response failed or timed out'); }
    let data: { access_token?: string; expires_in?: number; token_type?: string };
    try { data = JSON.parse(text); }
    catch { throw new Fault('auth', 'Identity provider returned invalid JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.access_token !== 'string' || !data.access_token.trim() || typeof data.token_type !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in! <= 0 || data.token_type.toLowerCase() !== 'bearer') throw new Fault('auth', 'Identity provider returned an invalid token response');
    const ttl = data.expires_in! * 1000;
    this.token = { value: data.access_token, expires: Date.now() + ttl - Math.min(60000, ttl * 0.1) };
    return data.access_token;
  }
}

export class Transport extends AbstractProvider<LedgerTypes> {
  readonly tokens: TokenCache;
  deadline = Infinity;
  constructor(readonly endpoint: EndpointId, private readonly config: Config) {
    super(); this.tokens = new TokenCache(config.endpoints[endpoint].auth, config.requestTimeoutMs);
  }
  async request<M extends keyof LedgerTypes>(args: RequestArgs<LedgerTypes, M>): Promise<LedgerTypes[M]['result']> {
    if (args.method !== 'ledgerApi') throw new Fault('configuration', 'Unsupported SDK provider method');
    const p = args.params as { resource: string; requestMethod: string; body?: unknown; query?: Record<string, unknown>; path?: Record<string, string> };
    let resource = p.resource;
    for (const [k, v] of Object.entries(p.path ?? {})) resource = resource.replace(`{${k}}`, encodeURIComponent(v));
    return await this.raw(p.requestMethod.toUpperCase(), resource, p.body, p.query) as LedgerTypes[M]['result'];
  }
  async raw(method: string, resource: string, body?: unknown, query?: Record<string, unknown>, retryReadAuth = true): Promise<unknown> {
    if (!resource.startsWith('/v2/')) throw new Fault('configuration', 'Unsupported Ledger API route');
    const endpoint = this.config.endpoints[this.endpoint];
    const url = new URL(endpoint.url.replace(/\/$/, '') + resource);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const token = await this.tokens.get(this.deadline);
    const remaining = Math.min(this.config.requestTimeoutMs, this.deadline - Date.now());
    if (remaining <= 0) throw new Fault('availability', 'Request deadline reached');
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(Math.ceil(remaining)), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      text = await response.text();
    } catch { throw new Fault('availability', 'Participant request failed or timed out'); }
    if (response.status === 401) {
      this.tokens.invalidate();
      if (method === 'GET' && retryReadAuth) return this.raw(method, resource, body, query, false);
      throw new Fault('auth', 'Participant rejected authentication', 401);
    }
    if (response.status === 403) throw new Fault('permission', 'Participant denied access', 403);
    if (response.status === 429) throw new Fault('throttled', 'Participant rate limited the request', 429);
    if (response.status >= 500) throw new Fault('availability', 'Participant returned a server error', response.status);
    if (!response.ok) {
      // Inspect only the structured code. Never put response bodies in logs or errors.
      let code = '';
      try { code = String(JSON.parse(text).code ?? ''); } catch { /* non-JSON rejection */ }
      const conflict = response.status === 409 || /CONTRACT_NOT_FOUND|CONTRACT_NOT_ACTIVE|INACTIVE_CONTRACT|DUPLICATE_COMMAND|SUBMISSION_ALREADY_IN_FLIGHT/.test(code);
      throw new Fault(conflict ? 'conflict' : 'configuration', `Ledger API rejected request (${response.status})`, response.status);
    }
    try { return JSON.parse(text); } catch { throw new Fault('configuration', 'Ledger API returned invalid JSON'); }
  }
}
