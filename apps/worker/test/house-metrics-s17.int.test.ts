import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  DAY,
  HOUR,
  MINUTE,
  MetricsS17World,
  SECRET_TITLE,
  pick,
  utcDay,
  type Source,
  type WorldArticle,
} from './support/metrics-s17-world.js';

/**
 * S17 (spec 10 §7, binding): the online metrics that `house.metrics` did not yet store. Same fake
 * clock as `house-metrics.int.test.ts` (00:10 UTC, 100 days after the real date; the handler
 * computes the previous UTC day), same direct-SQL feedback with a `before` snapshot.
 *
 * The snapshot shape these tests fix (each name is a rule of the S17 brief, listed in DECISIONS):
 *
 *   windows.<d7|d30>.bySource.<cards|model|degraded>.<lane>        {likeRate, rated}
 *   windows.<d7|d30>.byLanguage.<lang|unknown>.<lane>              {likeRate, rated}
 *   windows.<d7|d30>.byOrigin.<prompt|voluntary>.<lane>            {likeRate, rated}
 *   windows.<d7|d30>.hides                                         {byReason: {<reason|none>: n}, unhides: n}
 *   windows.<d7|d30>.models                                        (see the personal-models test)
 *   windows.<d7|d30>.engine                                        (see the engine tests)
 *   current                                                        (state as of the run, see the reader tests)
 *
 * and, besides the existing `lanes`/`regret`, `windows.*.lanes` counts prompt answers as ratings.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 0, 10));
const YESTERDAY = utcDay(new Date(NOW.getTime() - DAY));
/** `daysBack` days before yesterday, at `hour` UTC. */
const onDay = (daysBack: number, hour = 10): Date =>
  new Date(Date.parse(`${YESTERDAY}T00:00:00.000Z`) - daysBack * DAY + hour * HOUR);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

let h: ClassifyHarness;
let w: MetricsS17World;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new MetricsS17World(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await w.reset();
});

async function articles(count: number): Promise<WorldArticle[]> {
  const out: WorldArticle[] = [];
  for (let i = 0; i < count; i += 1) out.push(await w.article());
  return out;
}

const rate = (rated: number, likes: number) => ({ likeRate: likes / rated, rated });

/** The `{likeRate, rated}` cell of a split, `{likeRate: null, rated: 0}` when the split has no such cell. */
function cell(snapshot: unknown, path: string): { likeRate: number | null; rated: number } {
  const value = pick(snapshot, path) as { likeRate?: number | null; rated?: number } | undefined;
  return { likeRate: value?.likeRate ?? null, rated: value?.rated ?? 0 };
}

function expectCell(
  snapshot: unknown,
  path: string,
  expected: { likeRate: number | null; rated: number },
): void {
  const actual = cell(snapshot, path);
  expect(actual.rated, `${path}.rated`).toBe(expected.rated);
  if (expected.likeRate === null) expect(actual.likeRate, `${path}.likeRate`).toBeNull();
  else expect(actual.likeRate, `${path}.likeRate`).toBeCloseTo(expected.likeRate, 6);
}

describe('S17 A1: like-rate splits from feedback-time before snapshots (spec 10 §7)', () => {
  it('splits the like-rate per lane by source (cards/model/degraded) with denominators for 7 and 30 days', async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const [a, b, c, d, e, f, g, k, i, j] = await articles(10);
    const at = (n: number) => new Date(onDay(0, 9).getTime() + n * MINUTE);
    const r = (
      article: WorldArticle,
      rating: 1 | -1,
      lane: 'for_you' | 'maybe',
      source: Source | undefined,
      n: number,
      user = u1,
    ) =>
      w.rating(user, article, rating, {
        lane,
        ...(source === undefined ? {} : { source }),
        at: at(n),
      });

    await r(a!, 1, 'for_you', 'cards', 1);
    await r(b!, -1, 'for_you', 'cards', 2);
    await r(c!, 1, 'for_you', 'model', 3);
    await r(d!, 1, 'for_you', 'model', 4, u2);
    await r(e!, -1, 'for_you', 'degraded', 5);
    await r(f!, 1, 'maybe', 'cards', 6);
    await r(g!, -1, 'maybe', 'model', 7);
    await r(k!, -1, 'maybe', 'model', 8, u2);
    await r(i!, 1, 'maybe', undefined, 9); // a legacy snapshot: no scoreSource
    // 30 days only: ten days back.
    await w.rating(u1, j!, 1, { lane: 'for_you', source: 'cards', at: onDay(10) });
    // The cached state has moved on since: the split must not read it.
    for (const article of [a!, b!, c!, d!, e!, f!, g!, k!, i!, j!]) {
      await w.cachedLane(u1, article, 'hidden');
    }

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expectCell(s, 'windows.d7.bySource.cards.for_you', rate(2, 1));
    expectCell(s, 'windows.d7.bySource.model.for_you', rate(2, 2));
    expectCell(s, 'windows.d7.bySource.degraded.for_you', rate(1, 0));
    expectCell(s, 'windows.d7.bySource.cards.maybe', rate(1, 1));
    expectCell(s, 'windows.d7.bySource.model.maybe', rate(2, 0));
    expectCell(s, 'windows.d7.bySource.degraded.maybe', { likeRate: null, rated: 0 });
    // The legacy snapshot is in the lane totals but in no source bucket.
    expect(pick(s, 'windows.d7.lanes.maybe.rated')).toBe(4);
    expectCell(s, 'windows.d30.bySource.cards.for_you', rate(3, 2));
    expectCell(s, 'windows.d30.bySource.model.for_you', rate(2, 2));
  });

  it('splits the like-rate per lane by article language, unknown language apart', async () => {
    const u = await w.user();
    const [a, b, c, d, e, f] = await articles(6);
    for (const [article, lang] of [
      [a!, 'en'],
      [b!, 'en'],
      [c!, 'sk'],
      [d!, 'sk'],
      [e!, 'cs'],
      [f!, null],
    ] as const) {
      await w.lang(article, lang);
    }
    const at = (n: number) => new Date(onDay(0, 9).getTime() + n * MINUTE);
    await w.rating(u, a!, 1, { lane: 'for_you', source: 'cards', at: at(1) });
    await w.rating(u, b!, -1, { lane: 'for_you', source: 'cards', at: at(2) });
    await w.rating(u, c!, 1, { lane: 'for_you', source: 'model', at: at(3) });
    await w.rating(u, d!, -1, { lane: 'maybe', source: 'model', at: at(4) });
    await w.rating(u, e!, 1, { lane: 'maybe', source: 'cards', at: at(5) });
    await w.rating(u, f!, 1, { lane: 'for_you', source: 'cards', at: at(6) });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expectCell(s, 'windows.d7.byLanguage.en.for_you', rate(2, 1));
    expectCell(s, 'windows.d7.byLanguage.sk.for_you', rate(1, 1));
    expectCell(s, 'windows.d7.byLanguage.sk.maybe', rate(1, 0));
    expectCell(s, 'windows.d7.byLanguage.cs.maybe', rate(1, 1));
    expectCell(s, 'windows.d7.byLanguage.unknown.for_you', rate(1, 1));
    expectCell(s, 'windows.d30.byLanguage.en.for_you', rate(2, 1));
  });

  it('splits prompt and calibration ratings from voluntary ones and counts prompt answers as ratings', async () => {
    const u = await w.user();
    const [a, b, c, d, e, f] = await articles(6);
    const at = (n: number) => new Date(onDay(0, 9).getTime() + n * MINUTE);
    await w.rating(u, a!, 1, { lane: 'for_you', source: 'cards', at: at(1) });
    await w.rating(u, b!, -1, { lane: 'for_you', source: 'cards', at: at(2) });
    await w.rating(u, c!, 1, {
      lane: 'for_you',
      source: 'cards',
      at: at(3),
      kind: 'prompt_answer',
    });
    await w.rating(u, d!, -1, { lane: 'maybe', source: 'cards', at: at(4), kind: 'prompt_answer' });
    await w.rating(u, e!, 1, { lane: 'maybe', source: 'cards', at: at(5), calibration: true });
    await w.rating(u, f!, 1, { lane: 'everything', source: 'cards', at: at(6) });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expectCell(s, 'windows.d7.byOrigin.voluntary.for_you', rate(2, 1));
    expectCell(s, 'windows.d7.byOrigin.prompt.for_you', rate(1, 1));
    expectCell(s, 'windows.d7.byOrigin.prompt.maybe', rate(2, 1));
    expectCell(s, 'windows.d7.byOrigin.voluntary.maybe', { likeRate: null, rated: 0 });
    expectCell(s, 'windows.d7.byOrigin.voluntary.everything', rate(1, 1));
    // A prompt answer is an explicit rating: the lane totals contain it (the day's too).
    expect(pick(s, 'windows.d7.lanes.for_you.rated')).toBe(3);
    expect(pick(s, 'windows.d7.lanes.maybe.rated')).toBe(2);
    expect(pick(s, 'lanes.for_you.rated')).toBe(3);
  });

  it('keeps one effective explicit rating per user and article: undo and unrate remove it in every split', async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const [p1, p2, p3, p4, p5, p6] = await articles(6);
    const at = (n: number) => new Date(onDay(0, 9).getTime() + n * MINUTE);
    // p1: +1 then -1 -> one rating, the dislike.
    await w.rating(u1, p1!, 1, { lane: 'for_you', source: 'cards', at: at(1) });
    await w.rating(u1, p1!, -1, { lane: 'for_you', source: 'cards', at: at(2) });
    // p2: a prompt answer, undone -> nothing (the undo names the prompt_answer action).
    await w.rating(u1, p2!, 1, {
      lane: 'for_you',
      source: 'cards',
      at: at(3),
      kind: 'prompt_answer',
    });
    await w.undoAction(u1, p2!, 'prompt_answer', at(4));
    // p3: unrated.
    await w.rating(u1, p3!, 1, { lane: 'for_you', source: 'cards', at: at(5) });
    await w.unrating(u1, p3!, 'for_you', 'cards', at(6));
    // p4: undone rating.
    await w.rating(u1, p4!, 1, { lane: 'for_you', source: 'cards', at: at(7) });
    await w.undoAction(u1, p4!, 'rating', at(8));
    // p5: stays, in Maybe/model.
    await w.rating(u1, p5!, -1, { lane: 'maybe', source: 'model', at: at(9) });
    // p6: two users rate the same article: two ratings.
    await w.rating(u1, p6!, 1, { lane: 'for_you', source: 'cards', at: at(10) });
    await w.rating(u2, p6!, 1, { lane: 'for_you', source: 'cards', at: at(11) });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expectCell(s, 'windows.d7.bySource.cards.for_you', rate(3, 2));
    expectCell(s, 'windows.d7.byOrigin.voluntary.for_you', rate(3, 2));
    expectCell(s, 'windows.d7.byOrigin.prompt.for_you', { likeRate: null, rated: 0 });
    expectCell(s, 'windows.d7.bySource.model.maybe', rate(1, 0));
    expect(pick(s, 'windows.d7.lanes.for_you.rated')).toBe(3);
  });
});

describe('S17 A2: Maybe share, classifying backlog and source mix (reader policy, spec 10 §7)', () => {
  async function readerWorld() {
    const feed = await w.feed();
    const u1 = await w.user();
    const u2 = await w.user();
    const long = new Date(NOW.getTime() - 30 * DAY);
    await w.subscribe(u1, feed, 'active', long);
    await w.subscribe(u2, feed, 'active', long);
    await w.preferences(u2, { defaultTier: 4 });
    const fresh = async () => w.carried(feed, ago(2 * HOUR));
    const rows: Array<[typeof u1, string, Parameters<typeof w.ranked>[2]]> = [];
    // u1 (minimum tier 1): three For You (cards), two Maybe (model), one Everything (degraded).
    for (let n = 0; n < 3; n += 1)
      rows.push([u1, (await fresh()).id, { lane: 'for_you', source: 'cards' }]);
    for (let n = 0; n < 2; n += 1)
      rows.push([u1, (await fresh()).id, { lane: 'maybe', source: 'model' }]);
    rows.push([u1, (await fresh()).id, { lane: 'everything', source: 'degraded' }]);
    // Not counted: read, archived, Hidden, still New.
    rows.push([u1, (await fresh()).id, { lane: 'maybe', source: 'model', read: true }]);
    rows.push([u1, (await fresh()).id, { lane: 'maybe', source: 'model', archived: true }]);
    rows.push([u1, (await fresh()).id, { lane: 'hidden', source: 'cards' }]);
    rows.push([u1, (await fresh()).id, { lane: 'new', source: 'none', tier: null }]);
    // Two Maybe members of one story fold into one visible row.
    const s1 = await fresh();
    const s2 = await fresh();
    await w.cluster([s1.id, s2.id]);
    rows.push([u1, s1.id, { lane: 'maybe', source: 'cards', pLike: 0.55 }]);
    rows.push([u1, s2.id, { lane: 'maybe', source: 'cards', pLike: 0.45 }]);
    // u2 (minimum tier 4): tier 2 Maybe and tier 3 For You are below it; tier 5 Maybe and tier 4 For You count.
    rows.push([u2, (await fresh()).id, { lane: 'maybe', source: 'model', tier: 2 }]);
    rows.push([u2, (await fresh()).id, { lane: 'for_you', source: 'cards', tier: 3 }]);
    rows.push([u2, (await fresh()).id, { lane: 'maybe', source: 'model', tier: 5 }]);
    rows.push([u2, (await fresh()).id, { lane: 'for_you', source: 'cards', tier: 4 }]);
    for (const [user, articleId, options] of rows) await w.ranked(user, articleId, options);
  }

  it('reports Maybe / scored visible unread rows after the reader list folding, tier and status policy', async () => {
    await readerWorld();

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // u1: Maybe 2 + 1 folded story = 3, scored 3 + 3 + 1 = 7; u2: Maybe 1, scored 2.
    expect(pick(s, 'current.maybeShare.maybe')).toBe(4);
    expect(pick(s, 'current.maybeShare.scored')).toBe(9);
    expect(pick(s, 'current.maybeShare.share') as number).toBeCloseTo(4 / 9, 6);
  });

  it('reports the source mix of the counted rows', async () => {
    await readerWorld();

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // Counted: cards 3 + 1 (the folded story shows its best member) + 1 (u2 For You) = 5,
    // model 2 + 1 (u2 Maybe) = 3, degraded 1.
    expect(pick(s, 'current.sourceMix.cards')).toBe(5);
    expect(pick(s, 'current.sourceMix.model')).toBe(3);
    expect(pick(s, 'current.sourceMix.degraded')).toBe(1);
  });

  it('reports no Maybe share when nothing is scored, and a zero backlog', async () => {
    const u = await w.user();
    await w.rating(u, (await articles(1))[0]!, 1, {
      lane: 'for_you',
      source: 'cards',
      at: onDay(0),
    });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'current.maybeShare.scored')).toBe(0);
    expect(pick(s, 'current.maybeShare.share') ?? null).toBeNull();
    expect(pick(s, 'current.classifyingBacklog')).toBe(0);
  });

  it('counts the classifying backlog as due jobs of the classification queues only', async () => {
    await w.jobs('article.enrich', 5, ago(10 * MINUTE));
    await w.jobs('article.match', 2, ago(10 * MINUTE), 'retry');
    await w.jobs('article.translate', 1, ago(MINUTE));
    await w.jobs('article.cluster', 1, ago(MINUTE));
    await w.jobs('article.match', 3, new Date(NOW.getTime() + HOUR)); // a cooldown: not yet due
    await w.jobs('article.enrich', 4, ago(10 * MINUTE), 'completed');
    await w.jobs('article.extract', 6, ago(10 * MINUTE)); // ingestion, not classification

    await w.run(NOW);

    expect(pick(await w.snapshot(YESTERDAY), 'current.classifyingBacklog')).toBe(9);
  });
});

describe('S17 A3: observed recovery and hide/unhide reasons', () => {
  it('counts hides by reason and unhides for 7 and 30 days next to the recovery numerator and denominator', async () => {
    const u = await w.user();
    const [a, b, c, d, e, f, g] = await articles(7);
    const at = (n: number) => new Date(onDay(0, 9).getTime() + n * MINUTE);
    await w.rating(u, a!, -1, {
      lane: 'for_you',
      source: 'cards',
      at: at(1),
      hide: true,
      reason: 'off_topic',
    });
    await w.rating(u, b!, -1, {
      lane: 'for_you',
      source: 'cards',
      at: at(2),
      hide: true,
      reason: 'off_topic',
    });
    await w.rating(u, c!, -1, {
      lane: 'maybe',
      source: 'cards',
      at: at(3),
      hide: true,
      reason: 'clickbait',
    });
    await w.rating(u, d!, -1, { lane: 'maybe', source: 'cards', at: at(4), hide: true });
    // A dislike with a reason that hides nothing is not a hide.
    await w.rating(u, e!, -1, { lane: 'maybe', source: 'cards', at: at(5), reason: 'seen' });
    await w.unhide(u, a!, at(6));
    await w.unhide(u, c!, at(7));
    // Older: 30 days only.
    await w.rating(u, f!, -1, {
      lane: 'for_you',
      source: 'cards',
      at: onDay(12),
      hide: true,
      reason: 'promo',
    });
    await w.unhide(u, f!, onDay(11));
    // Recovery: opened from Everything.
    await w.open(u, g!, 'everything', at(8));

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.hides.byReason.off_topic')).toBe(2);
    expect(pick(s, 'windows.d7.hides.byReason.clickbait')).toBe(1);
    expect(pick(s, 'windows.d7.hides.byReason.none')).toBe(1);
    expect(pick(s, 'windows.d7.hides.byReason.seen') ?? 0).toBe(0);
    expect(pick(s, 'windows.d7.hides.byReason.promo') ?? 0).toBe(0);
    expect(pick(s, 'windows.d7.hides.unhides')).toBe(2);
    expect(pick(s, 'windows.d30.hides.byReason.promo')).toBe(1);
    expect(pick(s, 'windows.d30.hides.byReason.off_topic')).toBe(2);
    expect(pick(s, 'windows.d30.hides.unhides')).toBe(3);
    // The recovery pair stays: numerator and eligible denominator.
    expect(pick(s, 'windows.d7.regret.numerator')).toBe(1);
    expect(pick(s, 'windows.d7.regret.denominator')).toBe(1);
  });
});

describe('S17 A4: personal models', () => {
  /** The median of `values` (mean of the middle two for an even count). */
  const median = (values: number[]): number => {
    const sorted = [...values].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  it('reports activation rate, effective sample and skip counts, median paired validation deltas, invalidation and time on cards only', async () => {
    const [u1, u2, u3, u4, u5, u6] = [
      await w.user(),
      await w.user(),
      await w.user(),
      await w.user(),
      await w.user(),
      await w.user(),
    ];
    const t = (hoursAgo: number) => ago(hoursAgo * HOUR);
    // u1, u2: activated and active. u3: rejected. u4: activated, then invalidated and never back.
    // u5: invalidated 6 h ago, a new model activated 4 h ago (2 h on cards only).
    // u6: a superseded attempt (counts nowhere) and an older model replaced by a newer one (not an invalidation).
    await w.model(u1, {
      version: 1,
      status: 'activated',
      active: true,
      trainedAt: t(20),
      nExplicit: 60,
      skipped: { no_features: 3, no_consent: 2 },
      cvAuc: 0.8,
      baselineAuc: 0.7,
      cvLogloss: 0.5,
      baselineLogloss: 0.6,
    });
    await w.model(u2, {
      version: 1,
      status: 'activated',
      active: true,
      trainedAt: t(19),
      nExplicit: 40,
      skipped: { no_features: 1 },
      cvAuc: 0.75,
      baselineAuc: 0.72,
      cvLogloss: 0.55,
      baselineLogloss: 0.58,
    });
    await w.model(u3, {
      version: 1,
      status: 'rejected',
      trainedAt: t(18),
      nExplicit: 35,
      cvAuc: 0.55,
      baselineAuc: 0.6,
      cvLogloss: 0.7,
      baselineLogloss: 0.65,
    });
    await w.model(u4, {
      version: 1,
      status: 'activated',
      trainedAt: t(22),
      nExplicit: 50,
      deactivatedAt: t(10),
      cvAuc: 0.9,
      baselineAuc: 0.8,
      cvLogloss: 0.4,
      baselineLogloss: 0.5,
    });
    await w.model(u5, {
      version: 1,
      status: 'activated',
      trainedAt: t(23),
      nExplicit: 45,
      deactivatedAt: t(6),
      cvAuc: 0.7,
      baselineAuc: 0.68,
      cvLogloss: 0.6,
      baselineLogloss: 0.61,
    });
    await w.model(u5, {
      version: 2,
      status: 'activated',
      active: true,
      trainedAt: t(4),
      nExplicit: 47,
      cvAuc: 0.78,
      baselineAuc: 0.7,
      cvLogloss: 0.52,
      baselineLogloss: 0.6,
    });
    await w.model(u6, {
      version: 1,
      status: 'activated',
      trainedAt: t(21),
      nExplicit: 30,
      cvAuc: 0.6,
      baselineAuc: 0.58,
      cvLogloss: 0.64,
      baselineLogloss: 0.66,
    });
    await w.model(u6, {
      version: 2,
      status: 'activated',
      active: true,
      trainedAt: t(15),
      nExplicit: 33,
      cvAuc: 0.62,
      baselineAuc: 0.58,
      cvLogloss: 0.62,
      baselineLogloss: 0.66,
    });
    await w.model(u6, {
      version: 3,
      status: 'superseded',
      trainedAt: t(5),
      nExplicit: 99,
      skipped: { no_features: 50 },
      cvAuc: 0.99,
      baselineAuc: 0.1,
      cvLogloss: 0.01,
      baselineLogloss: 0.9,
    });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // Terminal attempts (activated or rejected): 8; activated 7, rejected 1.
    expect(pick(s, 'windows.d7.models.activation.attempts')).toBe(8);
    expect(pick(s, 'windows.d7.models.activation.activated')).toBe(7);
    expect(pick(s, 'windows.d7.models.activation.rate') as number).toBeCloseTo(7 / 8, 6);
    // nExplicit 60 + 40 + 35 + 50 + 45 + 47 + 30 + 33; the superseded attempt is left out.
    expect(pick(s, 'windows.d7.models.samples.explicit')).toBe(340);
    expect(pick(s, 'windows.d7.models.skipped.no_features')).toBe(4);
    expect(pick(s, 'windows.d7.models.skipped.no_consent')).toBe(2);
    // Paired deltas over the 8 terminal attempts, validation minus baseline.
    const dAuc = [0.1, 0.03, -0.05, 0.1, 0.02, 0.08, 0.02, 0.04];
    const dLoss = [-0.1, -0.03, 0.05, -0.1, -0.01, -0.08, -0.02, -0.04];
    expect(pick(s, 'windows.d7.models.paired')).toBe(8);
    expect(pick(s, 'windows.d7.models.medianDeltaAuc') as number).toBeCloseTo(median(dAuc), 6);
    expect(pick(s, 'windows.d7.models.medianDeltaLogloss') as number).toBeCloseTo(median(dLoss), 6);
    // Invalidated: u4 and u5; u6's replaced model is not one.
    expect(pick(s, 'windows.d7.models.invalidation.invalidated')).toBe(2);
    expect(pick(s, 'windows.d7.models.invalidation.rate') as number).toBeCloseTo(2 / 7, 6);
    // u4 has been on cards only for 10 h and still is; u5 for 2 h.
    expect(pick(s, 'windows.d7.models.cardsOnly.hours') as number).toBeCloseTo(12, 6);
    expect(pick(s, 'windows.d7.models.cardsOnly.users')).toBe(2);
  });
});

describe('S17 A4b: invalidation rate denominator (R2)', () => {
  it('divides by the models active at any point in the window, so the rate never exceeds 1', async () => {
    const [u1, u2, u3, u4, u5] = [
      await w.user(),
      await w.user(),
      await w.user(),
      await w.user(),
      await w.user(),
    ];
    const attempt = { version: 1, status: 'activated' as const, nExplicit: 40 };
    // u1, u2: activated before the 7-day window and invalidated inside it.
    await w.model(u1, { ...attempt, trainedAt: ago(20 * DAY), deactivatedAt: ago(10 * HOUR) });
    await w.model(u2, { ...attempt, trainedAt: ago(25 * DAY), deactivatedAt: ago(30 * HOUR) });
    // u3: activated inside the window and still active.
    await w.model(u3, { ...attempt, trainedAt: ago(5 * HOUR), active: true });
    // u4: invalidated before the window (not active in it); u5: replaced before it by a newer model.
    await w.model(u4, { ...attempt, trainedAt: ago(30 * DAY), deactivatedAt: ago(15 * DAY) });
    await w.model(u5, { ...attempt, trainedAt: ago(40 * DAY) });
    await w.model(u5, { ...attempt, version: 2, trainedAt: ago(20 * DAY), active: true });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.models.activation.activated')).toBe(1);
    expect(pick(s, 'windows.d7.models.invalidation.invalidated')).toBe(2);
    // u1, u2 and u3 were active in the window; u5's version 2 (activated before it) is a fourth.
    expect(pick(s, 'windows.d7.models.invalidation.rate') as number).toBeCloseTo(2 / 4, 6);
    expect(pick(s, 'windows.d7.models.invalidation.rate') as number).toBeLessThanOrEqual(1);
  });
});

describe('S17 A5: engine latency, errors, coverage and billed cost', () => {
  it('reports p50/p95 live latency, errors and output coverage over live calls only', async () => {
    const u = await w.user();
    const feed = await w.feed();
    await w.subscribe(u, feed, 'active', new Date(NOW.getTime() - 30 * DAY));
    const article = await w.carried(feed, onDay(0, 6));
    // 21 ok live calls with latencies 100..2100: p50 1100, p95 2000.
    for (let n = 1; n <= 21; n += 1) {
      await w.call({
        kind: n % 2 === 0 ? 'match' : 'enrich',
        latencyMs: n * 100,
        articleId: article.id,
        at: onDay(0, 7),
      });
    }
    // Four failures without a latency, one of them a different live kind.
    await w.call({
      kind: 'enrich',
      status: 'error',
      latencyMs: null,
      articleId: article.id,
      at: onDay(0, 8),
    });
    await w.call({
      kind: 'enrich',
      status: 'timeout',
      latencyMs: null,
      articleId: article.id,
      at: onDay(0, 8),
    });
    await w.call({
      kind: 'match',
      status: 'rate_limited',
      latencyMs: null,
      articleId: article.id,
      at: onDay(0, 8),
    });
    await w.call({
      kind: 'cluster',
      status: 'invalid_response',
      latencyMs: null,
      articleId: article.id,
      at: onDay(0, 8),
    });
    // Not live: evaluation, credential probes, translation by LibreTranslate. Their latency is huge.
    await w.call({ kind: 'eval', latencyMs: 99_999, articleId: article.id, at: onDay(0, 9) });
    await w.call({ kind: 'credential_probe', latencyMs: 99_999, at: onDay(0, 9) });
    await w.call({
      engine: 'libretranslate',
      kind: 'translate',
      latencyMs: 99_999,
      articleId: article.id,
      at: onDay(0, 9),
    });
    // Outside the 7 days (30 days only).
    await w.call({ kind: 'enrich', latencyMs: 50_000, articleId: article.id, at: onDay(12) });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.engine.latencyMs.p50')).toBe(1100);
    expect(pick(s, 'windows.d7.engine.latencyMs.p95')).toBe(2000);
    expect(pick(s, 'windows.d7.engine.calls')).toBe(25);
    expect(pick(s, 'windows.d7.engine.errors')).toBe(4);
    // Output coverage: live calls that produced a usable output.
    expect(pick(s, 'windows.d7.engine.coverage') as number).toBeCloseTo(21 / 25, 6);
    expect(pick(s, 'windows.d30.engine.calls')).toBe(26);
  });

  it('reports the degraded share of the articles first seen in the window apart from fetched volume', async () => {
    const feed = await w.feed();
    for (let n = 0; n < 8; n += 1) await w.carried(feed, onDay(1, 6), 'enriched');
    await w.carried(feed, onDay(1, 6), 'degraded');
    await w.carried(feed, onDay(2, 6), 'degraded');
    await w.carried(feed, onDay(12, 6), 'degraded'); // 30 days only

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.engine.articles.firstSeen')).toBe(10);
    expect(pick(s, 'windows.d7.engine.articles.degraded')).toBe(2);
    expect(pick(s, 'windows.d7.engine.degradedShare') as number).toBeCloseTo(0.2, 6);
    expect(pick(s, 'windows.d30.engine.articles.degraded')).toBe(3);
  });

  /** Active, training and off feeds with their articles and calls; the numbers of the cost tests. */
  async function costWorld(options: { offFeedCall: boolean }) {
    const u = await w.user();
    const long = new Date(NOW.getTime() - 30 * DAY);
    const [active, training, off] = [await w.feed(), await w.feed(), await w.feed()];
    await w.subscribe(u, active, 'active', long);
    await w.subscribe(u, training, 'training', long);
    await w.subscribe(u, off, 'off', long);
    const a1 = await w.carried(active, onDay(0, 5));
    const a2 = await w.carried(active, onDay(0, 5));
    const t1 = await w.carried(training, onDay(0, 5));
    const t2 = await w.carried(training, onDay(0, 5));
    const o1 = await w.carried(off, onDay(0, 5));
    const base = { userId: u.id };
    await w.call({ ...base, kind: 'enrich', costUsd: 0.04, articleId: a1.id, at: onDay(0, 6) });
    await w.call({ ...base, kind: 'match', costUsd: 0.03, articleId: a1.id, at: onDay(0, 6) });
    await w.call({ ...base, kind: 'enrich', costUsd: 0.07, articleId: a2.id, at: onDay(0, 6) });
    // Selected training: three users select t1 (the first one pays), a fourth request is for t2.
    const u2 = await w.user();
    const u3 = await w.user();
    await w.request({
      userId: u.id,
      feedId: training,
      articleId: t1.id,
      status: 'complete',
      createdAt: onDay(0, 6),
    });
    await w.call({
      kind: 'enrich',
      costUsd: 0.02,
      articleId: t1.id,
      at: new Date(onDay(0, 6).getTime() + MINUTE),
    });
    await w.request({
      userId: u2.id,
      feedId: training,
      articleId: t1.id,
      status: 'complete',
      createdAt: new Date(onDay(0, 6).getTime() + 5 * MINUTE),
    });
    await w.request({
      userId: u3.id,
      feedId: training,
      articleId: t1.id,
      status: 'complete',
      createdAt: new Date(onDay(0, 6).getTime() + 10 * MINUTE),
    });
    await w.request({
      userId: u.id,
      feedId: training,
      articleId: t2.id,
      status: 'complete',
      createdAt: onDay(0, 7),
    });
    await w.call({
      kind: 'match',
      costUsd: 0.05,
      articleId: t2.id,
      at: new Date(onDay(0, 7).getTime() + MINUTE),
    });
    // The off feed's article is authorized by nobody: no call, unless the control asks for one.
    if (options.offFeedCall) {
      await w.call({ kind: 'enrich', costUsd: 0.01, articleId: o1.id, at: onDay(0, 8) });
    }
    return { u, a1, t1, o1 };
  }

  it('reports billed dollars per day, split between selected training and active arrivals', async () => {
    await costWorld({ offFeedCall: false });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // 0.14 active + 0.07 training = 0.21 over 7 days and over 30 days.
    expect(pick(s, 'windows.d7.engine.billedUsdPerDay') as number).toBeCloseTo(0.21 / 7, 6);
    expect(pick(s, 'windows.d30.engine.billedUsdPerDay') as number).toBeCloseTo(0.21 / 30, 6);
    expect(pick(s, 'windows.d7.engine.usd.active') as number).toBeCloseTo(0.14, 6);
    expect(pick(s, 'windows.d7.engine.usd.training') as number).toBeCloseTo(0.07, 6);
  });

  it('shows zero authorized provider calls for off feeds: an off feed article has no engine call', async () => {
    await costWorld({ offFeedCall: false });

    await w.run(NOW);

    expect(pick(await w.snapshot(YESTERDAY), 'windows.d7.engine.offFeedCalls')).toBe(0);
  });

  it('counts a provider call on an article only off feeds carry (control for the zero above)', async () => {
    await costWorld({ offFeedCall: true });

    await w.run(NOW);

    expect(pick(await w.snapshot(YESTERDAY), 'windows.d7.engine.offFeedCalls')).toBe(1);
  });

  it('reports shared cache savings: selected requests served by a call another request paid for', async () => {
    await costWorld({ offFeedCall: false });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // Four requests; the first of t1 and the one of t2 precede their call, two of t1 are served by it.
    expect(pick(s, 'windows.d7.engine.cache.requests')).toBe(4);
    expect(pick(s, 'windows.d7.engine.cache.hits')).toBe(2);
    expect(pick(s, 'windows.d7.engine.cache.savedUsd') as number).toBeCloseTo(0.04, 6);
  });

  it('keeps a call authorized by an active subscription active after the user unsubscribes and the snapshot is recomputed', async () => {
    const u = await w.user();
    const feed = await w.feed();
    await w.subscribe(u, feed, 'active', new Date(NOW.getTime() - 30 * DAY));
    const article = await w.carried(feed, onDay(0, 5));
    await w.call({
      kind: 'enrich',
      costUsd: 0.06,
      articleId: article.id,
      userId: u.id,
      demandBasis: 'active',
      at: onDay(0, 6),
    });
    await w.run(NOW);
    expect(pick(await w.snapshot(YESTERDAY), 'windows.d7.engine.usd.active') as number).toBeCloseTo(
      0.06,
      6,
    );

    // The user leaves: no subscription carries the article any more.
    await w.owner.query('DELETE FROM subscriptions WHERE user_id = $1', [u.id]);
    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.engine.usd.active') as number).toBeCloseTo(0.06, 6);
    expect(pick(s, 'windows.d7.engine.usd.other') as number).toBeCloseTo(0, 6);
    expect(pick(s, 'windows.d7.engine.offFeedCalls')).toBe(0);
  });

  it('keeps a call authorized by a selected request training after a later request for the same article', async () => {
    const u = await w.user();
    const feed = await w.feed();
    await w.subscribe(u, feed, 'training', new Date(NOW.getTime() - 30 * DAY));
    const article = await w.carried(feed, onDay(0, 5));
    // The call is made before any request exists in this world's rows, as a recorded basis.
    await w.call({
      kind: 'match',
      costUsd: 0.05,
      articleId: article.id,
      demandBasis: 'training',
      at: onDay(0, 6),
    });
    await w.run(NOW);
    expect(
      pick(await w.snapshot(YESTERDAY), 'windows.d7.engine.usd.training') as number,
    ).toBeCloseTo(0.05, 6);

    // A later request, and an activation that would now carry the article, change nothing.
    const u2 = await w.user();
    const feed2 = await w.feed();
    await w.subscribe(u2, feed2, 'active', new Date(NOW.getTime() - 30 * DAY));
    await h.carry(feed2, article.id, onDay(0, 5));
    await w.request({
      userId: u.id,
      feedId: feed,
      articleId: article.id,
      status: 'complete',
      createdAt: onDay(0, 7),
    });
    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.engine.usd.training') as number).toBeCloseTo(0.05, 6);
    expect(pick(s, 'windows.d7.engine.usd.active') as number).toBeCloseTo(0, 6);
  });

  it('counts an article call recorded as off-feed other even when a subscription would carry it now', async () => {
    const u = await w.user();
    const feed = await w.feed();
    const article = await w.carried(feed, onDay(0, 5));
    await w.call({
      kind: 'enrich',
      costUsd: 0.01,
      articleId: article.id,
      demandBasis: 'other',
      at: onDay(0, 6),
    });
    await w.subscribe(u, feed, 'active', new Date(NOW.getTime() - 30 * DAY));

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'windows.d7.engine.usd.other') as number).toBeCloseTo(0.01, 6);
    expect(pick(s, 'windows.d7.engine.offFeedCalls')).toBe(1);
  });

  it('reports the training queue age as the oldest pending or running selected request', async () => {
    const u = await w.user();
    const feed = await w.feed();
    await w.subscribe(u, feed, 'training', new Date(NOW.getTime() - 30 * DAY));
    const [a, b, c, d] = [
      await w.carried(feed, ago(5 * HOUR)),
      await w.carried(feed, ago(5 * HOUR)),
      await w.carried(feed, ago(5 * HOUR)),
      await w.carried(feed, ago(5 * HOUR)),
    ];
    await w.request({
      userId: u.id,
      feedId: feed,
      articleId: a.id,
      status: 'pending',
      createdAt: ago(3 * HOUR),
    });
    await w.request({
      userId: u.id,
      feedId: feed,
      articleId: b.id,
      status: 'running',
      createdAt: ago(HOUR),
    });
    await w.request({
      userId: u.id,
      feedId: feed,
      articleId: c.id,
      status: 'complete',
      createdAt: ago(9 * HOUR),
    });
    await w.request({
      userId: u.id,
      feedId: feed,
      articleId: d.id,
      status: 'cancelled',
      createdAt: ago(8 * HOUR),
    });

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'current.trainingQueue.pending')).toBe(2);
    expect(pick(s, 'current.trainingQueue.oldestAgeSeconds')).toBe(3 * 3600);
  });
});

describe('S17 A6: the snapshot stays bounded and anonymous', () => {
  it('holds no title, email, user id or per-user trace with every new aggregate populated, below 64 KB', async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const feed = await w.feed();
    await w.subscribe(u1, feed, 'active', new Date(NOW.getTime() - 30 * DAY));
    const list = await articles(6);
    for (const [index, article] of list.entries()) {
      const user = index % 2 === 0 ? u1 : u2;
      await w.lang(article, index % 3 === 0 ? 'sk' : 'en');
      await w.rating(user, article, index % 3 === 0 ? -1 : 1, {
        lane: 'for_you',
        source: index % 2 === 0 ? 'cards' : 'model',
        at: onDay(0),
        kind: index === 5 ? 'prompt_answer' : 'rate',
        hide: index === 0,
        reason: index === 0 ? 'off_topic' : null,
      });
      await w.open(u1, article, 'everything', onDay(0, 12));
      await w.cachedLane(u1, article, 'hidden');
    }
    await w.model(u1, {
      version: 1,
      status: 'activated',
      active: true,
      trainedAt: ago(5 * HOUR),
      cvAuc: 0.8,
      baselineAuc: 0.7,
      cvLogloss: 0.5,
      baselineLogloss: 0.6,
      skipped: { no_features: 1 },
    });
    await w.model(u2, {
      version: 1,
      status: 'activated',
      trainedAt: ago(9 * HOUR),
      deactivatedAt: ago(3 * HOUR),
      cvAuc: 0.8,
      baselineAuc: 0.7,
      cvLogloss: 0.5,
      baselineLogloss: 0.6,
    });
    const carried = await w.carried(feed, onDay(0, 5));
    await w.call({
      kind: 'enrich',
      costUsd: 0.02,
      userId: u1.id,
      articleId: carried.id,
      at: onDay(0, 6),
    });
    await w.request({
      userId: u1.id,
      feedId: feed,
      articleId: carried.id,
      status: 'pending',
      createdAt: ago(HOUR),
    });
    await w.ranked(u1, carried.id, { lane: 'maybe', source: 'model' });

    await w.run(NOW);

    const snapshot = await w.snapshot(YESTERDAY);
    expect(snapshot).toBeDefined();
    // The new aggregates are there (otherwise the scan below proves nothing).
    expect(pick(snapshot, 'windows.d7.bySource.cards.for_you.rated')).toBeGreaterThan(0);
    expect(pick(snapshot, 'windows.d7.models.activation.attempts')).toBe(2);
    expect(pick(snapshot, 'windows.d7.engine.calls')).toBe(1);
    expect(pick(snapshot, 'current.maybeShare.scored')).toBe(1);
    const text = JSON.stringify(snapshot);
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain('Marmalade-Hedgehog');
    expect(text).not.toContain('metrics.example.test');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u);
    for (const user of [u1, u2]) {
      expect(text).not.toContain(user.id);
      expect(text).not.toContain(user.email);
    }
    for (const article of [...list, carried]) {
      expect(text).not.toContain(article.title);
    }
    for (const article of list) expect(text).not.toContain(article.url);
  });

  it('still keeps 90 daily snapshots with the new aggregates in place', async () => {
    const u = await w.user();
    await w.rating(u, (await articles(1))[0]!, 1, {
      lane: 'for_you',
      source: 'cards',
      at: onDay(0),
    });
    const dayName = (daysBack: number): string => utcDay(onDay(daysBack));
    await w.setting(`metrics.daily.${dayName(89)}`, { lanes: {} });
    await w.setting(`metrics.daily.${dayName(90)}`, { lanes: {} });
    await w.setting(`metrics.daily.${dayName(200)}`, { lanes: {} });

    await w.run(NOW);

    expect(await w.snapshotKeys()).toEqual(
      [dayName(89), YESTERDAY].sort().map((day) => `metrics.daily.${day}`),
    );
    expect(pick(await w.snapshot(YESTERDAY), 'windows.d7.byOrigin.voluntary.for_you.rated')).toBe(
      1,
    );
  });
});
