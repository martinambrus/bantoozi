import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { closeServer, listenLoopback } from '../fake-http.js';
import type { FakeTypeSafeOptions, FakeTypeSafeServer } from '../fake-typesafe.js';
import { E2E_FEED_KEYS, isE2eFeedKey, type E2eFeedKey } from './env.js';
import { FeedInputError, type E2eFeed } from './feeds.js';
import { HookParamsError, runSqlHook, UnknownHookError, type HookDb } from './hooks.js';

/**
 * The control API of the E2E environment: JSON over HTTP on 127.0.0.1, so a Playwright spec (which
 * can only talk HTTP) can steer the fixture feeds and the fake TypeSafe server and read database
 * state through the named SQL hooks. `apps/web/e2e/support/control.ts` is its typed client.
 *
 * - `GET /ready`, `GET /worker-ready` (200 once a worker heartbeat and the `feed.schedule` cron exist)
 * - `GET /feeds`, `POST /feeds/:key/items`, `POST /feeds/:key/routes`, `GET /feeds/:key/requests`
 * - `GET /fake` (requests since the last reset), `POST /fake/options`
 * - `POST /reset`, `POST /sql/:hook`
 */

export interface ControlOptions {
  /** 0 picks a free port. */
  port: number;
  feeds: Readonly<Record<E2eFeedKey, E2eFeed>>;
  fake: FakeTypeSafeServer;
  /** The fake's options at start-up: `POST /reset` restores them. */
  fakeDefaults: FakeTypeSafeOptions;
  db: HookDb;
}

export interface ControlApi {
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Reply {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'the request body is not valid JSON');
  }
}

/** A JSON object body restricted to `allowed` keys; an absent body counts as `{}`. */
function objectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'the request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'invalid_body', `unknown field: ${unknown.join(', ')}`);
  }
  return body as Record<string, unknown>;
}

function optional<T>(
  value: unknown,
  name: string,
  check: (v: unknown) => v is T,
  expected: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!check(value)) throw new HttpError(400, 'invalid_body', `${name} must be ${expected}`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const MAX_LATENCY_MS = 60_000;

const WORKER_READY_SQL = `SELECT
  EXISTS (SELECT 1 FROM settings WHERE key = 'worker.heartbeat' AND value <> '{}'::jsonb) AS "heartbeat",
  EXISTS (SELECT 1 FROM pgboss.schedule WHERE name = 'feed.schedule') AS "schedule"`;

function fakeView(options: FakeTypeSafeOptions): Record<string, unknown> {
  return {
    latencyMs: options.latencyMs ?? 0,
    failRate: options.failRate ?? 0,
    failStatus: options.failStatus ?? null,
    apiKeyRequired: options.apiKey !== undefined,
  };
}

export async function startControlApi(options: ControlOptions): Promise<ControlApi> {
  const { feeds, fake, db } = options;
  let fakeCurrent: FakeTypeSafeOptions = { ...options.fakeDefaults };
  let fakeBaseline = fake.requestCount();

  const feed = (key: string | undefined): E2eFeed => {
    if (!isE2eFeedKey(key)) {
      throw new HttpError(
        404,
        'unknown_feed',
        `feed key must be one of ${E2E_FEED_KEYS.join(', ')}`,
      );
    }
    return feeds[key];
  };

  const feedView = (f: E2eFeed): Record<string, unknown> => ({
    key: f.key,
    title: f.title,
    origin: f.origin,
    url: f.url,
    items: f.items(),
  });

  const routes: Array<{
    method: 'GET' | 'POST';
    pattern: RegExp;
    handle(params: string[], body: unknown): Promise<Reply> | Reply;
  }> = [
    { method: 'GET', pattern: /^\/ready$/, handle: () => ok({ ready: true }) },
    {
      method: 'GET',
      pattern: /^\/worker-ready$/,
      async handle() {
        try {
          const { rows } = await db.query(WORKER_READY_SQL);
          const row = rows[0] as { heartbeat: boolean; schedule: boolean } | undefined;
          const ready = row?.heartbeat === true && row.schedule === true;
          return ok(
            { ready, heartbeat: row?.heartbeat ?? false, schedule: row?.schedule ?? false },
            ready ? 200 : 503,
          );
        } catch (error) {
          return ok({ ready: false, error: String(error) }, 503);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/feeds$/,
      handle: () =>
        ok({ feeds: Object.fromEntries(E2E_FEED_KEYS.map((key) => [key, feedView(feeds[key])])) }),
    },
    {
      method: 'POST',
      pattern: /^\/feeds\/([^/]+)\/items$/,
      handle([key], body) {
        const target = feed(key);
        const fields = objectBody(body, [
          'title',
          'excerpt',
          'slug',
          'topic',
          'image',
          'publishedAt',
        ]);
        const title = optional(fields['title'], 'title', isString, 'a string');
        if (title === undefined) throw new HttpError(400, 'invalid_body', 'title is required');
        return ok(
          target.append({
            title,
            excerpt: optional(fields['excerpt'], 'excerpt', isString, 'a string'),
            slug: optional(fields['slug'], 'slug', isString, 'a string'),
            topic: optional(fields['topic'], 'topic', isString, 'a string'),
            image: optional(fields['image'], 'image', isBoolean, 'a boolean'),
            publishedAt: optional(fields['publishedAt'], 'publishedAt', isString, 'a string'),
          }),
          201,
        );
      },
    },
    {
      method: 'POST',
      pattern: /^\/feeds\/([^/]+)\/routes$/,
      handle([key], body) {
        const target = feed(key);
        const fields = objectBody(body, ['path', 'status']);
        const path = optional(fields['path'], 'path', isString, 'a string');
        const status = fields['status'];
        if (path === undefined || status === undefined) {
          throw new HttpError(400, 'invalid_body', 'path and status are required');
        }
        if (status !== null && !isNumber(status)) {
          throw new HttpError(400, 'invalid_body', 'status must be a number or null');
        }
        target.script(path, status);
        return ok({ path, status });
      },
    },
    {
      method: 'GET',
      pattern: /^\/feeds\/([^/]+)\/requests$/,
      handle: ([key]) => ok({ requests: feed(key).requests() }),
    },
    {
      method: 'GET',
      pattern: /^\/fake$/,
      handle: () => ok({ count: fake.requestCount() - fakeBaseline }),
    },
    {
      method: 'POST',
      pattern: /^\/fake\/options$/,
      handle(_params, body) {
        const fields = objectBody(body, ['latencyMs', 'failStatus', 'failRate', 'apiKey']);
        const latencyMs = optional(fields['latencyMs'], 'latencyMs', isNumber, 'a number');
        const failRate = optional(fields['failRate'], 'failRate', isNumber, 'a number');
        const failStatus = optional(fields['failStatus'], 'failStatus', isNumber, 'a number');
        const apiKey = fields['apiKey'];
        if (apiKey !== undefined && apiKey !== null && !isString(apiKey)) {
          throw new HttpError(400, 'invalid_body', 'apiKey must be a string or null');
        }
        if (latencyMs !== undefined && (latencyMs < 0 || latencyMs > MAX_LATENCY_MS)) {
          throw new HttpError(400, 'invalid_body', `latencyMs must be 0-${MAX_LATENCY_MS}`);
        }
        if (
          failStatus !== undefined &&
          !(Number.isInteger(failStatus) && failStatus >= 400 && failStatus <= 599)
        ) {
          throw new HttpError(400, 'invalid_body', 'failStatus must be an integer from 400 to 599');
        }
        const patch: Partial<FakeTypeSafeOptions> = {
          ...(latencyMs === undefined ? {} : { latencyMs }),
          ...(failRate === undefined ? {} : { failRate }),
          ...(failStatus === undefined ? {} : { failStatus }),
          ...(apiKey === undefined
            ? {}
            : { apiKey: apiKey === null || apiKey === '' ? undefined : apiKey }),
        };
        try {
          fake.setOptions(patch);
        } catch (error) {
          throw new HttpError(
            400,
            'invalid_body',
            error instanceof Error ? error.message : String(error),
          );
        }
        fakeCurrent = { ...fakeCurrent, ...patch };
        return ok({ options: fakeView(fakeCurrent) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/reset$/,
      handle(_params, body) {
        objectBody(body, []);
        for (const key of E2E_FEED_KEYS) feeds[key].reset();
        fakeCurrent = {
          latencyMs: undefined,
          failRate: undefined,
          failStatus: undefined,
          apiKey: undefined,
          ...options.fakeDefaults,
        };
        fake.setOptions(fakeCurrent);
        fakeBaseline = fake.requestCount();
        return ok({ reset: true });
      },
    },
    {
      method: 'POST',
      pattern: /^\/sql\/([^/]+)$/,
      async handle([name], body) {
        try {
          return ok(await runSqlHook(db, name ?? '', body ?? {}));
        } catch (error) {
          if (error instanceof HookParamsError)
            throw new HttpError(400, 'invalid_params', error.message);
          if (error instanceof UnknownHookError)
            throw new HttpError(404, 'unknown_hook', error.message);
          throw error;
        }
      },
    },
  ];

  const respond = (res: ServerResponse, reply: Reply): void => {
    const text = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  const dispatch = async (req: IncomingMessage): Promise<Reply> => {
    const { pathname } = new URL(req.url ?? '/', 'http://control.local');
    const method = req.method ?? 'GET';
    const matches = routes.flatMap((route) => {
      const match = route.pattern.exec(pathname);
      return match === null ? [] : [{ route, params: match.slice(1) }];
    });
    if (matches.length === 0) throw new HttpError(404, 'not_found', `no route for ${pathname}`);
    const hit = matches.find((m) => m.route.method === method);
    if (hit === undefined) throw new HttpError(405, 'method_not_allowed', `${method} ${pathname}`);
    let params: string[];
    try {
      params = hit.params.map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'invalid_path', 'the path is not valid percent-encoding');
    }
    const body = method === 'POST' ? await readJson(req) : undefined;
    try {
      return await hit.route.handle(params, body);
    } catch (error) {
      if (error instanceof FeedInputError) throw new HttpError(400, 'invalid_body', error.message);
      throw error;
    }
  };

  const server = createServer((req, res) => {
    dispatch(req).then(
      (reply) => respond(res, reply),
      (error: unknown) => {
        if (error instanceof HttpError) {
          respond(res, {
            status: error.status,
            body: { error: { code: error.code, message: error.message } },
          });
          return;
        }
        process.stderr.write(
          `[e2e-control] ${req.method ?? ''} ${req.url ?? ''} failed: ${String(error)}\n`,
        );
        respond(res, {
          status: 500,
          body: { error: { code: 'internal', message: String(error) } },
        });
      },
    );
  });
  const url = await listenLoopback(server, options.port);
  return { url, close: () => closeServer(server) };
}
