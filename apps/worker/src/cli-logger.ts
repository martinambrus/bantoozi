import { createRequire } from 'node:module';

import { createLogger, type Logger } from '@bantoozi/shared/server';

/**
 * Whether the CLI may print human-readable log lines: only outside production and only when
 * `pino-pretty` (a development dependency) can be resolved, so the production image, which ships
 * production dependencies only, logs JSON instead of failing to start the transport.
 */
export function prettyLogsAvailable(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
): boolean {
  if (env['NODE_ENV'] === 'production') return false;
  try {
    resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createCliLogger(prettyAvailable: boolean = prettyLogsAvailable()): Logger {
  return createLogger({ name: 'worker-cli', level: 'warn', pretty: prettyAvailable });
}
