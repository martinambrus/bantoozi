import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Paths never written to logs (spec 01 §5: no secrets, email codes, session tokens or full article
 * bodies). Keys are matched at any of the listed depths.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
  'secret',
  '*.secret',
  'loginCode',
  '*.loginCode',
  'smtpUrl',
  '*.smtpUrl',
  'databaseUrl',
  '*.databaseUrl',
  'databaseUrlWorker',
  '*.databaseUrlWorker',
  'databaseUrlMigrate',
  '*.databaseUrlMigrate',
  'testAdminDatabaseUrl',
  '*.testAdminDatabaseUrl',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'DATABASE_URL_WORKER',
  '*.DATABASE_URL_WORKER',
  'DATABASE_URL_MIGRATE',
  '*.DATABASE_URL_MIGRATE',
  'TEST_ADMIN_DATABASE_URL',
  '*.TEST_ADMIN_DATABASE_URL',
  'SMTP_URL',
  '*.SMTP_URL',
  'req.body.code',
  'req.body.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'envelope',
  '*.envelope',
  '*.active_envelope',
  '*.candidate_envelope',
  'bodyText',
  'bodyHtml',
  '*.bodyText',
  '*.bodyHtml',
  '*.body_text',
  '*.body_html',
];

/** The path of a request URL: the query string can carry search text or emails (spec 11 §7). */
export function stripQuery(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Request serializer: method, path-only url, host and remote address; no query, no headers. */
export function serializeRequest(request: unknown): Record<string, unknown> {
  const r = (request ?? {}) as Record<string, unknown>;
  const raw = (r['raw'] ?? {}) as Record<string, unknown>;
  const url = stripQuery(r['originalUrl'] ?? r['url'] ?? raw['url']);
  return {
    method: r['method'] ?? raw['method'],
    url,
    ...(r['hostname'] === undefined ? {} : { hostname: r['hostname'] }),
    ...(r['ip'] === undefined ? {} : { remoteAddress: r['ip'] }),
  };
}

export interface CreateLoggerOptions {
  level?: string;
  /** Process/component name, e.g. `api`, `worker`. */
  name?: string;
  /** Human-readable output (dev only; requires pino-pretty in the app). */
  pretty?: boolean;
  /** Test hook: write to a custom destination. */
  destination?: DestinationStream;
}

/** JSON logs to stdout (spec 01 §1); use `logger.child({component, jobId, userId, articleId})`. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const base: LoggerOptions = {
    level: options.level ?? 'info',
    serializers: { req: serializeRequest },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.pretty === true
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  };
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}
