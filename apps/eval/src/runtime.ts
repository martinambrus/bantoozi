import { createDatabase, createPool, type Database } from '@bantoozi/db';
import { createLogger, loadConfig, type Logger, type ProcessConfig } from '@bantoozi/shared/server';
import type pg from 'pg';

/**
 * What every `eval` command runs with (spec 10): the eval process configuration, one worker-role
 * pool on `DATABASE_URL_WORKER` (spec 02 §7: the eval schema is reached only through it), a logger
 * and the output streams. Tests build a runtime over their own test database with
 * {@link createEvalRuntime}'s options.
 */
export interface EvalIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface EvalRuntime extends EvalIo {
  config: ProcessConfig<'eval'>;
  pool: pg.Pool;
  db: Database;
  logger: Logger;
  /** Injected time (spec 01 §5). */
  now: () => Date;
  close(): Promise<void>;
}

export interface EvalRuntimeOptions {
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  io?: EvalIo;
  now?: () => Date;
  /** Pool size; default 6. */
  poolMax?: number;
}

export const processIo: EvalIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

export function createEvalRuntime(options: EvalRuntimeOptions = {}): EvalRuntime {
  const config = loadConfig({
    process: 'eval',
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const pool = createPool({
    connectionString: config.databaseUrlWorker,
    max: options.poolMax ?? 6,
    applicationName: 'bantoozi-eval',
  });
  const logger = createLogger({ name: 'eval', level: config.logLevel });
  pool.on('error', (err) => logger.warn({ err }, 'idle database connection error'));
  const io = options.io ?? processIo;
  return {
    config,
    pool,
    db: createDatabase(pool),
    logger,
    now: options.now ?? (() => new Date()),
    out: io.out,
    err: io.err,
    close: () => pool.end(),
  };
}

/** A user-facing failure: printed without a stack trace, exit status 1 (or `exitCode`). */
export class EvalCommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'EvalCommandError';
    this.exitCode = exitCode;
  }
}
