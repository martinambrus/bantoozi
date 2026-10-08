import pg from 'pg';

import { startFakeTypeSafe, type FakeTypeSafeOptions } from '../fake-typesafe.js';
import { roleUrl, testDbEnv } from '../test-db/test-db.js';
import { startControlApi } from './control.js';
import { dropE2eDatabase } from './database.js';
import { E2E_FEED_KEYS, e2eDatabaseName, e2ePorts, requireRunId } from './env.js';
import { startFeeds } from './feeds.js';

/**
 * `pnpm --filter @bantoozi/testing fixtures:serve` (first `webServer` entry of spec 09 §9, after
 * `e2e:prepare`): the three fixture feeds, the fake TypeSafe server (`latencyMs: 50`) and the
 * control API, all on 127.0.0.1. On SIGTERM/SIGINT (Playwright's graceful shutdown) it closes them
 * and drops the run's database, so the database goes away even when a later `webServer` entry
 * fails to start.
 */

const FAKE_DEFAULTS: FakeTypeSafeOptions = { latencyMs: 50 };

function log(message: string): void {
  process.stdout.write(`[e2e:serve] ${message}\n`);
}

function logError(message: string, error: unknown): void {
  process.stderr.write(
    `[e2e:serve] ${message}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

async function main(): Promise<void> {
  const name = e2eDatabaseName(requireRunId());
  const ports = e2ePorts();
  const env = testDbEnv();
  const closers: Array<() => Promise<void>> = [];

  const start = async (): Promise<void> => {
    const feeds = await startFeeds(ports.feeds);
    closers.push(async () => {
      await Promise.all(E2E_FEED_KEYS.map((key) => feeds[key].close()));
    });
    const fake = await startFakeTypeSafe({ ...FAKE_DEFAULTS, port: ports.fake });
    closers.push(() => fake.close());
    const pool = new pg.Pool({
      connectionString: roleUrl(env, 'postgres', name),
      max: 2,
      application_name: 'bantoozi-e2e-control',
    });
    pool.on('error', (error) => logError('control database connection', error));
    closers.push(() => pool.end());
    const control = await startControlApi({
      port: ports.control,
      feeds,
      fake,
      fakeDefaults: FAKE_DEFAULTS,
      db: pool,
    });
    closers.push(() => control.close());
    log(`ready: control ${control.url}, fake TypeSafe ${fake.url}, database ${name}`);
  };

  const startup = start();
  let stopping: Promise<number> | undefined;
  const stop = (): Promise<number> =>
    (stopping ??= (async () => {
      await startup.catch(() => undefined);
      let code = 0;
      for (const close of closers.reverse()) {
        await close().catch((error: unknown) => {
          logError('closing a server failed', error);
          code = 1;
        });
      }
      await dropE2eDatabase(env, name).catch((error: unknown) => {
        logError(`dropping ${name} failed`, error);
        code = 1;
      });
      return code;
    })());

  // A signal may reach the process twice (the process group and the tsx wrapper): `on`, not `once`.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping === undefined) log(`${signal}: shutting down`);
      void stop().then((code) => process.exit(code));
    });
  }

  try {
    await startup;
  } catch (error) {
    logError('start-up failed', error);
    process.exit((await stop()) || 1);
  }
}

main().catch((error: unknown) => {
  logError('failed', error);
  process.exit(1);
});
