import { randomUUID } from 'node:crypto';

import {
  answerPrompt,
  bookmarkArticle,
  createDatabase,
  labelArticle,
  loadRecentDislikes,
  markArticleRead,
  markArticleUnread,
  markArticlesRead,
  openArticle,
  rateArticle,
  rateArticlesBulk,
  saveMutation,
  tenantOutbox,
  undoArticleMutation,
  unhideArticle,
  unlabelArticle,
  withTenant,
  type ActionInput,
  type ActionResult,
  type Database,
  type TenantTx,
} from '@bantoozi/db';
import { AppError, parseJobPayload } from '@bantoozi/shared';
import pg from 'pg';

import { createUserRankHandler, type UserRankOptions } from '../../src/handlers/user-rank.js';
import { DAY, HOUR, MINUTE, type ClassifyHarness } from './classify.js';

/**
 * S22 fixtures: one reader with six window articles in two story clusters, a card and a label,
 * real reader actions through the API functions, and a full-rank ORACLE.
 *
 * Clock: `t` is a synthetic clock that starts one minute after the world is built and only moves
 * forward (at least a minute per step). It is always ahead of the database clock, so a mark written
 * with `now()` or with `t` is due for every later run, and `scored_at` stays monotonic (the write
 * fence refuses to move `scored_at` backwards).
 *
 * Oracle: after a step and the drain of everything the step enqueued, the stored ranking of every
 * row is compared with the ranking a FULL run (`full: true`, which re-ranks every row of the window
 * whatever its stamps) computes for the same state. The full run does not bump `rank_revision`
 * (only `recordRankIntents({full: true})` does), so it is the "what a rank from scratch says"
 * reference without disturbing the revision under test.
 */

export type FlagKind = 'none' | 'clickbait' | 'promo' | 'shallow' | 'stale';

export interface WorldSpec {
  /** Interest-card answer per initial article (6). */
  p: number[];
  /** Label-card answer per initial article (6); >= 0.8 yields a label suggestion. */
  labelP: number[];
  /** Quality facets per initial article (6). */
  flags: FlagKind[];
  /** `preferences.markReadOnRate`. */
  markReadOnRate: boolean;
  /** False: the second member of each cluster starts without a stored ranking. */
  rankedInitially: boolean;
}

export const INITIAL_ARTICLES = 6;

export type Step =
  | { k: 'read' | 'open' | 'unread' | 'unhide' | 'bookmark' | 'label' | 'unlabel'; a: number }
  | {
      k: 'rate';
      a: number;
      rating: 1 | -1 | null;
      reason: 'off_topic' | 'clickbait' | 'seen' | 'shallow' | 'promo' | 'other' | null;
      hide: boolean;
    }
  | { k: 'prompt'; a: number; liked: boolean }
  | { k: 'rateBulk'; as: number[]; rating: 1 | -1 | null }
  | { k: 'markRead'; as: number[] }
  | { k: 'undo' }
  | { k: 'jump'; ms: number }
  | { k: 'arrive'; cluster: 0 | 1 | null; p: number; flag: FlagKind };

export interface SnapRow {
  lane: string;
  tier: number | null;
  p: number | null;
  source: string;
  rules: string[];
  explain: unknown;
  labelSuggestions: string[];
  nextRankAt: number | null;
  scoredAt: number | null;
}

export interface Counters {
  rankRevision: string;
  /** Every `user.rank` intent with `full: true` and no cursor ever recorded for the user. */
  fullIntents: number;
  /** All `user.rank` intents ever recorded for the user. */
  rankIntents: number;
  flags: string;
}

const FACETS: Record<Exclude<FlagKind, 'none'>, Record<string, number>> = {
  clickbait: { clickbait: 0.99 },
  promo: { promotional: 0.99 },
  shallow: { depth: 0 },
  stale: { time_sensitive: 0.99 },
};

let worlds = 0;

export class RankWorld {
  readonly appPool: pg.Pool;
  readonly appDb: Database;
  articles: string[] = [];
  /** Synthetic clock (see the module comment). */
  t: Date;
  epoch = 0;
  receipts: Array<{ key: string; epoch: number; undone: boolean }> = [];
  private arrivals = 0;

  private constructor(
    readonly h: ClassifyHarness,
    readonly spec: WorldSpec,
    readonly userId: string,
    readonly feeds: [string, string],
    readonly cardId: string,
    readonly labelId: string,
    readonly clusters: [string, string],
  ) {
    this.appPool = new pg.Pool({ connectionString: h.testDb.urls.app, max: 2 });
    this.appDb = createDatabase(this.appPool);
    this.t = new Date(Date.now() + MINUTE);
  }

  static async create(h: ClassifyHarness, spec: WorldSpec): Promise<RankWorld> {
    worlds += 1;
    const userId = await h.user();
    const f1 = await h.feed();
    const f2 = await h.feed();
    await h.subscribe(userId, f1, 'active', new Date(Date.now() - 30 * DAY));
    await h.subscribe(userId, f2, 'active', new Date(Date.now() - 30 * DAY));
    const cardId = await h.heldCard(userId, { interest: `ocean shipping logistics ${worlds}` });
    const labelId = await h.heldLabel(userId);
    if (!spec.markReadOnRate) {
      await h.owner.query(
        `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || '{"markReadOnRate": false}'::jsonb
          WHERE id = $1`,
        [userId],
      );
    }
    const ids: string[] = [];
    const carriers: string[][] = [[f1], [f2], [f1], [f1], [f1], [f1]];
    for (let i = 0; i < INITIAL_ARTICLES; i += 1) {
      ids.push(
        await h.article({
          feedIds: carriers[i]!,
          title: `S22 story ${worlds}-${i}`,
          firstSeenAt: new Date(Date.now() - (i < 4 ? (i + 1) * HOUR : 4 * DAY)),
        }),
      );
    }
    const clusterIds: string[] = [];
    for (const members of [
      [ids[0]!, ids[1]!],
      [ids[2]!, ids[3]!],
    ]) {
      const created = await h.owner.query<{ id: string }>(
        `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, 2) RETURNING id::text AS id`,
        [members[0]],
      );
      clusterIds.push(created.rows[0]!.id);
      await h.owner.query(
        `UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`,
        [created.rows[0]!.id, members],
      );
    }
    const world = new RankWorld(h, spec, userId, [f1, f2], cardId, labelId, [
      clusterIds[0]!,
      clusterIds[1]!,
    ]);
    for (let i = 0; i < INITIAL_ARTICLES; i += 1) {
      await world.classify(ids[i]!, spec.p[i]!, spec.labelP[i]!, spec.flags[i]!);
      world.articles.push(ids[i]!);
    }
    await world.rankRun({ userId, reason: 'init' });
    if (!spec.rankedInitially) {
      // The two second cluster members have no stored ranking (not yet reached by a run).
      await h.owner.query(
        `DELETE FROM user_article WHERE user_id = $1 AND article_id = ANY($2::bigint[])`,
        [userId, [ids[1]!, ids[3]!]],
      );
    }
    return world;
  }

  async close(): Promise<void> {
    await this.appPool.end();
  }

  /** Enrich the article, give it the facets of `flag` and answer the card and the label. */
  private async classify(articleId: string, p: number, labelP: number, flag: FlagKind) {
    await this.h.enrichDirect(articleId, { state: 'matched' });
    if (flag !== 'none') {
      await this.h.owner.query(
        `UPDATE article_facets SET features = features || $2::jsonb WHERE article_id = $1`,
        [articleId, JSON.stringify(FACETS[flag])],
      );
    }
    await this.h.answerCard(articleId, this.cardId, { engine: 'typesafe', p });
    await this.h.answerCard(articleId, this.labelId, { engine: 'typesafe', p: labelP });
  }

  // ── Rank runs ────────────────────────────────────────────────────────────────────────────────

  /** One `user.rank` handler run at the synthetic clock. */
  async rankRun(payload: Record<string, unknown>, options: UserRankOptions = {}): Promise<void> {
    const handle = createUserRankHandler({ ...this.h.deps, now: () => this.t }, options);
    await handle(parseJobPayload('user.rank', payload), { queue: 'user.rank', jobId: 's22' });
  }

  /** Deliver every undelivered `user.rank` intent of the user through the handler, until none. */
  async drain(options: UserRankOptions = {}): Promise<number> {
    let ran = 0;
    for (let round = 0; round < 30; round += 1) {
      const pending = await this.h.owner.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id::text AS id, payload FROM job_outbox
          WHERE queue = 'user.rank' AND delivered_at IS NULL AND payload->>'userId' = $1
          ORDER BY id`,
        [this.userId],
      );
      if (pending.rows.length === 0) return ran;
      for (const row of pending.rows) {
        await this.h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [
          row.id,
        ]);
        await this.rankRun(row.payload, options);
        ran += 1;
      }
    }
    throw new Error('the rank intents did not settle');
  }

  // ── Observation ──────────────────────────────────────────────────────────────────────────────

  async snapshot(): Promise<Map<string, SnapRow>> {
    const result = await this.h.owner.query<{
      article_id: string;
      lane: string;
      tier: number | null;
      p_like: number | null;
      score_source: string;
      rules_fired: string[];
      explain: unknown;
      label_suggestions: string[];
      next_rank_at: Date | null;
      scored_at: Date | null;
    }>(
      `SELECT article_id::text AS article_id, lane, tier, p_like, score_source, rules_fired, explain,
              label_suggestions::text[] AS label_suggestions, next_rank_at, scored_at
         FROM user_article WHERE user_id = $1`,
      [this.userId],
    );
    return new Map(
      result.rows.map((row) => [
        row.article_id,
        {
          lane: row.lane,
          tier: row.tier,
          p: row.p_like,
          source: row.score_source,
          rules: row.rules_fired,
          explain: row.explain,
          labelSuggestions: [...row.label_suggestions].sort(),
          nextRankAt: row.next_rank_at?.getTime() ?? null,
          scoredAt: row.scored_at?.getTime() ?? null,
        },
      ]),
    );
  }

  async counters(): Promise<Counters> {
    const user = await this.h.owner.query<{ r: string }>(
      `SELECT rank_revision::text AS r FROM users WHERE id = $1`,
      [this.userId],
    );
    const intents = await this.h.owner.query<{ full: number; total: number }>(
      `SELECT count(*) FILTER (WHERE payload->>'full' = 'true' AND payload->'cursor' IS NULL)::int AS full,
              count(*)::int AS total
         FROM job_outbox WHERE queue = 'user.rank' AND payload->>'userId' = $1`,
      [this.userId],
    );
    return {
      rankRevision: user.rows[0]!.r,
      fullIntents: intents.rows[0]!.full,
      rankIntents: intents.rows[0]!.total,
      flags: [...(await this.activeFlags())].sort().join(','),
    };
  }

  /**
   * The auto demotion flags active for the user at the synthetic clock (spec 06 §5): the count of
   * current dislikes in the 90-day window with the flag's reason (`stale`: dislikes rated stale)
   * against `autoMinDislikes`. Recomputed here from `loadRecentDislikes`, independently of the
   * rank handler.
   */
  async activeFlags(): Promise<Set<string>> {
    const min = await this.autoMinDislikes();
    const dislikes = await loadRecentDislikes(
      this.h.ownerDb,
      this.userId,
      new Date(this.t.getTime() - 90 * DAY),
    );
    const count = (match: (d: (typeof dislikes)[number]) => boolean) =>
      dislikes.filter(match).length;
    const active = new Set<string>();
    if (count((d) => d.reason === 'clickbait') >= min) active.add('clickbait');
    if (count((d) => d.reason === 'promo') >= min) active.add('promotional');
    if (count((d) => d.reason === 'shallow') >= min) active.add('shallow');
    if (count((d) => d.staleAtFeedback === true) >= min) active.add('stale');
    return active;
  }

  private async autoMinDislikes(): Promise<number> {
    const stored = await this.h.setting('ranker.thresholds');
    const demotion = (stored as { demotion?: { autoMinDislikes?: number } } | null)?.demotion;
    return demotion?.autoMinDislikes ?? 3;
  }

  // ── Oracle ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Compare the stored ranking with a full run's. Equal: lane, tier, p_like, score_source,
   * rules_fired, label_suggestions and the whole `explain` EXCEPT `explain.inputs.contextSha` and
   * `explain.inputs.rankRevision` (a row that did not change keeps the stamps of the run that wrote
   * it, which differ trivially from the full run's), and the stored `next_rank_at` must not be
   * later than the oracle's (a missing deadline is +infinity; an earlier one only causes a spurious
   * re-rank). Returns a description of the first differences, or null. The oracle run's writes
   * stay (they are the correct state to continue from).
   */
  async compareToOracle(allowMissing = false): Promise<string | null> {
    const stored = await this.snapshot();
    await this.rankRun({
      userId: this.userId,
      reason: 'oracle',
      full: true,
      snapshotAt: new Date(this.t.getTime() + 1000).toISOString(),
    });
    const fresh = await this.snapshot();
    const problems: string[] = [];
    for (const id of new Set([...stored.keys(), ...fresh.keys()])) {
      const a = stored.get(id);
      const b = fresh.get(id);
      // Never ranked (no row, or a placeholder row an action created) and no run happened.
      if (allowMissing && (a === undefined || a.scoredAt === null)) continue;
      if (a === undefined || b === undefined) {
        problems.push(
          `article ${id}: row ${a === undefined ? 'missing before' : 'missing after'} the oracle run`,
        );
        continue;
      }
      const diffs: string[] = [];
      const same = (name: string, x: unknown, y: unknown) => {
        if (JSON.stringify(x) !== JSON.stringify(y)) {
          diffs.push(`${name}: stored ${JSON.stringify(x)} vs oracle ${JSON.stringify(y)}`);
        }
      };
      same('lane', a.lane, b.lane);
      same('tier', a.tier, b.tier);
      same('p_like', a.p, b.p);
      same('score_source', a.source, b.source);
      same('rules_fired', a.rules, b.rules);
      same('label_suggestions', a.labelSuggestions, b.labelSuggestions);
      same('explain', stripStamps(a.explain), stripStamps(b.explain));
      if ((a.nextRankAt ?? Infinity) > (b.nextRankAt ?? Infinity)) {
        diffs.push(`next_rank_at: stored ${a.nextRankAt} is later than oracle ${b.nextRankAt}`);
      }
      if (diffs.length > 0)
        problems.push(`article ${id} (#${this.articles.indexOf(id)}): ${diffs.join('; ')}`);
    }
    return problems.length === 0 ? null : problems.join('\n');
  }

  // ── Steps ────────────────────────────────────────────────────────────────────────────────────

  /** Move the clock forward by a step (a minute) and apply `step`; false when it was a no-op. */
  async perform(step: Step): Promise<boolean> {
    this.t = new Date(this.t.getTime() + MINUTE);
    const article = (index: number): string => this.articles[index % this.articles.length]!;
    try {
      switch (step.k) {
        case 'read':
          return await this.run(article(step.a), (tx, base) => markArticleRead(tx, base));
        case 'open':
          return await this.run(article(step.a), (tx, base) => openArticle(tx, base));
        case 'unread':
          return await this.run(article(step.a), (tx, base) => markArticleUnread(tx, base));
        case 'unhide':
          return await this.run(article(step.a), (tx, base) => unhideArticle(tx, base));
        case 'bookmark':
          return await this.run(article(step.a), (tx, base) => bookmarkArticle(tx, base));
        case 'label':
          return await this.run(article(step.a), (tx, base) =>
            labelArticle(tx, { ...base, labelId: this.labelId }),
          );
        case 'unlabel':
          return await this.run(article(step.a), (tx, base) =>
            unlabelArticle(tx, { ...base, labelId: this.labelId }),
          );
        case 'rate':
          return await this.run(article(step.a), (tx, base) =>
            rateArticle(tx, {
              ...base,
              rating: step.rating,
              reason: step.rating === -1 ? step.reason : null,
              hide: step.hide,
            }),
          );
        case 'prompt':
          return await this.run(article(step.a), (tx, base) =>
            answerPrompt(tx, { ...base, liked: step.liked }),
          );
        case 'rateBulk': {
          const ids = [...new Set(step.as.map(article))];
          return await this.runMany(ids, (tx, targets, now, outbox) =>
            rateArticlesBulk(tx, {
              targets,
              rating: step.rating,
              now,
              outbox,
              matchFingerprint: this.h.matchFingerprint,
            }),
          );
        }
        case 'markRead': {
          const ids = [...new Set(step.as.map(article))];
          return await this.runMany(ids, (tx, targets, now, outbox) =>
            markArticlesRead(tx, { targets, now, outbox }),
          );
        }
        case 'undo': {
          const receipt = [...this.receipts]
            .reverse()
            .find((r) => !r.undone && r.epoch === this.epoch);
          if (receipt === undefined) return false;
          receipt.undone = true;
          await withTenant(this.appDb, this.userId, (tx) =>
            undoArticleMutation(tx, {
              mutationId: receipt.key,
              now: this.t,
              outbox: tenantOutbox(tx),
            }),
          );
          return true;
        }
        case 'jump':
          this.t = new Date(this.t.getTime() + step.ms);
          this.epoch += 1;
          // The next scheduled run (the cron / deadline wake-up) is an incremental rank.
          await this.rankRun({ userId: this.userId, reason: 'deadline' });
          return true;
        case 'arrive':
          await this.arrive(step);
          await this.rankRun({ userId: this.userId, reason: 'arrival' });
          return true;
      }
    } catch (error) {
      // A refused action (a stale fence, an expired undo, nothing to open) changed nothing.
      if (error instanceof AppError) return false;
      throw error;
    }
  }

  private async arrive(step: Extract<Step, { k: 'arrive' }>): Promise<void> {
    this.arrivals += 1;
    const id = await this.h.article({
      feedIds: [this.feeds[0]],
      title: `S22 arrival ${worlds}-${this.arrivals}`,
      firstSeenAt: this.t,
    });
    if (step.cluster !== null) {
      await this.h.owner.query(`UPDATE articles SET story_cluster_id = $2 WHERE id = $1`, [
        id,
        this.clusters[step.cluster],
      ]);
    }
    await this.classify(id, step.p, 0.5, step.flag);
    this.articles.push(id);
  }

  private async fence(articleId: string): Promise<ActionInput['fence']> {
    const state = await this.h.owner.query<{ state_version: string }>(
      `SELECT state_version::text AS state_version FROM user_article
        WHERE user_id = $1 AND article_id = $2`,
      [this.userId, articleId],
    );
    return { stateVersion: state.rows[0]?.state_version ?? '0', contentRevision: '1' };
  }

  private async run<R extends ActionResult>(
    articleId: string,
    fn: (tx: TenantTx, base: ActionInput) => Promise<R>,
  ): Promise<boolean> {
    const fence = await this.fence(articleId);
    const result = await withTenant(this.appDb, this.userId, async (tx) => {
      const done = await fn(tx, {
        articleId,
        fence,
        now: this.t,
        outbox: tenantOutbox(tx),
        matchFingerprint: this.h.matchFingerprint,
      });
      await this.saveReceipt(tx, done);
      return done;
    });
    return result.changed;
  }

  private async runMany(
    ids: string[],
    fn: (
      tx: TenantTx,
      targets: Array<{ articleId: string; fence: ActionInput['fence'] }>,
      now: Date,
      outbox: ReturnType<typeof tenantOutbox>,
    ) => Promise<ActionResult>,
  ): Promise<boolean> {
    const targets: Array<{ articleId: string; fence: ActionInput['fence'] }> = [];
    for (const articleId of ids) targets.push({ articleId, fence: await this.fence(articleId) });
    const result = await withTenant(this.appDb, this.userId, async (tx) => {
      const done = await fn(tx, targets, this.t, tenantOutbox(tx));
      await this.saveReceipt(tx, done);
      return done;
    });
    return result.changed;
  }

  private async saveReceipt(tx: TenantTx, result: ActionResult): Promise<void> {
    if (result.undo === undefined) return;
    const key = randomUUID();
    await saveMutation(tx, {
      key,
      requestHash: 'x'.repeat(8),
      route: 'POST /test',
      status: 200,
      response: {},
      undo: result.undo,
    });
    this.receipts.push({ key, epoch: this.epoch, undone: false });
  }
}

/** The explain with the stamps that a changed context or a rank bump alters trivially removed. */
export function stripStamps(explain: unknown): unknown {
  if (typeof explain !== 'object' || explain === null) return explain;
  const copy = JSON.parse(JSON.stringify(explain)) as { inputs?: Record<string, unknown> };
  if (copy.inputs !== undefined) {
    delete copy.inputs['contextSha'];
    delete copy.inputs['rankRevision'];
  }
  return copy;
}
