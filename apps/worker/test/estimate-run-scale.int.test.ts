import { createDatabase, rankEstimatePage, type RankEstimateRow } from '@bantoozi/db';
import {
  DEFAULT_RANKER_CONFIG,
  estimateFeatures,
  scoreEstimate,
  tierFromP,
  type EstimateModel,
} from '@bantoozi/ranker';
import { RANK_WINDOW_DAYS } from '@bantoozi/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RANK_WRITE_BATCH } from '../src/handlers/user-rank.js';
import { ClassifyHarness } from './support/classify.js';
import {
  SCALE,
  SCALE_CANDIDATES,
  buildScaleWorld,
  lastRunOf,
  runRank,
  storeModel,
  storedRows,
  type RankRun,
  type ScaleArticle,
  type ScaleWorld,
  type StoredRow,
} from './support/estimate-run-world.js';

/**
 * EST-3b I8 and I10: the estimate refresh over 12,700 estimate-set rows and 3,500 analysed ones.
 * Structural assertions (one page query, no BM25 corpus, exactly the changed rows written, analysed
 * rows untouched, the oracle's P and tier) plus the wall-time budget `ESTIMATE_RUN_BUDGET_MS`
 * (default 15000; the lead measures with 5000). Every run prints one JSON line with its timings and
 * statement counts.
 */

const BUDGET_MS = Number(process.env['ESTIMATE_RUN_BUDGET_MS'] ?? 15_000);

let h: ClassifyHarness;
let world: ScaleWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  world = await buildScaleWorld(h);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

// ── Statement counting ───────────────────────────────────────────────────────────────────────────

interface Recorded {
  text: string;
  ms: number;
}

type Queryable = {
  query: (...args: unknown[]) => unknown;
  __counted?: boolean;
};

/** A worker-role pool whose every statement is recorded, and the dependencies built on it. */
function countingDeps() {
  const pool = new pg.Pool({ connectionString: h.testDb.urls.worker, max: 10 });
  const recorded: Recorded[] = [];
  const wrap = (target: Queryable): void => {
    if (target.__counted === true) return;
    target.__counted = true;
    const original = target.query.bind(target);
    target.query = (...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
      const started = performance.now();
      const result = original(...args);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        (result as Promise<unknown>).then(
          () => recorded.push({ text, ms: performance.now() - started }),
          () => recorded.push({ text, ms: performance.now() - started }),
        );
      }
      return result;
    };
  };
  wrap(pool as unknown as Queryable);
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient>;
  (pool as unknown as { connect: (...args: unknown[]) => Promise<pg.PoolClient> }).connect = async (
    ...args: unknown[]
  ) => {
    const client = await connect(...args);
    // The callback form (pool.query's own checkout) returns nothing; its client is not wrapped.
    if (client !== undefined) wrap(client as unknown as Queryable);
    return client;
  };
  return { deps: { ...h.deps, db: createDatabase(pool) }, recorded, close: () => pool.end() };
}

const isCorpus = (text: string): boolean => /rank_window/u.test(text) && /title_norm/u.test(text);
const isPage = (text: string): boolean => /rank_window/u.test(text) && !/title_norm/u.test(text);

function counts(recorded: readonly Recorded[]) {
  const where = (test: (text: string) => boolean) => recorded.filter((r) => test(r.text));
  return {
    total: recorded.length,
    page: where(isPage).length,
    corpus: where(isCorpus).length,
    translations: where((t) => /FROM\s+"?article_translations"?/iu.test(t)).length,
    facets: where((t) => /article_facets/u.test(t)).length,
    answers: where((t) => /card_answers/u.test(t)).length,
    writes: where((t) => /INSERT INTO user_article/iu.test(t)).length,
    pageMs: Math.round(where(isPage).reduce((sum, r) => sum + r.ms, 0)),
  };
}

// ── Oracle ───────────────────────────────────────────────────────────────────────────────────────

function pOf(model: EstimateModel, article: ScaleArticle): number {
  const scored = scoreEstimate(
    model,
    estimateFeatures({ title: article.title, excerpt: article.excerpt, feedId: article.feedId }),
  );
  if (scored === null) throw new Error('the oracle model has another spec');
  return scored.p;
}

const tierOfP = (p: number): number => tierFromP(p, DEFAULT_RANKER_CONFIG);

const rulesOfKind = (kind: ScaleArticle['kind']): string[] =>
  kind === 'pending' ? ['estimate'] : ['inference_not_requested', 'estimate'];

interface Measured {
  run: RankRun;
  ms: number;
  stats: ReturnType<typeof counts>;
  page: string[];
}

async function measured(label: string, userId: string): Promise<Measured> {
  const counting = countingDeps();
  try {
    const started = performance.now();
    const run = await runRank(h, userId, { estimate: {}, deps: counting.deps });
    const ms = Math.round(performance.now() - started);
    // Let the last recorded statements settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stats = counts(counting.recorded);
    console.log(
      JSON.stringify({
        event: 'estimate-run-scale',
        run: label,
        ms,
        budgetMs: BUDGET_MS,
        rows: { visited: run.log['visited'], written: run.log['written'], ranked: run.ranked },
        up: run.log['up'],
        down: run.log['down'],
        statements: stats,
        seedMs: world.seedMs,
      }),
    );
    return {
      run,
      ms,
      stats,
      page: counting.recorded.filter((r) => isPage(r.text)).map((r) => r.text),
    };
  } finally {
    await counting.close();
  }
}

async function analysedDigest(): Promise<string> {
  const result = await h.owner.query<{ digest: string; n: string }>(
    `SELECT md5(string_agg(concat_ws('|', article_id, lane, tier, p_like, score_source,
                                     rules_fired::text, explain::text, scored_at, score_version),
                           ',' ORDER BY article_id)) AS digest,
            count(*)::text AS n
       FROM user_article WHERE user_id = $1 AND score_source = 'cards'`,
    [world.userId],
  );
  return `${result.rows[0]?.n}:${result.rows[0]?.digest}`;
}

describe('the scale world', () => {
  it('seeds within 20 seconds with the specified rows', async () => {
    expect(world.seedMs).toBeLessThan(20_000);
    const rows = await h.owner.query<{ kind: string; n: string; read: string }>(
      `SELECT CASE WHEN score_source = 'cards' THEN 'analysed'
                   WHEN 'inference_not_requested' = ANY(rules_fired) THEN 'oneB'
                   ELSE 'pending' END AS kind,
              count(*)::text AS n, count(read_at)::text AS read
         FROM user_article WHERE user_id = $1 GROUP BY 1`,
      [world.userId],
    );
    const byKind = Object.fromEntries(rows.rows.map((row) => [row.kind, Number(row.n)]));
    expect(byKind).toEqual({
      analysed: SCALE.analysed,
      oneB: SCALE.overCap + SCALE.training,
      pending: SCALE.pending,
    });
    const read = rows.rows.reduce((sum, row) => sum + Number(row.read), 0);
    const share = read / (SCALE_CANDIDATES + SCALE.analysed);
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.4);
    expect(world.candidates).toHaveLength(SCALE_CANDIDATES);
  });
});

describe('the estimate refresh at scale', () => {
  let page: RankEstimateRow[];

  beforeAll(async () => {
    page = await rankEstimatePage(h.db, {
      userId: world.userId,
      now: new Date(),
      windowDays: RANK_WINDOW_DAYS,
      sources: ['none', 'estimate'],
      limit: 50_000,
    });
  });

  it('I8 one page covers exactly the 12,700 estimate-set rows, with their unread flags', () => {
    expect(page).toHaveLength(SCALE_CANDIDATES);
    const byId = new Map(world.candidates.map((article) => [article.id, article]));
    expect(new Set(page.map((row) => row.articleId))).toEqual(new Set(byId.keys()));
    for (const row of page) expect(row.unread).toBe(!byId.get(row.articleId)?.read);
  });

  describe('first refresh (every row changes)', () => {
    let first: Measured;
    let digestBefore: string;
    let version: number;

    beforeAll(async () => {
      digestBefore = await analysedDigest();
      version = await storeModel(h, world.userId, world.model1);
      first = await measured('first', world.userId);
    }, 180_000);

    it('I8 issues exactly one page query without dirty or recheck columns, and no BM25 corpus query', () => {
      expect(first.stats.page).toBe(1);
      expect(first.page[0]).not.toMatch(/\bdirty\b|\brecheck\b/u);
      expect(first.stats.corpus).toBe(0);
      expect(first.stats.translations).toBeLessThanOrEqual(
        Math.ceil(SCALE_CANDIDATES / RANK_WRITE_BATCH),
      );
    });

    it('I10 writes every row in batches of 500 and finishes inside the wall-time budget', () => {
      expect(first.run).toMatchObject({ outcome: 'done', written: SCALE_CANDIDATES });
      expect(first.run.log).toMatchObject({
        mode: 'estimate',
        visited: SCALE_CANDIDATES,
        written: SCALE_CANDIDATES,
      });
      expect(first.stats.writes).toBe(Math.ceil(SCALE_CANDIDATES / RANK_WRITE_BATCH));
      expect(first.ms).toBeLessThanOrEqual(BUDGET_MS);
    });

    it('stores the oracle`s P, tier, rules and model version on every row', async () => {
      const stored = await storedRows(h, world.userId);
      let wrong: string[] = [];
      for (const article of world.candidates) {
        const row = stored.get(article.id);
        const p = pOf(world.model1, article);
        const ok =
          row?.lane === 'new' &&
          row.source === 'estimate' &&
          row.tier === tierOfP(p) &&
          Math.abs((row.p ?? -1) - p) < 3e-7 &&
          JSON.stringify(row.rules) === JSON.stringify(rulesOfKind(article.kind)) &&
          row.explain?.estimate?.version === version;
        if (!ok) wrong = [...wrong, article.id];
      }
      expect(wrong.slice(0, 5)).toEqual([]);
      expect(wrong).toHaveLength(0);
    });

    it('leaves the analysed rows byte-equal', async () => {
      expect(await analysedDigest()).toBe(digestBefore);
    });

    it('records lastRun with the unread rows whose tier rose', async () => {
      const up = world.candidates.filter(
        (article) => !article.read && tierOfP(pOf(world.model1, article)) > 1,
      ).length;
      expect(up).toBeGreaterThan(0);
      expect(await lastRunOf(h, world.userId, version)).toMatchObject({
        movedUp: up,
        movedDown: 0,
      });
    });
  });

  describe('second refresh with the nudged model (few rows change)', () => {
    let before: Map<string, StoredRow>;
    let second: Measured;
    let version: number;

    beforeAll(async () => {
      before = await storedRows(h, world.userId);
      version = await storeModel(h, world.userId, world.model2);
      second = await measured('second', world.userId);
    }, 180_000);

    it('I3 writes exactly the rows whose tier changed or whose P moved by 0.01', async () => {
      const after = await storedRows(h, world.userId);
      const mustWrite: string[] = [];
      const mustSkip: string[] = [];
      let ambiguous = 0;
      let up = 0;
      let down = 0;
      for (const article of world.candidates) {
        const old = before.get(article.id) as StoredRow;
        const p2 = pOf(world.model2, article);
        const tier2 = tierOfP(p2);
        const delta = Math.abs(p2 - (old.p ?? 0));
        if (tier2 !== old.tier || delta >= 0.0101) {
          mustWrite.push(article.id);
          if (!article.read && tier2 !== old.tier) {
            if (tier2 > (old.tier ?? 1)) up += 1;
            else down += 1;
          }
        } else if (delta < 0.0099) mustSkip.push(article.id);
        else ambiguous += 1;
      }
      const written = new Set(
        world.candidates
          .filter((article) => {
            const was = before.get(article.id)?.scoredAt?.getTime();
            return after.get(article.id)?.scoredAt?.getTime() !== was;
          })
          .map((article) => article.id),
      );
      expect(mustWrite.length).toBeGreaterThan(0);
      expect(mustWrite.length).toBeLessThan(SCALE_CANDIDATES * 0.15);
      expect(ambiguous).toBeLessThan(5);
      expect(mustWrite.filter((id) => !written.has(id))).toEqual([]);
      expect(mustSkip.filter((id) => written.has(id))).toEqual([]);
      expect(second.run.written).toBe(written.size);
      for (const id of written) expect(after.get(id)?.explain?.estimate?.version).toBe(version);
      for (const id of mustSkip) {
        expect(after.get(id)?.explain?.estimate?.version).not.toBe(version);
      }
      expect(second.run.log).toMatchObject({ up, down, visited: SCALE_CANDIDATES });
      expect(await lastRunOf(h, world.userId, version)).toMatchObject({
        movedUp: up,
        movedDown: down,
      });
    });

    it('I8 still issues one page query and no corpus query, inside the budget', () => {
      expect(second.stats.page).toBe(1);
      expect(second.stats.corpus).toBe(0);
      expect(second.ms).toBeLessThanOrEqual(BUDGET_MS);
    });

    it('a third refresh with the same model writes nothing and still records lastRun 0/0', async () => {
      const third = await measured('third', world.userId);
      expect(third.run).toMatchObject({ outcome: 'done', written: 0 });
      expect(third.stats.writes).toBe(0);
      expect(third.ms).toBeLessThanOrEqual(BUDGET_MS);
      expect(await lastRunOf(h, world.userId, version)).toMatchObject({ movedUp: 0, movedDown: 0 });
    });
  });
});
