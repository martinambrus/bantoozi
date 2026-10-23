import { seededRandom } from '@bantoozi/ranker';
import { parseJobPayload } from '@bantoozi/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { estimateAction, loadEstimateInputs } from '../src/estimate/inputs.js';
import { enqueueStaleEstimates } from '../src/estimate/sweep.js';
import { dispatch } from '../src/handlers/index.js';
import { loadRankerSettings } from '../src/rank/settings.js';
import { ClassifyHarness, DAY } from './support/classify.js';
import { textGenerator, vocabulary } from './support/estimate-run-world.js';

/**
 * FNF-VL-3 item 1, the scale ruler: `house.nightly-learn` over an owner-sized world must also record
 * a `user.estimate` intent for exactly the users whose estimate inputs changed. Four worlds in one
 * database (the owner with 5,000 ratings, 100 readers with a few dozen, 20 below the gate), then
 * sequential phases P0..P3. Prints one JSON line (also written to `<SCALE_EVIDENCE_DIR>/<label>.json`
 * when `SCALE_EVIDENCE_LABEL` and `SCALE_EVIDENCE_DIR` are set). Each nightly dispatch must stay under
 * `ESTIMATE_SWEEP_BUDGET_MS`.
 */

const BUDGET_MS = Number(process.env['ESTIMATE_SWEEP_BUDGET_MS'] ?? 30_000);
const QUEUE = 'user.estimate';

let h: ClassifyHarness;
let t0 = 0;
const out: Record<string, unknown> = { event: 'estimate-nightly-scale', budgetMs: BUDGET_MS };
const dispatchMs: number[] = [];

let ownerId = '';
let readersB: string[] = [];
let readersC: string[] = [];
const ratedByB = new Map<string, string[]>();
const ratingCountB = new Map<string, number>();
let feeds: string[] = [];

const ms = (since: number): number => Math.round(performance.now() - since);

async function seedArticles(
  prefix: string,
  texts: ReadonlyArray<{ title: string; excerpt: string }>,
  feedOf: (i: number) => string,
): Promise<string[]> {
  const urls = texts.map((_, i) => `https://nightly.example.test/${prefix}/${i}`);
  const seen = texts.map((_, i) => new Date(t0 - (i + 1) * 60_000).toISOString());
  await h.owner.query(
    `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                           content_hash, pipeline_state, lang, word_count)
     SELECT u.url, u.url, replace(u.url, 'https://', ''), u.title, u.title, u.excerpt,
            u.seen::timestamptz, encode(sha256(convert_to(u.url, 'UTF8')), 'hex'), 'extracted', 'en', 420
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(url, title, excerpt, seen)`,
    [urls, texts.map((t) => t.title), texts.map((t) => t.excerpt), seen],
  );
  const rows = await h.owner.query<{ id: string; url: string }>(
    `SELECT id::text AS id, url FROM articles WHERE url LIKE $1`,
    [`https://nightly.example.test/${prefix}/%`],
  );
  const idOfUrl = new Map(rows.rows.map((row) => [row.url, row.id]));
  const ids = urls.map((url) => idOfUrl.get(url) ?? '');
  if (ids.some((id) => id === '')) throw new Error(`the ${prefix} articles are missing`);
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
     SELECT x.feed_id::bigint, x.id, 'nightly-' || x.id, now()
       FROM unnest($1::bigint[], $2::text[]) AS x(id, feed_id)`,
    [ids, ids.map((_, i) => feedOf(i))],
  );
  return ids;
}

interface Rate {
  userId: string;
  articleId: string;
  rating: 1 | -1;
  ratedAt: Date;
}

async function insertRatings(rates: readonly Rate[]): Promise<void> {
  // The app logs a `rate` feedback event with every rating; the nightly user scan pages on them.
  await h.owner.query(
    `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
     SELECT x.u::uuid, x.a::bigint, 'rate', jsonb_build_object('rating', x.r), x.t::timestamptz
       FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS x(u, a, r, t)`,
    [
      rates.map((r) => r.userId),
      rates.map((r) => r.articleId),
      rates.map((r) => r.rating),
      rates.map((r) => r.ratedAt.toISOString()),
    ],
  );
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at)
     SELECT x.u::uuid, x.a::bigint, x.r, x.t::timestamptz
       FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS x(u, a, r, t)`,
    [
      rates.map((r) => r.userId),
      rates.map((r) => r.articleId),
      rates.map((r) => r.rating),
      rates.map((r) => r.ratedAt.toISOString()),
    ],
  );
}

/** Per-user `user.estimate` intent counts recorded after `since`. */
async function estimateIntents(since: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const intent of await h.intents(QUEUE, { since })) {
    const userId = String(intent.payload['userId']);
    counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return counts;
}

/** Runs one nightly sweep (optionally on a shifted clock) and returns its intents and wall time. */
async function nightly(now?: Date): Promise<{ counts: Map<string, number>; ms: number }> {
  const since = await h.mark();
  const handlers = now === undefined ? h.handlers : h.handlersWith({ now: () => now });
  const started = performance.now();
  await dispatch(handlers, 'house.nightly-learn', parseJobPayload('house.nightly-learn', {}), {
    queue: 'house.nightly-learn',
    jobId: 'direct',
  });
  const elapsed = ms(started);
  dispatchMs.push(elapsed);
  return { counts: await estimateIntents(since), ms: elapsed };
}

/** Each expected user exactly once and nobody else: compares the sorted `user:count` lines. */
function expectIntentsFor(counts: Map<string, number>, expected: readonly string[]): void {
  const actual = [...counts.entries()].map(([user, n]) => `${user}:${n}`).sort();
  const wanted = expected.map((user) => `${user}:1`).sort();
  expect.soft(counts.size, 'users with an intent').toBe(expected.length);
  expect
    .soft(actual.filter((line) => !wanted.includes(line)).slice(0, 5), 'unexpected')
    .toEqual([]);
  expect.soft(wanted.filter((line) => !actual.includes(line)).slice(0, 5), 'missing').toEqual([]);
}

async function modelsOf(userId: string): Promise<{ version: number; n: number } | null> {
  const result = await h.owner.query<{ version: number; n: number }>(
    `SELECT version, n FROM user_estimate_models WHERE user_id = $1 ORDER BY version DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function usersWithModels(): Promise<string[]> {
  const result = await h.owner.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM user_estimate_models`,
  );
  return result.rows.map((row) => row.user_id);
}

async function deliver(handlers?: ReturnType<ClassifyHarness['handlersWith']>): Promise<number> {
  const started = performance.now();
  if (handlers === undefined) {
    await h.run(QUEUE);
  } else {
    const pending = await h.intents(QUEUE, { pending: true });
    for (const intent of pending) {
      await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [intent.id]);
      await dispatch(handlers, QUEUE, parseJobPayload(QUEUE, intent.payload), {
        queue: QUEUE,
        jobId: intent.id,
      });
    }
  }
  return ms(started);
}

/**
 * The nightly clock of P1..P3. Time only moves forward in this world: once the owner's model was
 * retrained at this time (its 12 oldest ratings aged out), a sweep on the real clock would see those
 * ratings inside the window again and rightly find the model stale.
 */
const later = (): Date => new Date(t0 + 10.5 * DAY);

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  const seedStarted = performance.now();
  t0 = Date.now();
  const words = vocabulary(6_000);
  const rand = seededRandom('nightly-layout');
  feeds = [await h.feed('Nightly one'), await h.feed('Nightly two'), await h.feed('Nightly three')];

  // World A: the owner.
  ownerId = await h.user();
  for (const feed of feeds) await h.subscribe(ownerId, feed, 'active');
  const makeA = textGenerator(words, 'nightly-a');
  const textsA = Array.from({ length: 5_000 }, () => makeA(0.3));
  let likesLeft = 3_000 - textsA.filter((t) => t.lean === 1).length;
  const ratingsA: Array<1 | -1> = textsA.map((t) => {
    if (t.lean !== 0) return t.lean;
    if (likesLeft > 0) {
      likesLeft -= 1;
      return 1;
    }
    return -1;
  });
  if (ratingsA.filter((r) => r === 1).length !== 3_000) throw new Error('A needs 3,000 likes');
  const idsA = await seedArticles('a', textsA, (i) => feeds[i % 3] ?? '');
  let oldLikes = 0;
  let oldDislikes = 0;
  const ratesA: Rate[] = idsA.map((articleId, i) => {
    const rating = ratingsA[i] ?? 1;
    let days = rand() * 160;
    if (rating === 1 && oldLikes < 6) {
      oldLikes += 1;
      days = 169.6 + rand() * 0.4;
    } else if (rating === -1 && oldDislikes < 6) {
      oldDislikes += 1;
      days = 169.6 + rand() * 0.4;
    }
    return { userId: ownerId, articleId, rating, ratedAt: new Date(t0 - days * DAY) };
  });
  await insertRatings(ratesA);

  // World B: 100 readers on one feed each.
  const makeB = textGenerator(words, 'nightly-b');
  const textsB: Array<{ title: string; excerpt: string }> = [];
  const planB: Array<{ userIndex: number; rating: 1 | -1; days: number }> = [];
  readersB = [];
  for (let u = 0; u < 100; u += 1) {
    readersB.push(await h.user());
    const count = 30 + Math.floor(rand() * 31);
    ratingCountB.set(readersB[u] ?? '', count);
    for (let k = 0; k < count; k += 1) {
      const text = makeB(0.3);
      const rating: 1 | -1 =
        k < 12 ? (k % 2 === 0 ? 1 : -1) : text.lean !== 0 ? text.lean : rand() < 0.5 ? 1 : -1;
      textsB.push(text);
      planB.push({ userIndex: u, rating, days: rand() * 60 });
    }
  }
  const idsB = await seedArticles('b', textsB, (i) => feeds[(planB[i]?.userIndex ?? 0) % 3] ?? '');
  for (let u = 0; u < 100; u += 1)
    await h.subscribe(readersB[u] ?? '', feeds[u % 3] ?? '', 'active');
  const ratesB: Rate[] = planB.map((plan, i) => {
    const userId = readersB[plan.userIndex] ?? '';
    const articleId = idsB[i] ?? '';
    ratedByB.set(userId, [...(ratedByB.get(userId) ?? []), articleId]);
    return { userId, articleId, rating: plan.rating, ratedAt: new Date(t0 - plan.days * DAY) };
  });
  await insertRatings(ratesB);

  // World C: 20 readers with 3 ratings each, below the gate.
  const makeC = textGenerator(words, 'nightly-c');
  const textsC = Array.from({ length: 60 }, () => makeC(0.3));
  const idsC = await seedArticles('c', textsC, () => feeds[0] ?? '');
  readersC = [];
  const ratesC: Rate[] = [];
  for (let u = 0; u < 20; u += 1) {
    const userId = await h.user();
    readersC.push(userId);
    await h.subscribe(userId, feeds[0] ?? '', 'active');
    for (let k = 0; k < 3; k += 1) {
      ratesC.push({
        userId,
        articleId: idsC[u * 3 + k] ?? '',
        rating: k === 0 ? -1 : 1,
        ratedAt: new Date(t0 - rand() * 30 * DAY),
      });
    }
  }
  await insertRatings(ratesC);
  for (const table of [
    'articles',
    'feed_items',
    'user_article',
    'feedback_events',
    'subscriptions',
  ]) {
    await h.owner.query(`ANALYZE ${table}`);
  }
  out['seedMs'] = ms(seedStarted);

  // Train every A and B model through the real handler.
  const trainStarted = performance.now();
  await h.dispatch(QUEUE, { userId: ownerId });
  out['trainAMs'] = ms(trainStarted);
  const trainBStarted = performance.now();
  for (const userId of readersB) await h.dispatch(QUEUE, { userId });
  out['trainBMs'] = ms(trainBStarted);
  await h.clearOutbox();
}, 240_000);

afterAll(async () => {
  out['dispatchMs'] = dispatchMs;
  out['maxDispatchMs'] = Math.max(0, ...dispatchMs);
  const line = JSON.stringify(out);
  console.log(line);
  const label = process.env['SCALE_EVIDENCE_LABEL'];
  const dir = process.env['SCALE_EVIDENCE_DIR'];
  if (label !== undefined && label !== '' && dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${label}.json`, `${line}\n`);
  }
  await h?.close();
});

describe('the nightly estimate sweep at owner scale', () => {
  it('seeds the worlds and trains every A and B model', async () => {
    const withModel = new Set(await usersWithModels());
    expect(withModel.has(ownerId)).toBe(true);
    expect(readersB.every((user) => withModel.has(user))).toBe(true);
    expect(readersC.some((user) => withModel.has(user))).toBe(false);
    expect((await modelsOf(ownerId))?.n).toBe(5_000);
    const under = [...ratingCountB.values()].filter((n) => n < 40).length;
    expect(under).toBeGreaterThan(5);
    expect(under).toBeLessThan(95);
  });

  it('P0 unchanged: three sweeps record no user.estimate intent', async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await nightly();
      times.push(run.ms);
      expect.soft(run.counts.size, `P0 run ${i + 1} users with an intent`).toBe(0);
    }
    out['p0Ms'] = times;
    out['p0MedianMs'] = median(times);
  });

  it('P0 cost: the sweep alone, the owner alone, the 100 small readers alone', async () => {
    const { config } = await loadRankerSettings(h.db);
    const now = new Date();
    const sweeps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await enqueueStaleEstimates(h.deps, { now, config });
      sweeps.push(result.ms);
      expect.soft(result.enqueued, `sweep ${i + 1} enqueued`).toBe(0);
      expect.soft(result.failed, `sweep ${i + 1} failed`).toBe(0);
      expect.soft(result.examined, `sweep ${i + 1} examined (models of A and B)`).toBe(101);
    }
    const owner: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      estimateAction(await loadEstimateInputs(h.db, ownerId, config, now));
      owner.push(ms(started));
    }
    const smallStarted = performance.now();
    for (const userId of readersB) {
      estimateAction(await loadEstimateInputs(h.db, userId, config, now));
    }
    out['sweepMs'] = sweeps;
    out['sweepMedianMs'] = median(sweeps);
    out['ownerCheckMs'] = owner;
    out['ownerCheckMedianMs'] = median(owner);
    out['smallCheckMs'] = ms(smallStarted);
    expect(median(sweeps)).toBeLessThan(BUDGET_MS);
  });

  it('P1 aging: only the owner, whose 12 oldest ratings left the window', async () => {
    const run = await nightly(later());
    out['p1DispatchMs'] = run.ms;
    out['p1Intents'] = run.counts.size;
    expectIntentsFor(run.counts, [ownerId]);
    out['p1DeliverMs'] = await deliver(h.handlersWith({ now: later }));
    const model = await modelsOf(ownerId);
    expect.soft(model?.n, 'the owner model after aging').toBe(4_988);
    expect.soft(model?.version, 'a new version').toBeGreaterThan(1);
  });

  it('P2 targeted change: exactly the seven changed readers', async () => {
    const [lose1, lose2, lose3, title1, title2, unsub1, unsub2] = readersB.slice(
      10,
      17,
    ) as string[];
    for (const user of [lose1, lose2, lose3] as string[]) {
      await h.owner.query(
        `UPDATE user_article SET rating = NULL, rated_at = NULL WHERE user_id = $1 AND article_id = $2`,
        [user, ratedByB.get(user)?.[20]],
      );
    }
    for (const user of [title1, title2] as string[]) {
      await h.owner.query(`UPDATE articles SET title = title || ' changed' WHERE id = $1`, [
        ratedByB.get(user)?.[20],
      ]);
    }
    for (const user of [unsub1, unsub2] as string[]) {
      await h.owner.query(`DELETE FROM subscriptions WHERE user_id = $1`, [user]);
    }
    const changed = [lose1, lose2, lose3, title1, title2, unsub1, unsub2] as string[];
    const run = await nightly(later());
    out['p2DispatchMs'] = run.ms;
    out['p2Intents'] = run.counts.size;
    expectIntentsFor(run.counts, changed);
    out['p2DeliverMs'] = await deliver(h.handlersWith({ now: later }));
    const again = await nightly(later());
    out['p2RepeatMs'] = again.ms;
    expect.soft(again.counts.size, 'a second sweep after delivery').toBe(0);
  });

  it('P3 threshold change: every model holder, none of the readers below the gate', async () => {
    const holders = await usersWithModels();
    await h.setSetting('ranker.thresholds', { estimate: { minRatings: 40 } });
    const run = await nightly(later());
    out['p3DispatchMs'] = run.ms;
    out['p3Intents'] = run.counts.size;
    expectIntentsFor(run.counts, holders);
    expect.soft(holders.length, 'model holders before the change').toBe(101);
    out['p3DeliverMs'] = await deliver(h.handlersWith({ now: later }));
    for (const user of readersB) {
      const model = await modelsOf(user);
      const n = ratingCountB.get(user) ?? 0;
      const lost = user === readersB[10] || user === readersB[11] || user === readersB[12] ? 1 : 0;
      if (n - lost < 40) expect.soft(model, `reader ${user} below 40 has no model`).toBeNull();
      else expect.soft(model?.version, `reader ${user} has a new version`).toBeGreaterThan(1);
    }
    await h.deleteSetting('ranker.thresholds');
    const back = await nightly(later());
    out['p3RestoreDispatchMs'] = back.ms;
    out['p3RestoreIntents'] = back.counts.size;
    expectIntentsFor(back.counts, [ownerId, ...readersB]);
  });

  it('keeps every nightly dispatch under the budget', () => {
    expect(Math.max(...dispatchMs)).toBeLessThan(BUDGET_MS);
  });
});
