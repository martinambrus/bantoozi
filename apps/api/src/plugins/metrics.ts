import { createRequire } from 'node:module';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  Counter as PromCounter,
  Histogram as PromHistogram,
  Registry as PromRegistry,
} from 'prom-client';

/**
 * prom-client (pinned 15.1.3, CommonJS, no `exports` map) is loaded per class rather than through
 * its index: the index also loads the default process metrics, which `require('@opentelemetry/api')`.
 * Under Vitest, Node runs with `--conditions module`, which resolves that package to its
 * extensionless ESM build that Node cannot load. This API uses none of the default metrics.
 */
const requireCjs = createRequire(import.meta.url);
const Registry = requireCjs('prom-client/lib/registry') as typeof PromRegistry;
const Counter = requireCjs('prom-client/lib/counter') as typeof PromCounter;
const Histogram = requireCjs('prom-client/lib/histogram') as typeof PromHistogram;

/**
 * HTTP metrics (spec 08 §10): request counts, latency and errors by application code, in a
 * registry of this server instance (never the process-global default, so several servers in one
 * process do not collide). `GET /metrics` renders it for an admin session or the `METRICS_TOKEN`
 * bearer. Labels are bounded: the route pattern (never the raw URL), the method, the status class
 * and the error code.
 */

export interface ApiMetrics {
  readonly registry: PromRegistry;
  readonly requests: PromCounter<'method' | 'route' | 'status'>;
  readonly duration: PromHistogram<'method' | 'route'>;
  readonly errors: PromCounter<'code'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: ApiMetrics;
  }
}

export function createApiMetrics(): ApiMetrics {
  const registry = new Registry();
  return {
    registry,
    requests: new Counter({
      name: 'bantoozi_api_http_requests_total',
      help: 'HTTP requests by method, route pattern and status',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'bantoozi_api_http_request_duration_seconds',
      help: 'HTTP request latency by method and route pattern',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    errors: new Counter({
      name: 'bantoozi_api_http_errors_total',
      help: 'Error responses by application error code (spec 08 §1)',
      labelNames: ['code'],
      registers: [registry],
    }),
  };
}

/** The route pattern label; unmatched requests share one label (no URL cardinality). */
function routeLabel(request: FastifyRequest): string {
  if (request.is404) return 'unmatched';
  return request.routeOptions.url ?? 'unmatched';
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The `error.code` of an error envelope payload, when it is one. */
function errorCode(payload: unknown): string {
  if (typeof payload !== 'string' || payload.length > 64 * 1024) return 'UNKNOWN';
  try {
    const parsed = JSON.parse(payload) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/** Registers the hooks on the root instance (so every route is measured) and decorates `metrics`. */
export function registerMetrics(app: FastifyInstance, metrics = createApiMetrics()): ApiMetrics {
  app.decorate('metrics', metrics);
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload) => {
    if (reply.statusCode >= 400) metrics.errors.inc({ code: errorCode(payload) });
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = routeLabel(request);
    metrics.requests.inc({ method: request.method, route, status: String(reply.statusCode) });
    metrics.duration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
  });
  return metrics;
}
