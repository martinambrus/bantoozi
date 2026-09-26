import { createDatabase, createPool } from '@bantoozi/db';

import { createWorkerEngineRouter, type WorkerEngineConfig } from '../engine-router.js';
import type { HandlerLogger } from '../handlers/deps.js';
import { createProviderValidateHandler } from '../handlers/provider-validate.js';
import type { CredentialCliConfig, CredentialCliSession } from './commands.js';
import { credentialResolverFromConfig } from './resolver.js';

/** What a credentials CLI session needs from the worker configuration (spec 01 §3 names). */
export type CredentialSessionConfig = CredentialCliConfig &
  WorkerEngineConfig & { databaseUrlWorker: string };

/**
 * The database session of one credentials CLI command (worker role, a small pool). `--inline`
 * validation composes the same router, resolver and `provider.validate` handler a worker uses.
 */
export function openCredentialSession(
  config: CredentialSessionConfig,
  logger: HandlerLogger,
): CredentialCliSession {
  const pool = createPool({
    connectionString: config.databaseUrlWorker,
    max: 2,
    applicationName: 'bantoozi-credentials-cli',
  });
  const db = createDatabase(pool);
  return {
    db,
    config,
    async validateInline(payload) {
      const credentials = credentialResolverFromConfig(db, config, logger);
      const router = createWorkerEngineRouter({ db, config, credentials, logger });
      const handle = createProviderValidateHandler({ db, router, credentials, config, logger });
      await handle(payload, { queue: 'provider.validate', jobId: 'credentials-cli' });
    },
    close: () => pool.end(),
  };
}
