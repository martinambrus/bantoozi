import { loadLearnSamples } from '@bantoozi/db';
import { DEFAULT_RANKER_CONFIG, FEATURE_SPEC_V1_SHA, modelContextSha } from '@bantoozi/ranker';
import { HOUSE_CRON_SCHEDULES } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY } from './support/classify.js';
import { LearnWorld, RATED, type ModelRow } from './support/learn-world.js';

/**
 * M7-T4 (PLAN §13, spec 06 §8.1, §8.3, §8.4, spec 11 §6): the `user.learn` handler, version
 * retention and `house.nightly-learn`, through the real handlers (the registered handler map of the
 * worker) against a migrated and seeded database. Feedback is driven through the real API
 * functions, so every rating carries its event-time snapshot; the trainer is the real
 * `trainUserModel`. Effects are read from the database only: `user_models`, `users.rank_revision`
 * and the outbox. One `it` per PLAN bullet.
 */

let h: ClassifyHarness;
let w: LearnWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await LearnWorld.create(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

/** Run the registered `user.learn` handler for the user. */
const learn = (userId: string) => h.dispatch('user.learn', { userId });

/** A reader with RATED explicit ratings (24 likes, 24 dislikes) whose first learn run activated v1. */
async function trained(options: Parameters<LearnWorld['user']>[0] = {}): Promise<string> {
  const userId = await w.user(options);
  await w.rateRange(userId, 0, RATED);
  await learn(userId);
  return userId;
}

/** Make the stored ratings carry no signal: 24 re-rates that decorrelate the labels from `M`. */
async function decorrelate(userId: string): Promise<void> {
  for (let i = 0; i < RATED; i += 1) {
    if (i % 4 === 0) await w.rate(userId, i, -1); // answer 0.9 group: half of 24 flip to dislike
    if (i % 8 === 1 || i % 8 === 3) await w.rate(userId, i, 1); // 0.1 and 0.6 groups: half flip
  }
}

/** A noise-preserving input change: swap the classes of two articles inside the 0.9 group. */
async function swap(userId: string, k: number): Promise<void> {
  await w.rate(userId, 2 + 4 * k, -1);
  await w.rate(userId, 4 * k, 1);
}

/** The model context the current state implies, for the own card inputs `ownIds` (spec 06 §8.1). */
async function contextFor(
  userId: string,
  ownIds: readonly string[],
  model: ModelRow,
): Promise<string> {
  // The rating fingerprint is the model's own (it only changes with settings this file never edits).
  const stored = model.metrics['ratingSha'];
  const { samples } = await loadLearnSamples(h.db, { userId, now: new Date() });
  const ratingSha =
    typeof stored === 'string'
      ? stored
      : samples.find((s) => s.features !== null)?.features?.ratingSha;
  if (ratingSha === undefined) throw new Error('fixture: no rating sha to recompute the context');
  const prefs = await h.owner.query<{ preferences: Record<string, unknown> }>(
    'SELECT preferences FROM users WHERE id = $1',
    [userId],
  );
  const consent = prefs.rows[0]!.preferences;
  const held = await h.owner.query<{
    card_id: string;
    strength: string;
    scope_feed_id: string | null;
    sha: string;
  }>(
    `SELECT uc.card_id::text AS card_id, uc.strength, uc.scope_feed_id::text AS scope_feed_id,
            (SELECT ca.card_input_sha256 FROM card_answers ca WHERE ca.card_id = uc.card_id LIMIT 1) AS sha
       FROM user_cards uc WHERE uc.user_id = $1 AND uc.card_id::text = ANY($2::text[])`,
    [userId, [...ownIds]],
  );
  return modelContextSha({
    ratingSha,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    strengthWeights: DEFAULT_RANKER_CONFIG.strengthWeights,
    modelConfig: DEFAULT_RANKER_CONFIG.model,
    consent: {
      implicitFeedback: consent['implicitFeedback'] === true,
      implicitNegative: consent['implicitNegative'] === true,
    },
    ownInputs: held.rows.map((r) => ({
      cardId: r.card_id,
      strength: r.strength,
      scopeFeedId: r.scope_feed_id,
      cardInputSha256: r.sha,
    })),
  });
}

const ownOf = (model: ModelRow): string[] => w.ownCardIds(model);

describe('user.learn and house.nightly-learn (M7-T4)', () => {
  it('ten newly effective explicit ratings after a stored cutoff record one user.learn intent, nine record none', async () => {
    const nine = await w.user();
    const ten = await w.user();
    // Ratings from before the stored cutoff never count.
    await w.rateRange(nine, 20, 28);
    await w.rateRange(ten, 20, 28);
    const cutoff = await w.maxEventId();
    await w.seedCutoff(nine, cutoff);
    await w.seedCutoff(ten, cutoff);
    const mark = await h.mark();

    await w.rateRange(nine, 0, 9);
    await w.rateRange(ten, 0, 9);
    expect(await w.userIntents('user.learn', nine, mark)).toHaveLength(0);
    expect(await w.userIntents('user.learn', ten, mark)).toHaveLength(0);

    await w.rate(ten, 9);
    expect(await w.userIntents('user.learn', nine, mark)).toHaveLength(0);
    expect(await w.userIntents('user.learn', ten, mark)).toHaveLength(1);

    // The recorded intent is consumed by the handler: an attempt is stored past the seeded cutoff.
    expect(await h.run('user.learn', (p) => p['userId'] === ten)).toBeGreaterThanOrEqual(1);
    const rows = await w.models(ten);
    const newest = await w.newestEvent(ten);
    expect(rows.some((m) => m.metrics['feedbackCutoffEventId'] === newest)).toBe(true);
  });

  it('learn on separable feedback stores version 1 active with metrics.feedbackCutoffEventId (the newest considered event), contextSha and status, increments users.rank_revision and records user.rank (full) and user.suggest', async () => {
    const userId = await w.user();
    await w.rateRange(userId, 0, RATED);
    const before = await w.rankRevision(userId);
    const mark = await h.mark();

    await learn(userId);

    const rows = await w.models(userId);
    expect(rows).toHaveLength(1);
    const model = rows[0]!;
    expect(model.version).toBe(1);
    expect(model.active).toBe(true);
    expect(model.nPos).toBe(24);
    expect(model.nNeg).toBe(24);
    expect(model.metrics['feedbackCutoffEventId']).toBe(await w.newestEvent(userId));
    expect(typeof model.metrics['contextSha']).toBe('string');
    expect(String(model.metrics['contextSha']).length).toBeGreaterThan(0);
    expect(typeof model.metrics['status']).toBe('string');
    expect(await w.rankRevision(userId)).toBeGreaterThan(before);

    const ranks = await w.userIntents('user.rank', userId, mark);
    expect(ranks.some((p) => p['full'] === true)).toBe(true);
    expect(await w.userIntents('user.suggest', userId, mark)).toHaveLength(1);
  });

  it('a failed candidate (too few ratings) is stored inactive with its rejection reason and cutoff, records no rank or suggest intent, and leaves a previous active model active', async () => {
    // Too few ratings: the attempt is stored, nothing is activated.
    const few = await w.user();
    await w.rateRange(few, 0, 6);
    const fewBefore = await w.rankRevision(few);
    const fewMark = await h.mark();
    await learn(few);
    const fewRows = await w.models(few);
    expect(fewRows).toHaveLength(1);
    expect(fewRows[0]!.active).toBe(false);
    expect(fewRows[0]!.metrics['feedbackCutoffEventId']).toBe(await w.newestEvent(few));
    expect(typeof fewRows[0]!.metrics['status']).toBe('string');
    const reasonKeys = Object.keys(fewRows[0]!.metrics).filter((k) => /reason/i.test(k));
    expect(reasonKeys.length).toBeGreaterThan(0);
    expect(
      reasonKeys.some((k) => {
        const v = fewRows[0]!.metrics[k];
        return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.length > 0;
      }),
    ).toBe(true);
    expect(await w.rankRevision(few)).toBe(fewBefore);
    expect(await w.userIntents('user.rank', few, fewMark)).toHaveLength(0);
    expect(await w.userIntents('user.suggest', few, fewMark)).toHaveLength(0);

    // A candidate that fails validation leaves the compatible active model in place.
    const userId = await trained();
    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);
    await decorrelate(userId);
    const before = await w.rankRevision(userId);
    const mark = await h.mark();
    await learn(userId);
    const rows = await w.models(userId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.active).toBe(false);
    expect(rows[1]!.metrics['feedbackCutoffEventId']).toBe(await w.newestEvent(userId));
    expect(Object.keys(rows[1]!.metrics).some((k) => /reason/i.test(k))).toBe(true);
    expect(rows[0]!.active).toBe(true);
    expect(await w.rankRevision(userId)).toBe(before);
    expect(await w.userIntents('user.rank', userId, mark)).toHaveLength(0);
    expect(await w.userIntents('user.suggest', userId, mark)).toHaveLength(0);
  });

  it('running learn again with unchanged inputs stores no new row', async () => {
    const userId = await trained();
    const rows = await w.models(userId);
    expect(rows).toHaveLength(1);
    const mark = await h.mark();
    await learn(userId);
    await learn(userId);
    expect(await w.models(userId)).toEqual(rows);
    expect(await w.userIntents('user.rank', userId, mark)).toHaveLength(0);

    // The same holds for a stored failed attempt: no change, no retrain.
    const few = await w.user();
    await w.rateRange(few, 0, 6);
    await learn(few);
    await learn(few);
    expect(await w.models(few)).toHaveLength(1);
  });

  it('retention: after 6 attempts the active row plus the 3 newest inactive rows remain; the active row is kept even when it is the oldest', async () => {
    const userId = await trained();
    let newest = (await w.models(userId)).at(-1)!.version;
    await decorrelate(userId);
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      if (attempt > 2) await swap(userId, attempt - 3);
      await learn(userId);
      const rows = await w.models(userId);
      const latest = rows.reduce((max, m) => Math.max(max, m.version), 0);
      expect(latest).toBeGreaterThan(newest);
      newest = latest;
      // Never more than one active, and the first model stays the active one.
      expect(rows.filter((m) => m.active).map((m) => m.version)).toEqual([1]);
    }
    const rows = await w.models(userId);
    expect(rows.map((m) => m.version)).toEqual([1, newest - 2, newest - 1, newest]);
    expect(rows[0]!.active).toBe(true);
    expect(rows.slice(1).every((m) => !m.active)).toBe(true);
  });

  it('never more than one active row at any time (two learn runs in parallel for one user end with exactly one active)', async () => {
    const userId = await w.user();
    await w.rateRange(userId, 0, RATED);
    const settled = await Promise.allSettled([learn(userId), learn(userId)]);
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    expect(await w.active(userId)).toHaveLength(1);

    // With a model in place and new feedback, parallel retrains still end with one active row.
    await w.rateRange(userId, RATED, RATED + 12);
    const again = await Promise.allSettled([learn(userId), learn(userId), learn(userId)]);
    expect(again.some((s) => s.status === 'fulfilled')).toBe(true);
    const rows = await w.models(userId);
    expect(rows.filter((m) => m.active)).toHaveLength(1);
    expect(new Set(rows.map((m) => m.version)).size).toBe(rows.length);
  });

  it('label-only changes (label/unlabel events) store no new row and the model stays active; labels never become training targets', async () => {
    const userId = await trained();
    const rows = await w.models(userId);
    const labelId = await w.labelCard(userId);
    const mark = await h.mark();

    await w.label(userId, 50, labelId); // an unrated article
    await w.label(userId, 3, labelId); // a rated one
    await w.unlabel(userId, 3, labelId);
    await learn(userId);

    expect(await w.models(userId)).toEqual(rows);
    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);
    expect(await w.userIntents('user.rank', userId, mark)).toHaveLength(0);
    const { samples } = await loadLearnSamples(h.db, { userId, now: new Date() });
    expect(samples.some((s) => s.articleId === w.articles[50])).toBe(false);
    expect(samples).toHaveLength(RATED);
    expect(rows[0]!.nLabels).toBe(RATED);
  });

  it('activation never changes any subscriptions.inference_mode / inference_activated_at', async () => {
    const userId = await w.user();
    const trainingFeed = await h.feed('Training feed');
    const offFeed = await h.feed('Off feed');
    await h.subscribe(userId, trainingFeed, 'training');
    await h.subscribe(userId, offFeed, 'off');
    await w.rateRange(userId, 0, RATED);
    const read = async () =>
      (
        await h.owner.query(
          `SELECT feed_id::text AS feed_id, inference_mode, inference_activated_at, inference_version
             FROM subscriptions WHERE user_id = $1 ORDER BY feed_id`,
          [userId],
        )
      ).rows;
    const before = await read();
    expect(before).toHaveLength(3);

    await learn(userId);

    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);
    expect(await read()).toEqual(before);
  });

  it('a new card without an own input: the stored model contextSha still equals the recomputed context, the model stays active, and a learn run stores no new row', async () => {
    const userId = await trained();
    const [model] = await w.models(userId);
    const own = ownOf(model!);
    expect(own).toContain(w.cardM); // fixture: M earned an own input
    expect(await contextFor(userId, own, model!)).toBe(model!.metrics['contextSha']);

    const extra = await h.card({ interest: 'Quokka grooming and wallaby couture' });
    await h.hold(userId, extra, { strength: 'like' });
    await h.owner.query(
      `UPDATE user_cards SET strength = 'love' WHERE user_id = $1 AND card_id = $2`,
      [userId, extra],
    );
    await h.owner.query(`DELETE FROM user_cards WHERE user_id = $1 AND card_id = $2`, [
      userId,
      extra,
    ]);
    await h.hold(userId, extra, { strength: 'must' });
    const mark = await h.mark();

    expect(await contextFor(userId, own, model!)).toBe(model!.metrics['contextSha']);
    await learn(userId);
    expect(await w.models(userId)).toEqual([model]);
    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);
    expect(await w.userIntents('user.rank', userId, mark)).toHaveLength(0);
  });

  it('a strength change of an own-input card: the next learn run deactivates the incompatible model and then, from the stored ratings and with no new feedback, trains and activates a new version whose context matches', async () => {
    const userId = await trained();
    const [first] = await w.models(userId);
    expect(ownOf(first!)).toContain(w.cardM); // fixture: M earned an own input
    const events = await w.newestEvent(userId);

    await h.owner.query(
      `UPDATE user_cards SET strength = 'love' WHERE user_id = $1 AND card_id = $2`,
      [userId, w.cardM],
    );
    const mark = await h.mark();
    await learn(userId);

    const rows = await w.models(userId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const active = rows.filter((m) => m.active);
    expect(active).toHaveLength(1);
    const next = active[0]!;
    expect(next.version).toBeGreaterThan(1);
    expect(rows.find((m) => m.version === 1)!.active).toBe(false);
    expect(next.metrics['contextSha']).not.toBe(first!.metrics['contextSha']);
    expect(next.metrics['contextSha']).toBe(await contextFor(userId, ownOf(next), next));
    expect(next.metrics['feedbackCutoffEventId']).toBe(events); // no new feedback was needed
    expect((await w.userIntents('user.rank', userId, mark)).some((p) => p['full'] === true)).toBe(
      true,
    );
  });

  it('undo of a rating used by the active model (its evidence revoked) deactivates or replaces that model on the next learn run', async () => {
    const userId = await w.user();
    let undoKey: string | null = null;
    for (let i = 0; i < RATED; i += 1) {
      const { key } = await w.rate(userId, i);
      if (i === 4) undoKey = key;
    }
    expect(undoKey).not.toBeNull();
    await learn(userId);
    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);

    await w.undo(userId, undoKey!);
    await learn(userId);

    const rows = await w.models(userId);
    const active = rows.filter((m) => m.active);
    // No model trained on the revoked rating stays active.
    expect(active.every((m) => m.version > 1)).toBe(true);
    expect(rows.find((m) => m.version === 1)!.active).toBe(false);
    for (const model of active) expect(model.nLabels).toBeLessThanOrEqual(RATED - 1);
    const { samples } = await loadLearnSamples(h.db, { userId, now: new Date() });
    expect(samples.some((s) => s.articleId === w.articles[4])).toBe(false);
  });

  it('house.nightly-learn records user.learn only for users whose eligible inputs changed (an implicit-only change, a sample expiring past 180 days), none for an unchanged user, and user.suggest for users active in the last 7 days', async () => {
    const unchanged = await trained({ lastActiveDaysAgo: 0 });
    const implicit = await trained({ implicit: true, lastActiveDaysAgo: 0 });
    const expiring = await trained({ lastActiveDaysAgo: 0 });
    const idle = await trained({ lastActiveDaysAgo: 0 });

    await w.bookmark(implicit, 50); // an implicit-only change (spec 06 §8.2)
    await w.ageRating(expiring, 0, 200); // a sample ages out of the 180-day window
    await w.ageRating(idle, 1, 30); // still inside the window: no change
    await h.owner.query(`UPDATE users SET last_active_at = $2 WHERE id = $1`, [
      idle,
      new Date(Date.now() - 30 * DAY),
    ]);

    const mark = await h.mark();
    await h.dispatch('house.nightly-learn', {});

    expect(await w.userIntents('user.learn', implicit, mark)).not.toHaveLength(0);
    expect(await w.userIntents('user.learn', expiring, mark)).not.toHaveLength(0);
    expect(await w.userIntents('user.learn', unchanged, mark)).toHaveLength(0);
    expect(await w.userIntents('user.learn', idle, mark)).toHaveLength(0);

    for (const userId of [unchanged, implicit, expiring]) {
      expect(await w.userIntents('user.suggest', userId, mark)).not.toHaveLength(0);
    }
    expect(await w.userIntents('user.suggest', idle, mark)).toHaveLength(0);
  });

  it('house.nightly-learn has a cron schedule in HOUSE_CRON_SCHEDULES', () => {
    const schedule = HOUSE_CRON_SCHEDULES['house.nightly-learn'];
    expect(schedule).toBeDefined();
    expect(schedule?.cron).toBe('0 1 * * *');
    expect(schedule?.everyMs).toBe(24 * 60 * 60_000);
  });
});
