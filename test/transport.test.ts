import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Fault, configSchema, authSchema } from '../src/model.js';
import { Transport, TokenCache } from '../src/transport.js';

async function server(t: test.TestContext) {
  const state = { tokens: 0, requests: 0, status: 200, delay: 0, authBody: {} as Record<string, string>, authHeader: '', contentType: '', tokenStatus: 200, tokenBody: undefined as unknown, tokenRaw: undefined as string | undefined, tokenFailure: '' as '' | 'disconnect' | 'headers' | 'body' };
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/oauth/token') {
      state.tokens++; state.authHeader = req.headers.authorization ?? ''; state.contentType = req.headers['content-type'] ?? '';
      const raw = Buffer.concat(chunks).toString();
      state.authBody = state.contentType.includes('application/json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      if (state.tokenFailure === 'disconnect') { req.socket.destroy(); return; }
      if (state.tokenFailure === 'headers') await new Promise(r => setTimeout(r, 150));
      res.statusCode = state.tokenStatus;
      res.setHeader('content-type', 'application/json');
      if (state.tokenFailure === 'body') { res.flushHeaders(); await new Promise(r => setTimeout(r, 150)); }
      res.end(state.tokenRaw ?? JSON.stringify(state.tokenBody === undefined ? { access_token: `token-${state.tokens}`, expires_in: 3600, token_type: 'Bearer' } : state.tokenBody)); return;
    }
    state.requests++;
    if (state.delay) await new Promise(r => setTimeout(r, state.delay));
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'TEST', secret: 'never-print-server-secrets' }));
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); delete process.env.TEST_CLIENT_SECRET; });
  const port = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  process.env.TEST_CLIENT_SECRET = 'test-client-secret';
  const auth = { type: 'auth0', tokenUrl: `${url}/oauth/token`, audience: 'test-audience', clientId: 'test-id', clientSecretEnv: 'TEST_CLIENT_SECRET' };
  const config = configSchema.parse({ mode: 'simulation', party: 'test', synchronizerId: 'sync', packageId: 'a'.repeat(64), signingKeyEnv: 'TEST_KEY', signingFingerprint: 'fingerprint', requestTimeoutMs: 50, endpoints: { A: { url, participantId: 'A', auth }, B: { url: `${url}/b`, participantId: 'B', auth } } });
  return { state, config };
}

test('Auth0 concurrent requests share one token acquisition and reuse the cache', async t => {
  const f = await server(t); const cache = new TokenCache(f.config.endpoints.A.auth, 1000);
  assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), ['token-1', 'token-1', 'token-1']);
  assert.equal(await cache.get(), 'token-1'); assert.equal(f.state.tokens, 1);
  assert.equal(f.state.authBody.grant_type, 'client_credentials');
  assert.equal(f.state.authBody.client_secret, 'test-client-secret');
  cache.invalidate(); assert.equal(await cache.get(), 'token-2');
});

test('GET authentication failure refreshes once; execute POST never automatically replays', async t => {
  const f = await server(t); const transport = new Transport('A', f.config); f.state.status = 401;
  await assert.rejects(transport.raw('GET', '/v2/state/ledger-end'), (e: unknown) => e instanceof Fault && e.kind === 'auth');
  assert.equal(f.state.requests, 2); assert.equal(f.state.tokens, 2);
  f.state.requests = 0;
  await assert.rejects(transport.raw('POST', '/v2/interactive-submission/executeAndWait', {}), (e: unknown) => e instanceof Fault && e.kind === 'auth');
  assert.equal(f.state.requests, 1);
});

test('permission and rate limits remain separate from availability; response bodies stay out of errors', async t => {
  const f = await server(t); const transport = new Transport('A', f.config);
  for (const [status, kind] of [[403, 'permission'], [429, 'throttled'], [503, 'availability'], [400, 'configuration']] as const) {
    f.state.status = status;
    await assert.rejects(transport.raw('GET', '/v2/state/ledger-end'), (e: unknown) => e instanceof Fault && e.kind === kind && !e.message.includes('never-print'));
  }
});

test('timeouts include the response body and obey the operation deadline', async t => {
  const f = await server(t); const transport = new Transport('A', { ...f.config, requestTimeoutMs: 1000 });
  f.state.delay = 300; transport.deadline = Date.now() + 80;
  const start = Date.now();
  await assert.rejects(transport.raw('GET', '/v2/state/ledger-end'), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.ok(Date.now() - start < 250);
});

for (const method of ['client_secret_basic', 'client_secret_post'] as const) {
  test(`OIDC ${method} encodes credentials and optional scope/audience correctly`, async t => {
    const f = await server(t);
    const auth = authSchema.parse({ type: 'oidc', tokenUrl: f.config.endpoints.A.auth.type === 'auth0' ? f.config.endpoints.A.auth.tokenUrl : '', clientId: 'id: a+&', clientSecretEnv: 'TEST_CLIENT_SECRET', tokenEndpointAuthMethod: method, scope: 'ledger.read ledger.execute', audience: 'https://ledger.example/api' });
    process.env.TEST_CLIENT_SECRET = 'secret: +&=';
    const cache = new TokenCache(auth, 1000);
    assert.equal(await cache.get(), 'token-1');
    assert.equal(f.state.contentType, 'application/x-www-form-urlencoded');
    assert.equal(f.state.authBody.grant_type, 'client_credentials');
    assert.equal(f.state.authBody.scope, 'ledger.read ledger.execute');
    assert.equal(f.state.authBody.audience, 'https://ledger.example/api');
    if (method === 'client_secret_basic') {
      assert.equal(Buffer.from(f.state.authHeader.slice(6), 'base64').toString(), 'id%3A+a%2B%26:secret%3A+%2B%26%3D');
      assert.equal(f.state.authBody.client_secret, undefined); assert.equal(f.state.authBody.client_id, undefined);
    } else {
      assert.equal(f.state.authHeader, ''); assert.equal(f.state.authBody.client_id, 'id: a+&');
      assert.equal(f.state.authBody.client_secret, 'secret: +&=');
    }
    assert.equal(await cache.get(), 'token-1'); assert.equal(f.state.tokens, 1);
  });
}

test('OIDC without audience/scope, token renewal, and independent endpoint caches', async t => {
  const f = await server(t);
  const base = f.config.endpoints.A.auth;
  assert.equal(base.type, 'auth0'); if (base.type !== 'auth0') return;
  const auth = authSchema.parse({ type: 'oidc', tokenUrl: base.tokenUrl, clientId: base.clientId, clientSecretEnv: base.clientSecretEnv });
  const a = new TokenCache(auth, 1000); const b = new TokenCache(auth, 1000);
  f.state.tokenBody = { access_token: 'short-token', token_type: 'Bearer', expires_in: 0.01 };
  await a.get(); assert.equal(f.state.authBody.audience, undefined); assert.equal(f.state.authBody.scope, undefined);
  await new Promise(r => setTimeout(r, 20));
  await a.get(); assert.equal(f.state.tokens, 2);
  await b.get(); assert.equal(f.state.tokens, 3);
});

test('OIDC rejects invalid token responses and redacts provider errors', async t => {
  const f = await server(t); const base = f.config.endpoints.A.auth;
  if (base.type !== 'auth0') throw new Error('fixture');
  const auth = authSchema.parse({ type: 'oidc', tokenUrl: base.tokenUrl, clientId: base.clientId, clientSecretEnv: base.clientSecretEnv });
  for (const body of [null, [], 42, 'secret', { access_token: 42, token_type: 'Bearer', expires_in: 3600 }, { access_token: 'secret', token_type: 'Bearer', expires_in: 0 }, { access_token: 'secret', token_type: 'MAC', expires_in: 3600 }]) {
    f.state.tokenBody = body;
    await assert.rejects(new TokenCache(auth, 1000).get(), (e: unknown) => e instanceof Fault && e.kind === 'auth' && !e.message.includes('secret'));
  }
  f.state.tokenStatus = 401; f.state.tokenBody = { error_description: 'secret-private-provider-details' };
  await assert.rejects(new TokenCache(auth, 1000).get(), (e: unknown) => e instanceof Fault && e.kind === 'auth' && !e.message.includes('private-provider'));
});

test('IdP server failures and throttling preserve distinct recoverable classifications without retries', async t => {
  const f = await server(t);
  f.state.tokenBody = { error_description: 'secret-private-provider-details' };
  for (const [status, kind] of [[500, 'availability'], [503, 'availability'], [429, 'throttled'], [400, 'auth'], [401, 'auth'], [403, 'auth']] as const) {
    f.state.tokenStatus = status;
    const before = f.state.tokens;
    await assert.rejects(new TokenCache(f.config.endpoints.A.auth, 1000).get(), (e: unknown) => e instanceof Fault && e.kind === kind && e.status === status && !e.message.includes('private-provider'));
    assert.equal(f.state.tokens, before + 1, 'token POST must not retry internally');
    assert.equal(f.state.requests, 0, 'failed token acquisition must not send a participant request');
  }
});

test('IdP disconnects, request timeouts, and response body timeouts are availability', async t => {
  const f = await server(t);
  for (const failure of ['disconnect', 'headers', 'body'] as const) {
    f.state.tokenFailure = failure;
    const before = f.state.tokens;
    await assert.rejects(new TokenCache(f.config.endpoints.A.auth, 40).get(), (e: unknown) => e instanceof Fault && e.kind === 'availability' && !e.message.includes('test-client-secret'));
    assert.equal(f.state.tokens, before + 1);
  }
});

test('IdP operation deadline is availability while missing secret and invalid JSON remain auth', async t => {
  const f = await server(t);
  const cache = new TokenCache(f.config.endpoints.A.auth, 1000);
  await assert.rejects(cache.get(Date.now() - 1), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.equal(f.state.tokens, 0);
  f.state.tokenFailure = 'body';
  const started = Date.now();
  await assert.rejects(cache.get(Date.now() + 40), (e: unknown) => e instanceof Fault && e.kind === 'availability');
  assert.ok(Date.now() - started < 500, 'body acquisition must obey the operation deadline');
  f.state.tokenFailure = ''; f.state.tokenRaw = '{secret-private-provider-details';
  await assert.rejects(cache.get(), (e: unknown) => e instanceof Fault && e.kind === 'auth' && !e.message.includes('private-provider'));
  delete process.env.TEST_CLIENT_SECRET;
  const before = f.state.tokens;
  await assert.rejects(cache.get(), (e: unknown) => e instanceof Fault && e.kind === 'auth');
  assert.equal(f.state.tokens, before);
});

test('OIDC rejects insecure URLs, unsupported auth methods, and inline secrets', () => {
  const base = { type: 'oidc', tokenUrl: 'https://idp.example/token', clientId: 'client', clientSecretEnv: 'SECRET' };
  for (const change of [{ tokenUrl: 'http://idp.example/token' }, { tokenEndpointAuthMethod: 'none' }, { clientSecret: 'inline-secret' }]) {
    assert.equal(authSchema.safeParse({ ...base, ...change }).success, false);
  }
});

test('all published provider examples and the full config validate', () => {
  for (const provider of ['keycloak', 'okta', 'auth0']) {
    const example = JSON.parse(readFileSync(new URL(`../examples/auth/${provider}.json`, import.meta.url), 'utf8'));
    assert.equal(authSchema.parse(example).type, 'oidc');
  }
  const config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(configSchema.parse(config).endpoints.A.auth.type, 'oidc');
});
