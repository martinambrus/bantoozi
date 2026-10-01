import {
  createDatabase,
  createDataset,
  createRater,
  ensureEvalUser,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
  type RaterRow,
} from '@bantoozi/db';
import {
  createArticle,
  createFeed,
  createSubscription,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';

import { addArticlesToDataset } from '../src/dataset/topup.js';
import { issueToken } from '../src/rating-server/tokens.js';

/**
 * Shared fixtures of the rating-app integration tests (M3a-T3/T4): a migrated test database with the
 * evaluation user, golden feeds it subscribes to, articles with detected languages, and a dataset
 * version built through `addArticlesToDataset` (the real snapshot and split code).
 */

export interface RatingDb {
  testDb: TestDatabase;
  owner: pg.Pool;
  workerPool: pg.Pool;
  /** Worker role, as the eval CLI runs. */
  db: Database;
  close(): Promise<void>;
}

export async function setupRatingDb(pkg: string): Promise<RatingDb> {
  const testDb = await setupTestDatabase({
    pkg,
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  const owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  const workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
  const db = createDatabase(workerPool);
  return {
    testDb,
    owner,
    workerPool,
    db,
    close: async () => {
      await Promise.all([owner.end(), workerPool.end()]);
    },
  };
}

export interface GoldenFeedFixture {
  id: string;
  lang: string;
}

/** `count` golden feeds for `lang`, subscribed by the evaluation user. */
export async function addGoldenFeeds(
  rdb: RatingDb,
  lang: string,
  count: number,
): Promise<GoldenFeedFixture[]> {
  const evalUser = await rdb.db.transaction((tx) => ensureEvalUser(tx));
  const feeds: GoldenFeedFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    const feed = await createFeed(rdb.owner, { title: `${lang.toUpperCase()} feed ${i + 1}` });
    await rdb.owner.query('UPDATE feeds SET lang_hint = $2 WHERE id = $1', [feed.id, lang]);
    await createSubscription(rdb.owner, { userId: evalUser.id, feedId: feed.id });
    feeds.push({ id: feed.id, lang });
  }
  return feeds;
}

/** `count` extracted articles in `lang` carried by `feedId`, first seen at `seenAt`. */
export async function addArticles(
  rdb: RatingDb,
  feedId: string,
  lang: string,
  count: number,
  seenAt: Date,
  title = (i: number) => `${lang} story ${feedId}-${i}`,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const article = await createArticle(rdb.owner, {
      feedIds: [feedId],
      title: title(i),
      excerpt: `Excerpt of ${title(i)}`,
      firstSeenAt: seenAt,
      publishedAt: seenAt,
    });
    ids.push(article.id);
  }
  await rdb.owner.query(
    `UPDATE articles SET lang = $2, pipeline_state = 'extracted' WHERE id = ANY($1::bigint[])`,
    [ids, lang],
  );
  return ids;
}

/** Create `golden-v1` (seed `seed-1`) holding `articleIds`. */
export async function createGoldenDataset(rdb: RatingDb, articleIds: readonly string[]) {
  await createDataset(rdb.db, { version: 'golden-v1', seed: 'seed-1', params: { test: true } });
  return addArticlesToDataset(rdb.db, articleIds);
}

/** A rater with a fresh token (returned in clear for the test). */
export async function addRater(
  rdb: RatingDb,
  input: {
    name?: string;
    langs: string[];
    participantKey?: string;
    contextName?: string | null;
    now: Date;
    days?: number;
  },
): Promise<{ rater: RaterRow; token: string }> {
  const issued = issueToken(input.now, input.days ?? 30);
  const rater = await createRater(rdb.db, {
    name: input.name ?? 'Rater',
    participantKey: input.participantKey ?? crypto.randomUUID(),
    contextName: input.contextName ?? null,
    langs: input.langs,
    tokenHash: issued.tokenHash,
    tokenExpiresAt: issued.expiresAt,
  });
  return { rater, token: issued.token };
}
