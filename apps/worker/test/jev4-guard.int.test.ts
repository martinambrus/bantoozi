import { inlineTrainer, type Trainer } from '../src/learn/trainer.js';
import { dispatch } from '../src/handlers/index.js';
import type { TrainArgs, TrainResult } from '@bantoozi/ranker';
import { parseJobPayload } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { block, driftRows, snapshotOf, type DriftRow } from './support/guard-drift.js';
import {
  V113,
  V114,
  begin,
  ensureRegistered,
  exactShaOf,
  familyShaOracle,
  flip,
  learnInputs,
  rankStatus,
} from './support/jev4-world.js';
import { LearnWorld, likeOf } from './support/learn-world.js';

/**
 * JEV-4 T3 (contract: upgrade guard and strict training): the `user.learn` handler and its state
 * flow. The guard's statistics are tested in the ranker; here a trainer stub returns a crafted
 * `TrainResult` (or a spy records the `TrainArgs` and delegates to the real trainer) and the
 * effects are read from `user_models`, the outbox and `loadLearnInputs`. Real ratings through the
 * API functions give each user old-sha and current-sha rows; the end-to-end block injects
 * crafted snapshots instead.
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

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

const OLD_ROWS = 40;
const REGRESSION = 'upgrade_regression';

const learn = (userId: string) => h.dispatch('user.learn', { userId });
const nightly = () => h.dispatch('house.nightly-learn', {});

async function learnWith(trainer: Trainer, userId: string): Promise<void> {
  await dispatch(
    h.handlersWith({ trainer }),
    'user.learn',
    parseJobPayload('user.learn', { userId }),
    { queue: 'user.learn', jobId: 'direct' },
  );
}

/** A trainer that records its arguments and trains for real. */
function spy(): { trainer: Trainer; calls: TrainArgs[] } {
  const calls: TrainArgs[] = [];
  return {
    calls,
    trainer: (args, mode) => {
      calls.push(args);
      return inlineTrainer(args, mode);
    },
  };
}

/** The real result of the arguments with `reasons` and an ineligible activation. */
function crafted(real: TrainResult, args: TrainArgs, reasons: string[]): TrainResult {
  const guard = reasons.includes(REGRESSION);
  return {
    ...real,
    activation: { eligible: false, reasons },
    metrics: {
      ...real.metrics,
      upgrade: guard
        ? {
            ratingSha: args.ratingSha,
            n: 30,
            nPos: 15,
            nNeg: 15,
            cvAuc: 0.2,
            baselineAuc: 0.8,
            deltaCi: [-0.9, -0.3],
            regressed: true,
          }
        : null,
    },
  } as unknown as TrainResult;
}

/** A trainer that trains for real, runs `during` (a change of the inputs), and answers `reasons`. */
function stub(reasons: string[], during?: () => Promise<void>): Trainer {
  return async (args, mode) => {
    const real = await inlineTrainer(args, mode);
    await during?.();
    return crafted(real, args, reasons);
  };
}

interface Upgraded {
  userId: string;
  /** Exact shas of the three pins (the third is filled by {@link flipTo115}). */
  old: string;
  current: string;
}

const flipped = (i: number): 1 | -1 => (likeOf(i) === 1 ? -1 : 1);

/**
 * A user with an active model trained under 1.13.0 on articles `0..39`, then the pin moved to
 * 1.14.0 (both shas registered) and current-sha ratings: articles `0..19` re-rated (so the user
 * has 20 old rows `20..39` and, after `40..58`, 39 current rows); article 59 stays unrated.
 */
async function upgraded(options: { incumbent?: boolean } = {}): Promise<Upgraded> {
  const incumbent = options.incumbent ?? true;
  await begin(h, V113);
  await ensureRegistered(h);
  const old = await exactShaOf(h);
  const userId = await w.user({ lastActiveDaysAgo: 0 });
  await w.rateRange(userId, incumbent ? 0 : 20, OLD_ROWS);
  if (incumbent) {
    await learn(userId);
    expect((await w.active(userId)).map((m) => m.version)).toEqual([1]);
  }
  await flip(h, V114, { answers: true });
  await ensureRegistered(h);
  const current = await exactShaOf(h);
  expect(current).not.toBe(old);
  if (incumbent) {
    for (let i = 0; i < 20; i += 1) {
      await w.rate(userId, i, flipped(i));
      await w.rate(userId, i);
    }
  }
  await w.rateRange(userId, 40, 59);
  // The ratings left a pending user.learn intent, which would absorb the handler's own (same dedupe key).
  await h.clearOutbox();
  return { userId, old, current };
}

/** The guard run: a crafted `upgrade_regression` result for the user's current inputs. */
async function regress(userId: string): Promise<void> {
  await learnWith(stub([REGRESSION]), userId);
}

const rankReasons = async (userId: string, since: string): Promise<string[]> =>
  (await w.userIntents('user.rank', userId, since)).map((p) => String(p['reason']));
const modelOff = (reasons: string[]) => reasons.filter((r) => r.startsWith('model-off'));

describe('the guard result in the handler', () => {
  it('stores the attempt as rejected with the strict marker, deactivates the incumbent as upgrade_regression, skips the staleness check, fires model-off and one more user.learn', async () => {
    const { userId, current } = await upgraded();
    // The incumbent's evidence is lost, so the staleness check, if it ran, would give another reason.
    await w.rate(userId, 0, flipped(0));
    await h.clearOutbox();
    const mark = await h.mark();

    await regress(userId);

    const rows = await w.models(userId);
    expect(rows.map((m) => m.version)).toEqual([1, 2]);
    const [incumbent, attempt] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(incumbent.active).toBe(false);
    expect(incumbent.metrics['deactivatedReason']).toBe(REGRESSION);
    expect(typeof incumbent.metrics['deactivatedAt']).toBe('string');
    expect(incumbent.metrics).not.toHaveProperty('strictRatingSha');
    expect(attempt.active).toBe(false);
    expect(attempt.metrics['status']).toBe('rejected');
    expect(String(attempt.metrics['reason']).split(',')).toContain(REGRESSION);
    expect(attempt.metrics['strictRatingSha']).toBe(current);
    expect(attempt.metrics['upgrade']).toMatchObject({ regressed: true });
    expect(rows.filter((m) => m.active)).toEqual([]);
    expect(await rankStatus(h, userId)).toBe('none');

    const reasons = await rankReasons(userId, mark);
    expect(modelOff(reasons)).toEqual(['model-off-v2']);
    expect(await w.userIntents('user.learn', userId, mark)).toHaveLength(1);
    expect(await w.userIntents('user.suggest', userId, mark)).toHaveLength(0);
  }, 240_000);

  it('a user without an active model gets the rejected attempt and the marker, no deactivation, no model-off, and the strict run follows', async () => {
    const { userId, current } = await upgraded({ incumbent: false });
    const mark = await h.mark();

    await regress(userId);

    const rows = await w.models(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.metrics['status']).toBe('rejected');
    expect(String(rows[0]!.metrics['reason']).split(',')).toContain(REGRESSION);
    expect(rows[0]!.metrics['strictRatingSha']).toBe(current);
    expect(rows[0]!.metrics).not.toHaveProperty('deactivatedReason');
    expect(modelOff(await rankReasons(userId, mark))).toEqual([]);
    expect(await w.userIntents('user.learn', userId, mark)).toHaveLength(1);
  }, 240_000);
});

describe('strict training after the guard', () => {
  it('trains on the rows of the current exact sha only, marks every strict attempt, and keeps its model on a later rating', async () => {
    const { userId, old, current } = await upgraded();
    await regress(userId);
    const inputs = await learnInputs(h, userId);
    expect(inputs.strict).toBe(true);
    expect(inputs.families).toEqual({});
    expect(inputs.eligible).toHaveLength(39);

    const first = spy();
    await learnWith(first.trainer, userId);
    expect(first.calls).toHaveLength(1);
    const args = first.calls[0] as TrainArgs & { familySha: string; families: unknown };
    expect(args.ratingSha).toBe(current);
    expect(args.familySha).toBe(await familyShaOracle(h));
    expect(args.families).toEqual({});

    const rows = await w.models(userId);
    const strict = rows[rows.length - 1]!;
    expect(strict.version).toBe(3);
    expect(strict.metrics['nExplicit']).toBe(39);
    expect((strict.metrics['skipped'] as Record<string, number>)['rating_sha_mismatch']).toBe(20);
    expect(strict.metrics['strictRatingSha']).toBe(current);
    expect(strict.metrics['ratingSha']).toBe(current);
    expect(strict.metrics['upgrade']).toBeNull();
    expect(strict.metrics['status']).toBe('activated');
    expect(strict.active).toBe(true);
    expect(old).not.toBe(current);

    await w.rate(userId, 59);
    const second = spy();
    await learnWith(second.trainer, userId);
    expect(second.calls).toHaveLength(1);
    expect((second.calls[0] as unknown as { families: unknown }).families).toEqual({});
    expect(second.calls[0]!.ratingSha).toBe(current);

    const after = await w.models(userId);
    const newest = after[after.length - 1]!;
    expect(newest.version).toBe(4);
    expect(newest.metrics['strictRatingSha']).toBe(current);
    expect(newest.metrics['nExplicit']).toBe(40);
    expect(newest.metrics['status']).toBe('activated');
    expect(after.filter((m) => m.active).map((m) => m.version)).toEqual([4]);
    const third = after.find((m) => m.version === 3)!;
    expect(third.metrics).not.toHaveProperty('deactivatedReason');
    expect(
      after.filter((m) => m.metrics['deactivatedReason'] === REGRESSION).map((m) => m.version),
    ).toEqual([1]);
    expect(await learnInputs(h, userId)).toMatchObject({ strict: true, families: {} });
  }, 300_000);

  it('ends when the exact sha changes: the next run sees the registered old shas again and writes no marker', async () => {
    const { userId, old, current } = await upgraded();
    await regress(userId);
    await learnWith(spy().trainer, userId);
    expect((await learnInputs(h, userId)).strict).toBe(true);

    await flip(h, 'jev-1.15.0', { answers: true });
    await ensureRegistered(h);
    const third = await exactShaOf(h);
    expect(new Set([old, current, third]).size).toBe(3);
    const inputs = await learnInputs(h, userId);
    expect(inputs.strict).toBe(false);
    expect(inputs.eligible).toHaveLength(59);

    const run = spy();
    await learnWith(run.trainer, userId);
    expect(run.calls).toHaveLength(1);
    const families = (run.calls[0] as unknown as { families: Record<string, string> }).families;
    expect(Object.keys(families).sort()).toEqual([old, current, third].sort());
    expect(run.calls[0]!.ratingSha).toBe(third);

    const rows = await w.models(userId);
    const newest = rows[rows.length - 1]!;
    expect(newest.version).toBe(4);
    expect(newest.metrics['ratingSha']).toBe(third);
    expect(newest.metrics['nExplicit']).toBe(59);
    expect(newest.metrics).not.toHaveProperty('strictRatingSha');
  }, 300_000);
});

describe('a superseded guard run', () => {
  it('has no guard effect: the incumbent stays active, no marker, only the replacement run is enqueued', async () => {
    const { userId } = await upgraded();
    const mark = await h.mark();

    await learnWith(
      stub([REGRESSION], async () => {
        await w.rate(userId, 59);
      }),
      userId,
    );

    const rows = await w.models(userId);
    expect(rows.map((m) => m.version)).toEqual([1, 2]);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.metrics).not.toHaveProperty('deactivatedReason');
    expect(rows[1]!.active).toBe(false);
    expect(rows[1]!.metrics['status']).toBe('superseded');
    expect(rows[1]!.metrics['reason']).toBe('inputs_changed');
    expect(rows[1]!.metrics).not.toHaveProperty('strictRatingSha');
    expect(modelOff(await rankReasons(userId, mark))).toEqual([]);
    expect(await w.userIntents('user.learn', userId, mark)).toHaveLength(1);
    expect((await learnInputs(h, userId)).strict).toBe(false);
  }, 240_000);
});

describe('controls: no marker without the guard', () => {
  it('a rejection for another reason leaves the incumbent active and writes no marker or learn intent', async () => {
    const { userId } = await upgraded();
    const mark = await h.mark();

    await learnWith(stub(['low_auc']), userId);

    const rows = await w.models(userId);
    expect(rows.map((m) => m.version)).toEqual([1, 2]);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.metrics).not.toHaveProperty('deactivatedReason');
    expect(rows[1]!.metrics['status']).toBe('rejected');
    expect(rows[1]!.metrics['reason']).toBe('low_auc');
    expect(rows[1]!.metrics).not.toHaveProperty('strictRatingSha');
    expect(modelOff(await rankReasons(userId, mark))).toEqual([]);
    expect(await w.userIntents('user.learn', userId, mark)).toHaveLength(0);
    expect((await learnInputs(h, userId)).strict).toBe(false);
  }, 240_000);

  it('an activating run of a user that is not strict writes no marker and trains on the registered old rows too', async () => {
    const { userId } = await upgraded();
    const run = spy();

    await learnWith(run.trainer, userId);

    expect(run.calls).toHaveLength(1);
    const families = (run.calls[0] as unknown as { families: Record<string, string> }).families;
    expect(Object.keys(families)).toHaveLength(2);
    const rows = await w.models(userId);
    const newest = rows[rows.length - 1]!;
    expect(newest.metrics['status']).toBe('activated');
    expect(newest.metrics).not.toHaveProperty('strictRatingSha');
    expect(newest.metrics['nExplicit']).toBe(59);
  }, 240_000);
});

describe('house.nightly-learn', () => {
  it('computes the strict-aware input hash: nothing for a strict user whose inputs are unchanged, one user.learn after a new rating', async () => {
    const { userId } = await upgraded();
    await regress(userId);
    await learnWith(spy().trainer, userId);
    expect((await learnInputs(h, userId)).strict).toBe(true);
    await h.clearOutbox();

    const unchanged = await h.mark();
    await nightly();
    expect(await w.userIntents('user.learn', userId, unchanged)).toHaveLength(0);

    await w.rate(userId, 59);
    await h.clearOutbox();
    const changed = await h.mark();
    await nightly();
    expect(await w.userIntents('user.learn', userId, changed)).toHaveLength(1);
  }, 300_000);
});

// ── End to end with the real trainer ───────────────────────────────────────────────────────────

const OLD_N = 300;
const NEW_N = 36;

interface Injected {
  articleIds: string[];
}

/** Articles for the injected ratings, shared by the readers of the block. */
async function articles(count: number, label: string): Promise<Injected> {
  const articleIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    articleIds.push(await h.article({ feedIds: [w.feedId], title: `${label} ${i}` }));
  }
  return { articleIds };
}

/** Explicit ratings with crafted event-time snapshots, as `packages/db/test/learn/fixtures.ts` inserts them. */
async function inject(
  userId: string,
  pool: Injected,
  rows: DriftRow[],
  clock: { at: number },
): Promise<void> {
  for (const [i, row] of rows.entries()) {
    clock.at += 60_000;
    const at = new Date(clock.at);
    const articleId = pool.articleIds[i]!;
    const rating = row.y === 1 ? 1 : -1;
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
      [userId, articleId, rating, at],
    );
    await h.owner.query(
      `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
       VALUES ($1, $2, 'rate', $3::jsonb, $4)`,
      [
        userId,
        articleId,
        JSON.stringify({
          v: 1,
          rating,
          reason: null,
          hide: false,
          contentRevision: '1',
          signalOrigin: 'explicit',
          learningConsent: { implicitFeedback: false, implicitNegative: false },
          features: snapshotOf(row, at, [{ id: w.cardM, strength: 'like', from: 'pA' }], w.feedId),
        }),
        at,
      ],
    );
  }
}

describe('end to end with the real trainer', () => {
  it('a facet relation that inverts on the newest ratings is rejected as upgrade_regression, the model is retired, and the strict run trains on the current rows only; the same relation passes', async () => {
    await begin(h, V113);
    await ensureRegistered(h);
    const old = await exactShaOf(h);
    const drifting = await w.user({ lastActiveDaysAgo: 0 });
    const healthy = await w.user({ lastActiveDaysAgo: 0 });
    const oldPool = await articles(OLD_N, 'Old');
    const newPool = await articles(NEW_N, 'New');
    const clock = { at: Date.now() - 20 * 86_400_000 };

    const oldRows = driftRows('guard-e2e-old', [block(old, OLD_N, 1, 0)]);
    for (const userId of [drifting, healthy]) {
      await inject(userId, oldPool, oldRows, { at: clock.at });
      await learn(userId);
      const active = await w.active(userId);
      expect(active.map((m) => m.version)).toEqual([1]);
      expect(active[0]!.metrics['nExplicit']).toBe(OLD_N);
    }

    await flip(h, V114);
    await ensureRegistered(h);
    const current = await exactShaOf(h);
    clock.at += OLD_N * 60_000;
    await inject(drifting, newPool, driftRows('guard-e2e-new', [block(current, NEW_N, -1, 0.4)]), {
      at: clock.at,
    });
    await inject(healthy, newPool, driftRows('guard-e2e-same', [block(current, NEW_N, 1, 0.3)]), {
      at: clock.at,
    });

    const mark = await h.mark();
    await learn(drifting);
    const rows = await w.models(drifting);
    expect(rows.map((m) => m.version)).toEqual([1, 2]);
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.metrics['deactivatedReason']).toBe(REGRESSION);
    expect(rows[1]!.metrics['status']).toBe('rejected');
    expect(String(rows[1]!.metrics['reason']).split(',')).toContain(REGRESSION);
    expect(rows[1]!.metrics['strictRatingSha']).toBe(current);
    expect(rows[1]!.metrics['nExplicit']).toBe(OLD_N + NEW_N);
    expect(rows[1]!.metrics['upgrade']).toMatchObject({
      ratingSha: current,
      n: NEW_N,
      regressed: true,
    });
    expect(await rankStatus(h, drifting)).toBe('none');
    expect(modelOff(await rankReasons(drifting, mark))).toHaveLength(1);
    expect(await w.userIntents('user.learn', drifting, mark)).toHaveLength(1);

    const strict = await learnInputs(h, drifting);
    expect(strict.strict).toBe(true);
    expect(strict.eligible).toHaveLength(NEW_N);
    await learn(drifting);
    const after = await w.models(drifting);
    const run = after[after.length - 1]!;
    expect(run.version).toBe(3);
    expect(run.metrics['strictRatingSha']).toBe(current);
    expect(run.metrics['nExplicit']).toBe(NEW_N);
    expect((run.metrics['skipped'] as Record<string, number>)['rating_sha_mismatch']).toBe(OLD_N);
    expect(run.metrics['upgrade']).toBeNull();

    await learn(healthy);
    const control = await w.models(healthy);
    const attempt = control[control.length - 1]!;
    expect(attempt.version).toBe(2);
    expect(String(attempt.metrics['reason'] ?? '')).not.toContain(REGRESSION);
    expect(attempt.metrics).not.toHaveProperty('strictRatingSha');
    expect(attempt.metrics['upgrade']).toMatchObject({ ratingSha: current, regressed: false });
    expect(control.some((m) => m.metrics['deactivatedReason'] === REGRESSION)).toBe(false);
    expect((await learnInputs(h, healthy)).strict).toBe(false);
  }, 600_000);
});
