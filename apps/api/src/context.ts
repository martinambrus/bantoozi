import type { Database } from '@bantoozi/db';
import type { DiscoverDeps } from '@bantoozi/feeds';
import type { Clock } from '@bantoozi/shared';
import type { RuntimeSettingsCache } from '@bantoozi/db';
import type { Mailer, ProcessConfig } from '@bantoozi/shared/server';
import type { LibreTranslateClient } from '@bantoozi/translate';

import type { SetupRuntime } from './services/setup.js';
import type { CursorCodec } from './services/cursor.js';
import type { RateLimiter } from './plugins/rate-limit.js';

/** The API process configuration (spec 01 §3); `sessionPepper` and `databaseUrl` are required. */
export type ApiConfig = ProcessConfig<'api'>;

/**
 * Everything a route needs besides the request, decorated on the root instance as `app.services`.
 * Network-facing collaborators are injected so tests use fakes (spec 01 §5: no network in tests).
 */
export interface ApiServices {
  /** Drizzle over the `bantoozi_app` pool (RLS enforced). */
  readonly db: Database;
  readonly config: ApiConfig;
  readonly mailer: Mailer;
  readonly clock: Clock;
  readonly cursors: CursorCodec;
  readonly limiter: RateLimiter;
  /**
   * Discovery/OPML collaborators (spec 03 §10–11): `safeFetch`, parse and decode bound to the
   * fetch configuration. Slow outbound work runs before any transaction is opened (spec 08 §1).
   */
  readonly discoverDeps: DiscoverDeps;
  /**
   * The tier-1 translator for card texts (spec 07 §5) and the admin LibreTranslate health probe
   * (spec 08 §9). `null` when no LibreTranslate is configured for this process.
   */
  readonly getLibreTranslate: () => Promise<LibreTranslateClient | null>;
  /** The URL `getLibreTranslate` currently follows (a live override, else `LIBRETRANSLATE_URL`). */
  readonly liveLibreTranslateUrl: () => Promise<string>;
  /**
   * A new LibreTranslate client for `baseUrl`, owned by the caller (who must `close()` it): the admin
   * settings probe of a URL that is not the live one (spec 08 §9).
   */
  readonly createProbeLibreTranslate: (baseUrl: string) => LibreTranslateClient;
  /** The live runtime settings (M8b-T3): one TTL cache per process, invalidated by an admin PATCH. */
  readonly runtime: RuntimeSettingsCache;
  /** First-run setup token state of this process (M8b-T6): fail-closed until it has rotated. */
  readonly setup: SetupRuntime;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: ApiServices;
  }
}
