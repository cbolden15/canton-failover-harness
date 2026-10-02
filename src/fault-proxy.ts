import { createServer, request as httpRequest, type Server, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Config, EndpointId, endpointIds } from './model.js';

/** Loopback reverse proxy: opaque forwarding, connection cuts, and no write retries. */
export class FaultProxy {
  private readonly servers = new Map<EndpointId, Server>();
  private readonly sockets = new Map<EndpointId, Set<Socket>>();
  private readonly requests = new Map<EndpointId, Set<ClientRequest>>();
  readonly blocked = new Set<EndpointId>();
  private readonly capability = randomBytes(24).toString('hex');
  constructor(private readonly config: Config) {}

  async start(): Promise<Config> {
    const endpoints = { ...this.config.endpoints };
    try {
      for (const endpoint of endpointIds) {
        const sockets = new Set<Socket>(), requests = new Set<ClientRequest>();
        this.sockets.set(endpoint, sockets); this.requests.set(endpoint, requests);
        const upstream = new URL(this.config.endpoints[endpoint].url);
        const server = createServer((req, res) => {
          const prefix = `/${this.capability}`;
          if (!req.url?.startsWith(`${prefix}/v2/`) || !['GET', 'POST'].includes(req.method ?? '') ||
            req.headers.origin || req.headers['sec-fetch-site']) {
            res.writeHead(403); res.end(); return;
          }
          if (this.blocked.has(endpoint)) { req.socket.destroy(); return; }
          // Keep the configured base path; never let the request choose an upstream host.
          const target = new URL(upstream.href);
          const incoming = new URL(req.url.slice(prefix.length), 'http://localhost');
          if (!incoming.pathname.startsWith('/v2/')) { res.writeHead(403); res.end(); return; }
          target.pathname = upstream.pathname.replace(/\/$/, '') + incoming.pathname;
          target.search = incoming.search;
          const forward = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
            method: req.method,
            headers: {
              ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
              'content-type': 'application/json', accept: 'application/json',
            },
          }, response => {
            res.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' });
            response.on('error', () => res.destroy());
            response.pipe(res);
          });
          requests.add(forward);
          forward.once('close', () => requests.delete(forward));
          forward.on('error', () => res.destroy());
          forward.setTimeout(this.config.requestTimeoutMs, () => forward.destroy());
          req.once('aborted', () => forward.destroy());
          res.once('close', () => { if (!res.writableFinished) forward.destroy(); });
          req.pipe(forward);
        });
        this.servers.set(endpoint, server);
        server.on('connection', socket => {
          sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        });
        await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Proxy has no loopback address');
        endpoints[endpoint] = { ...endpoints[endpoint], url: `http://127.0.0.1:${address.port}/${this.capability}` };
      }
      return { ...this.config, endpoints };
    } catch (e) { await this.close(); throw e; }
  }

  block(endpoint: EndpointId): void {
    this.blocked.add(endpoint);
    // Requests already sent upstream may have committed. Cutting a connection never means rollback.
    for (const request of this.requests.get(endpoint) ?? []) request.destroy();
    for (const socket of this.sockets.get(endpoint) ?? []) socket.destroy();
  }
  restore(endpoint: EndpointId): void { this.blocked.delete(endpoint); }
  async close(): Promise<void> {
    for (const endpoint of endpointIds) this.block(endpoint);
    await Promise.all([...this.servers.values()].map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
    })));
    this.servers.clear();
  }
}
