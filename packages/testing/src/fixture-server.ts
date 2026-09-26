import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * Local fixture HTTP server for feed/page tests (spec 01 §6: no internet in tests). It serves files
 * from a root directory and scripted responses (statuses, redirects, headers, delays) on a random
 * loopback port, and records every request. Safe-fetch tests reach it with FETCH_ALLOW_PRIVATE.
 */
export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Serve this file (relative to the root) as the body. */
  file?: string;
  delayMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  at: Date;
}

export type Responder =
  ScriptedResponse | ((request: RecordedRequest, hit: number) => ScriptedResponse);

export interface FixtureServer {
  readonly origin: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  url(pathname: string): string;
  /** Script the response for an exact path (query string ignored); later calls replace it. */
  route(pathname: string, responder: Responder): void;
  redirect(from: string, to: string, status?: 301 | 302 | 303 | 307 | 308): void;
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** Directory served for unscripted paths. */
  root?: string;
  host?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.xml': 'application/xml; charset=utf-8',
  '.rss': 'application/rss+xml; charset=utf-8',
  '.atom': 'application/atom+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.opml': 'text/x-opml; charset=utf-8',
};

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const root = options.root === undefined ? undefined : path.resolve(options.root);
  const routes = new Map<string, Responder>();
  const hits = new Map<string, number>();
  const requests: RecordedRequest[] = [];

  const readRootFile = async (relative: string): Promise<Buffer | undefined> => {
    if (root === undefined) return undefined;
    const target = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return undefined;
    try {
      return await readFile(target);
    } catch {
      return undefined;
    }
  };

  const send = async (
    res: ServerResponse,
    method: string,
    scripted: ScriptedResponse,
  ): Promise<void> => {
    if (scripted.delayMs !== undefined) await new Promise((r) => setTimeout(r, scripted.delayMs));
    let body: Uint8Array | string | undefined = scripted.body;
    const headers: Record<string, string> = { ...(scripted.headers ?? {}) };
    if (scripted.file !== undefined) {
      const content = await readRootFile(scripted.file);
      if (content === undefined) {
        res
          .writeHead(500, { 'content-type': 'text/plain' })
          .end(`missing fixture ${scripted.file}`);
        return;
      }
      body = content;
      headers['content-type'] ??=
        CONTENT_TYPES[path.extname(scripted.file)] ?? 'application/octet-stream';
    }
    res.writeHead(scripted.status ?? 200, headers);
    res.end(method === 'HEAD' ? undefined : body);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      at: new Date(),
    };
    requests.push(recorded);
    const handle = async (): Promise<void> => {
      const responder = routes.get(url.pathname);
      if (responder !== undefined) {
        const hit = (hits.get(url.pathname) ?? 0) + 1;
        hits.set(url.pathname, hit);
        await send(
          res,
          recorded.method,
          typeof responder === 'function' ? responder(recorded, hit) : responder,
        );
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative !== '' && (await readRootFile(relative)) !== undefined) {
        await send(res, recorded.method, { file: relative });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    };
    handle().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host}:${port}`;

  return {
    origin,
    port,
    requests,
    url: (pathname) => new URL(pathname, origin).toString(),
    route: (pathname, responder) => {
      routes.set(pathname, responder);
      hits.delete(pathname);
    },
    redirect: (from, to, status = 301) => {
      routes.set(from, { status, headers: { location: to } });
    },
    reset: () => {
      routes.clear();
      hits.clear();
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
