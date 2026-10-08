import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Plumbing shared by the fake provider servers (fake TypeSafe, fake Ollama). Internal to
 * `@bantoozi/testing`: not exported from the package entry.
 */

/** A scripted response: a string body is sent verbatim, anything else as JSON. */
export interface FakeHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One request as a fake server records it. */
export interface FakeHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The request body exactly as received. */
  rawBody: string;
  /** The parsed JSON body (undefined when it was not JSON). */
  body: unknown;
}

/** Fake servers refuse larger request bodies. */
export const MAX_FAKE_BODY_BYTES = 16 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property of a parsed JSON object. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Reads and records a request; `rawBody` undefined means it exceeded the size limit. */
export async function readFakeRequest(
  req: IncomingMessage,
): Promise<{ request: FakeHttpRequest; tooLarge: boolean; json: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total <= MAX_FAKE_BODY_BYTES) chunks.push(bytes);
  }
  const tooLarge = total > MAX_FAKE_BODY_BYTES;
  const rawBody = tooLarge ? '' : Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  let json = false;
  if (!tooLarge) {
    try {
      body = JSON.parse(rawBody);
      json = true;
    } catch {
      body = undefined;
    }
  }
  const request: FakeHttpRequest = {
    method: req.method ?? 'GET',
    path: new URL(req.url ?? '/', 'http://fake.local').pathname,
    headers: { ...req.headers },
    rawBody,
    body,
  };
  return { request, tooLarge, json };
}

/**
 * Sends a scripted response unless the client is already gone (e.g. it timed out). Like a real
 * provider's non-streamed JSON, it carries a `content-length` unless `headers` set one.
 */
export function sendFakeResponse(res: ServerResponse, response: FakeHttpResponse): void {
  if (res.destroyed || res.writableEnded) return;
  const text =
    typeof response.body === 'string' ? response.body : (JSON.stringify(response.body) ?? '');
  res.writeHead(response.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    ...(response.headers ?? {}),
  });
  res.end(text);
}

/** Waits `ms` only when it is positive, so a zero latency starts no timer at all. */
export async function fakeLatency(ms: number | undefined): Promise<void> {
  if (ms !== undefined && ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

export function checkLatency(ms: number | undefined, name: string): void {
  if (ms !== undefined && !(Number.isFinite(ms) && ms >= 0)) {
    throw new RangeError(`${name}: latencyMs must be a nonnegative number`);
  }
}

/** Listens on 127.0.0.1 (a random port unless `wanted` is given); returns the base URL. */
export async function listenLoopback(server: Server, wanted = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Wraps an async handler: an unexpected error answers 500 instead of hanging the client. */
export function fakeHandler(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500);
      if (!res.writableEnded) res.end();
    });
  };
}
