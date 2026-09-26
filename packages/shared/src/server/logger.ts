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
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.pretty === true
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  };
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}
