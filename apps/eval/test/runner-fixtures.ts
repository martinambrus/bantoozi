import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDatabase,
  createDataset,
  ensureEvalUser,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  dropCreatedTestDatabases,
  setupTestDatabase,
  startFakeLibreTranslate,
  startFakeOllama,
  startFakeTypeSafe,
  type FakeLibreTranslate,
  type FakeOllamaServer,
  type FakeTypeSafeServer,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';

import { buildCli } from '../src/cli.js';
import { addArticlesToDataset } from '../src/dataset/topup.js';
import { createEvalRuntime, type EvalRuntime } from '../src/runtime.js';

/**
 * Fixtures of the M3a-T6 runner, cache and replay integration tests: a migrated test database, the
 * fake TypeSafe (counting requests), fake LibreTranslate and fake Ollama servers, a temporary
 * `EVAL_CACHE_DIR`, and a small golden dataset with two raters, their cards, assignments, ratings
 * (with off-topic reasons for E6) and facet labels. No live provider is ever reached.
 */

export interface RunnerTestContext {
  testDb: TestDatabase;
  owner: pg.Pool;
  workerPool: pg.Pool;
  db: Database;
  typesafe: FakeTypeSafeServer;
  libretranslate: FakeLibreTranslate;
  ollama: FakeOllamaServer;
  cacheDir: string;
  /** The eval environment pointing at the fakes. */
  env(overrides?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

export const FAKE_TYPESAFE_KEY = 'ts-test-key';
export const FAKE_OLLAMA_KEY = 'ollama-test-key';

export async function setupRunnerTest(): Promise<RunnerTestContext> {
  const testDb = await setupTestDatabase({
    pkg: 'eval',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  const owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  const workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  const db = createDatabase(workerPool);
  const [typesafe, libretranslate, ollama, cacheDir] = await Promise.all([
    startFakeTypeSafe({ apiKey: FAKE_TYPESAFE_KEY }),
    startFakeLibreTranslate(),
    startFakeOllama({ apiKey: FAKE_OLLAMA_KEY }),
    mkdtemp(path.join(tmpdir(), 'bantoozi-eval-run-')),
  ]);
  const ctx: RunnerTestContext = {
    testDb,
    owner,
    workerPool,
    db,
    typesafe,
    libretranslate,
    ollama,
    cacheDir,
    env: (overrides = {}) => ({
      DATABASE_URL_WORKER: testDb.urls.worker,
      TYPESAFE_BASE_URL: typesafe.url,
      TYPESAFE_MODEL: 'jev-fake',
      TYPESAFE_API_KEY: FAKE_TYPESAFE_KEY,
      LIBRETRANSLATE_URL: libretranslate.url,
      OLLAMA_BASE_URL: ollama.url,
      OLLAMA_API_KEY: FAKE_OLLAMA_KEY,
      EVAL_CACHE_DIR: cacheDir,
      LOG_LEVEL: 'silent',
      ...overrides,
    }),
    async close() {
      await Promise.all([
        owner.end(),
        workerPool.end(),
        typesafe.close(),
        libretranslate.close(),
        ollama.close(),
        rm(cacheDir, { recursive: true, force: true }),
      ]);
      await dropCreatedTestDatabases();
    },
  };
  return ctx;
}

export interface CapturedRuntime {
  rt: EvalRuntime;
  out(): string;
  /** Called with every chunk written to `out`, before it is stored. */
  onOut?: (text: string) => void;
}

/** A runtime over the test database and the fakes, capturing its output. */
export function runtime(
  ctx: RunnerTestContext,
  overrides: Record<string, string> = {},
  onOut?: (text: string) => void,
): CapturedRuntime {
  const out: string[] = [];
  const rt = createEvalRuntime({
    env: ctx.env(overrides),
    io: {
      out: (text) => {
        onOut?.(text);
        out.push(text);
      },
      err: () => undefined,
    },
    poolMax: 4,
  });
  return { rt, out: () => out.join('') };
}

/** Run `eval <args>` against the fakes (the CLI path). */
export async function runCli(
  ctx: RunnerTestContext,
  args: string[],
  overrides: Record<string, string> = {},
): Promise<string> {
  const out: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
  const rt = createEvalRuntime({ env: ctx.env(overrides), io, poolMax: 2 });
  await buildCli({ io, openRuntime: () => rt }).parseAsync(['node', 'cli', ...args]);
  return out.join('');
}

export interface GoldenFixture {
  version: string;
  articleIds: { en: string[]; sk: string[] };
  /** Article id → title. */
  titles: Map<string, string>;
  raters: { a: string; b: string };
  cards: {
    battery: string;
    football: string;
    gossip: string;
    astronomy: string;
    skBattery: string;
  };
}

const EN_TOPICS = [
  ['Electric vehicle batteries get cheaper', 'battery'],
  ['Football transfers: the summer window closes', 'football'],
  ['Celebrity gossip from the red carpet', 'gossip'],
  ['Astronomy telescopes spot a distant galaxy', 'astronomy'],
  ['City council approves the new budget', 'other'],
  ['Weather: a mild autumn ahead', 'other'],
] as const;

const SK_TITLES = [
  ['Ceny batérií pre elektromobily klesajú', 'battery'],
  ['Futbalové prestupy: leto sa končí', 'football'],
  ['Mestské zastupiteľstvo schválilo rozpočet', 'other'],
  ['Počasie: mierna jeseň', 'other'],
] as const;

async function rater(ctx: RunnerTestContext, name: string, langs: string[]): Promise<string> {
  const result = await ctx.owner.query<{ id: string }>(
    `INSERT INTO eval.raters (name, participant_key, token_hash, token_expires_at, langs)
     VALUES ($1, gen_random_uuid(), md5(random()::text), now() + interval '30 days', $2)
     RETURNING id::text AS id`,
    [name, langs],
  );
  return result.rows[0]!.id;
}

/**
 * The golden fixture: 24 English and 8 Slovak articles in `golden-v1` (seed `seed-1`), rater A (en,
 * sk) with battery/football/gossip-never cards plus a Slovak battery card, rater B (en) with an
 * astronomy card. A rates everything (likes battery and football), B rates the English articles
 * (likes astronomy); some dislikes are off topic. Two articles carry owner facet labels.
 */
export async function seedGolden(ctx: RunnerTestContext): Promise<GoldenFixture> {
  const evalUser = await ctx.db.transaction((tx) => ensureEvalUser(tx));
  const feedEn = await createFeed(ctx.owner, { title: 'World News' });
  const feedSk = await createFeed(ctx.owner, { title: 'Správy' });
  for (const feed of [feedEn, feedSk]) {
    await createSubscription(ctx.owner, { userId: evalUser.id, feedId: feed.id });
  }
  const titles = new Map<string, string>();
  const topics = new Map<string, string>();
  const en: string[] = [];
  const sk: string[] = [];
  const start = Date.parse('2026-09-01T08:00:00Z');
  let n = 0;
  const add = async (feedId: string, lang: string, title: string, topic: string) => {
    const seenAt = new Date(start + n * 3_600_000);
    n += 1;
    const article = await createArticle(ctx.owner, {
      feedIds: [feedId],
      title,
      excerpt: `${title}. More details inside the story.`,
      firstSeenAt: seenAt,
      publishedAt: seenAt,
    });
    await ctx.owner.query(
      `UPDATE articles SET lang = $2, pipeline_state = 'extracted', word_count = 400 WHERE id = $1`,
      [article.id, lang],
    );
    titles.set(article.id, title);
    topics.set(article.id, topic);
    return article.id;
  };
  for (let round = 0; round < 4; round += 1) {
    for (const [title, topic] of EN_TOPICS) {
      en.push(await add(feedEn.id, 'en', `${title} (part ${round + 1})`, topic));
    }
  }
  for (let round = 0; round < 2; round += 1) {
    for (const [title, topic] of SK_TITLES) {
      sk.push(await add(feedSk.id, 'sk', `${title} (časť ${round + 1})`, topic));
    }
  }
  await createDataset(ctx.db, { version: 'golden-v1', seed: 'seed-1', params: { test: true } });
  const added = await addArticlesToDataset(ctx.db, [...en, ...sk]);
  if (added.added.length !== en.length + sk.length) throw new Error('sample not built');

  const a = await rater(ctx, 'Rater A', ['en', 'sk']);
  const b = await rater(ctx, 'Rater B', ['en']);
  const battery = await createCard(ctx.owner, {
    title: 'Batteries',
    interest: 'electric vehicle batteries and charging',
  });
  const football = await createCard(ctx.owner, {
    title: 'Football',
    interest: 'football transfers and league tables',
  });
  const gossip = await createCard(ctx.owner, {
    title: 'Gossip',
    interest: 'celebrity gossip',
  });
  const astronomy = await createCard(ctx.owner, {
    title: 'Astronomy',
    interest: 'astronomy telescopes and galaxies',
  });
  const skBattery = await createCard(ctx.owner, {
    title: 'Batérie',
    interest: 'Zaujímajú ma batérie pre elektromobily, ich nabíjanie a ceny, ktoré sú na Slovensku',
    lang: 'sk',
  });
  const raterCards: Array<[string, string, string]> = [
    [a, battery.id, 'like'],
    [a, football.id, 'love'],
    [a, gossip.id, 'never'],
    [a, skBattery.id, 'like'],
    [b, astronomy.id, 'like'],
  ];
  for (const [raterId, cardId, strength] of raterCards) {
    await ctx.owner.query(
      `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, $3)`,
      [raterId, cardId, strength],
    );
  }

  const rate = async (raterId: string, ids: string[], likes: (topic: string) => boolean) => {
    for (const [position, articleId] of ids.entries()) {
      await ctx.owner.query(
        `INSERT INTO eval.assignments (rater_id, article_id, position, status) VALUES ($1, $2, $3, 'rated')`,
        [raterId, articleId, position],
      );
      const topic = topics.get(articleId) ?? 'other';
      const liked = likes(topic);
      await ctx.owner.query(
        `INSERT INTO eval.ratings (rater_id, article_id, rating, reason, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          raterId,
          articleId,
          liked ? 1 : -1,
          liked ? null : position % 2 === 0 ? 'off_topic' : 'too_long',
          new Date(Date.parse('2026-09-10T08:00:00Z') + position * 60_000),
        ],
      );
    }
  };
  await rate(a, [...en, ...sk], (topic) => topic === 'battery' || topic === 'football');
  await rate(b, en, (topic) => topic === 'astronomy');
  for (const articleId of [en[0]!, sk[0]!]) {
    for (const [key, value] of [
      ['content_type', 'news'],
      ['topic_l1', 'technology'],
    ]) {
      await ctx.owner.query(
        `INSERT INTO eval.facet_labels (labeler, article_id, question_key, value) VALUES ('owner', $1, $2, $3)`,
        [articleId, key, value],
      );
    }
  }
  return {
    version: 'golden-v1',
    articleIds: { en, sk },
    titles,
    raters: { a, b },
    cards: {
      battery: battery.id,
      football: football.id,
      gossip: gossip.id,
      astronomy: astronomy.id,
      skBattery: skBattery.id,
    },
  };
}

export async function runRow(ctx: RunnerTestContext, runId: string) {
  const result = await ctx.owner.query<{
    experiment: string;
    config: Record<string, unknown>;
    results: Record<string, unknown> | null;
    finished: boolean;
  }>(
    `SELECT experiment, config, results, finished_at IS NOT NULL AS finished FROM eval.runs WHERE id = $1`,
    [runId],
  );
  return result.rows[0]!;
}

export async function answerCounts(ctx: RunnerTestContext, runId: string) {
  const result = await ctx.owner.query<{ key: string; n: number }>(
    `SELECT CASE WHEN question_key LIKE 'enrich.%' THEN 'enrich'
                 WHEN question_key LIKE 'score.r%' THEN 'score'
                 ELSE question_key END AS key,
            count(*)::int AS n
       FROM eval.run_answers WHERE run_id = $1 GROUP BY 1`,
    [runId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.key, row.n])) as Record<string, number>;
}
