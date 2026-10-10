import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupDbTest, type DbTestContext } from '../support/test-db.js';
import {
  FEATURE_SPEC_SHA,
  Scenario,
  analysisRequest,
  snapshot,
  type LearnSample,
} from './fixtures.js';
import { frozenRequest } from './frozen.js';

/**
 * M7-T2 (spec 06 §8.2, PLAN §13): `loadLearnSamples` turns `user_article` + `feedback_events` into
 * one current training sample per (user, article). Feedback is produced through the real M4 action
 * functions wherever they can produce the shape, and by direct inserts of the exact value shapes
 * M4 writes where they cannot (event-time consent flips, legacy events, selected analysis).
 * Eligibility (180 days, sha checks, engines, coverage) is not this task: `features` may be null.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
}, 180_000);

afterAll(async () => {
  await ctx.close();
});

const BOTH = { implicitFeedback: true, implicitNegative: true } as const;

const only = (samples: LearnSample[]): LearnSample => {
  expect(samples).toHaveLength(1);
  return samples[0]!;
};

describe('the signal table (spec 06 §8.2)', () => {
  it('rating +1 is y1, weight 1.0, explicit, from the rate event, without any behavioral consent', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const done = await s.rate(a, 1);
    const rate = await s.event(a, 'rate');
    const sample = only(await s.samples());
    expect(sample).toMatchObject({
      articleId: a,
      eventId: rate.id,
      signal: 'rating',
      y: 1,
      weight: 1,
      explicit: true,
      groupId: a,
    });
    expect(sample.feedbackAt).toEqual(done.now);
    expect(sample.features?.snapshotAt).toBe(rate.value.features.snapshotAt);
  });

  it('rating -1 is y0, weight 1.0, explicit', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.rate(a, -1);
    expect(only(await s.samples())).toMatchObject({
      eventId: await s.eventId(a, 'rate'),
      signal: 'rating',
      y: 0,
      weight: 1,
      explicit: true,
    });
  });

  it('prompt answers count as ratings: liked is y1 and disliked is y0, both weight 1.0 explicit', async () => {
    const s = await Scenario.create(ctx);
    const liked = await s.article();
    const disliked = await s.article();
    await s.answer(liked, true);
    await s.answer(disliked, false);
    const samples = await s.samples();
    expect(samples).toHaveLength(2);
    expect(samples.find((x) => x.articleId === liked)).toMatchObject({
      eventId: await s.eventId(liked, 'prompt_answer'),
      signal: 'rating',
      y: 1,
      weight: 1,
      explicit: true,
    });
    expect(samples.find((x) => x.articleId === disliked)).toMatchObject({
      eventId: await s.eventId(disliked, 'prompt_answer'),
      signal: 'rating',
      y: 0,
      weight: 1,
      explicit: true,
    });
  });

  it('a bookmark without a rating is y1, weight 0.8, not explicit, from the bookmark event', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.bookmark(a);
    const bookmark = await s.event(a, 'bookmark');
    const sample = only(await s.samples());
    expect(sample).toMatchObject({
      articleId: a,
      eventId: bookmark.id,
      signal: 'bookmark',
      y: 1,
      weight: 0.8,
      explicit: false,
    });
    expect(sample.features?.snapshotAt).toBe(bookmark.value.features.snapshotAt);
  });

  it('an open with dwell of 45 s, unrated, with consent, is y1, weight 0.3, not explicit', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 45_000);
    expect(only(await s.samples())).toMatchObject({
      articleId: a,
      eventId: await s.eventId(a, 'dwell'),
      signal: 'dwell',
      y: 1,
      weight: 0.3,
      explicit: false,
    });
  });

  it('the dwell threshold is 30 s inclusive: 30 s counts, 29.999 s and 5 s are no signal', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const at30 = await s.article();
    const below = await s.article();
    const at5 = await s.article();
    for (const [article, ms] of [
      [at30, 30_000],
      [below, 29_999],
      [at5, 5_000],
    ] as const) {
      await s.open(article);
      await s.dwell(article, ms);
    }
    const samples = await s.samples();
    expect(samples.map((x) => [x.articleId, x.signal])).toEqual([[at30, 'dwell']]);
  });

  it('a complete session with dwell under 5 s is y0, weight 0.2, not explicit, with implicitFeedback only', async () => {
    const s = await Scenario.create(ctx, { implicitFeedback: true, implicitNegative: false });
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 2_000);
    expect(only(await s.samples())).toMatchObject({
      articleId: a,
      eventId: await s.eventId(a, 'dwell'),
      signal: 'bounce',
      y: 0,
      weight: 0.2,
      explicit: false,
    });
  });

  it('the bounce threshold is 5 s exclusive: 4.999 s counts', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 4_999);
    expect(only(await s.samples())).toMatchObject({ signal: 'bounce', y: 0, weight: 0.2 });
  });

  it('an explicit individual mark-read without opening is y0, weight 0.1, not explicit, with both flags', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.read(a);
    expect(only(await s.samples())).toMatchObject({
      articleId: a,
      eventId: await s.eventId(a, 'read'),
      signal: 'read',
      y: 0,
      weight: 0.1,
      explicit: false,
    });
  });

  it('an open without any dwell report is no signal (a missing beacon is unknown, not zero)', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    expect(await s.samples()).toEqual([]);
  });

  it('there is one sample per article: several articles give several samples, each with its own event', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const b = await s.article();
    await s.rate(a, 1);
    await s.rate(a, -1);
    await s.rate(a, 1);
    await s.bookmark(b);
    const samples = await s.samples();
    expect(samples.map((x) => x.articleId).sort()).toEqual([a, b].sort());
    expect(samples.find((x) => x.articleId === a)?.eventId).toBe(await s.eventId(a, 'rate', 2));
  });
});

describe('consent gates (spec 06 §8.2 "Behavioral consent")', () => {
  it('a read recorded while implicitFeedback was off never counts, even after the user opts in', async () => {
    const s = await Scenario.create(ctx, { implicitFeedback: false, implicitNegative: false });
    const a = await s.article();
    await s.read(a);
    await s.setPrefs(BOTH);
    expect(await s.samples()).toEqual([]);
  });

  it('a dwell and a bounce whose event-time implicitFeedback was false never count', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const dwelled = await s.article();
    const bounced = await s.article();
    await s.open(dwelled);
    await s.dwell(dwelled, 45_000);
    await s.open(bounced);
    await s.dwell(bounced, 2_000);
    for (const article of [dwelled, bounced]) {
      await s.patchEvent(
        await s.eventId(article, 'dwell'),
        `jsonb_set(value, '{learningConsent,implicitFeedback}', 'false'::jsonb)`,
      );
    }
    expect(await s.samples()).toEqual([]);
  });

  it('a legacy event without learningConsent is unknown consent, which means false', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const dwelled = await s.article();
    const read = await s.article();
    await s.open(dwelled);
    await s.dwell(dwelled, 45_000);
    await s.read(read);
    await s.patchEvent(await s.eventId(dwelled, 'dwell'), `value - 'learningConsent'`);
    await s.patchEvent(await s.eventId(read, 'read'), `value - 'learningConsent'`);
    expect(await s.samples()).toEqual([]);
  });

  it('with implicitFeedback off now, dwell, bounce and read samples vanish; rating and bookmark stay', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const dwelled = await s.article();
    const bounced = await s.article();
    const read = await s.article();
    const rated = await s.article();
    const saved = await s.article();
    await s.open(dwelled);
    await s.dwell(dwelled, 45_000);
    await s.open(bounced);
    await s.dwell(bounced, 2_000);
    await s.read(read);
    await s.rate(rated, 1);
    await s.bookmark(saved);
    expect((await s.samples()).map((x) => x.signal).sort()).toEqual(
      ['bookmark', 'bounce', 'dwell', 'rating', 'read'].sort(),
    );
    await s.setPrefs({ implicitFeedback: false });
    expect((await s.samples()).map((x) => [x.articleId, x.signal]).sort()).toEqual(
      [
        [rated, 'rating'],
        [saved, 'bookmark'],
      ].sort(),
    );
  });

  it('an explicit read needs implicitNegative at event time as well', async () => {
    const s = await Scenario.create(ctx, { implicitFeedback: true, implicitNegative: false });
    const a = await s.article();
    await s.read(a);
    await s.setPrefs({ implicitNegative: true });
    expect(await s.samples()).toEqual([]);
  });

  it('an explicit read needs implicitNegative now as well, while a bounce does not', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const read = await s.article();
    const bounced = await s.article();
    await s.read(read);
    await s.open(bounced);
    await s.dwell(bounced, 2_000);
    expect((await s.samples()).map((x) => x.signal).sort()).toEqual(['bounce', 'read']);
    await s.setPrefs({ implicitNegative: false });
    expect((await s.samples()).map((x) => [x.articleId, x.signal])).toEqual([[bounced, 'bounce']]);
  });
});

describe('housekeeping and neutral events never train', () => {
  it('bulk mark-read, expand reads and side-effect reads are no negative evidence, even with both flags on', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const bulk = await s.article();
    const expand = await s.article();
    const openSide = await s.article();
    const ratingSide = await s.article();
    await s.bulkRead(bulk);
    await s.read(expand, 'expand');
    for (const [article, origin] of [
      [openSide, 'open_side_effect'],
      [ratingSide, 'rating_side_effect'],
    ] as const) {
      await ctx.owner.query(
        `INSERT INTO user_article (user_id, article_id, read_at) VALUES ($1, $2, $3)`,
        [s.userId, article, s.tick()],
      );
      await s.insertEvent(article, 'read', {
        v: 1,
        signalOrigin: origin,
        learningConsent: BOTH,
        features: snapshot(),
      });
    }
    expect((await s.events(bulk)).map((e) => e.value.signalOrigin)).toEqual(['bulk_mark_read']);
    expect((await s.events(expand)).map((e) => e.value.signalOrigin)).toEqual(['expand']);
    expect(await s.samples()).toEqual([]);
  });

  it('label and unlabel events create no sample and remove none', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const label = await s.labelCard();
    const plain = await s.article();
    const rated = await s.article();
    await s.label(plain, label);
    await s.unlabel(plain, label);
    await s.rate(rated, -1);
    const before = only(await s.samples());
    await s.label(rated, label);
    await s.unlabel(rated, label);
    await s.label(rated, label);
    expect(only(await s.samples())).toEqual(before);
    expect(before.articleId).toBe(rated);
  });

  it('an unread withdraws an explicit-read sample, and a later read brings it back', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.read(a);
    expect(only(await s.samples()).signal).toBe('read');
    await s.unread(a);
    expect(await s.samples()).toEqual([]);
    await s.read(a);
    expect(only(await s.samples())).toMatchObject({
      signal: 'read',
      eventId: await s.eventId(a, 'read', 1),
    });
  });

  it('an open before the last unrate does not suppress a later explicit read', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.rate(a, 1);
    await s.rate(a, null);
    await s.unread(a);
    await s.read(a);
    expect(only(await s.samples())).toMatchObject({ signal: 'read', y: 0, weight: 0.1 });
  });

  it('an unbookmark removes the bookmark sample, and a new bookmark makes a fresh one', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.bookmark(a);
    await s.unbookmark(a);
    expect(await s.samples()).toEqual([]);
    await s.bookmark(a);
    expect(only(await s.samples())).toMatchObject({
      signal: 'bookmark',
      eventId: await s.eventId(a, 'bookmark', 1),
    });
  });
});

describe('un-rating and "the latest explicit signal wins"', () => {
  it('an un-rating suppresses all earlier implicit evidence instead of turning into a bounce dislike', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const dwelled = await s.article();
    const read = await s.article();
    await s.open(dwelled);
    await s.dwell(dwelled, 45_000);
    await s.rate(dwelled, -1);
    await s.rate(dwelled, null);
    await s.read(read);
    await s.rate(read, 1);
    await s.rate(read, null);
    expect(await s.samples()).toEqual([]);
  });

  it('implicit evidence after the un-rating counts again', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 45_000);
    await s.rate(a, 1);
    await s.rate(a, null);
    expect(await s.samples()).toEqual([]);
    await s.open(a);
    await s.dwell(a, 50_000);
    expect(only(await s.samples())).toMatchObject({
      signal: 'dwell',
      y: 1,
      weight: 0.3,
      eventId: await s.eventId(a, 'dwell', 1),
    });
  });

  it('an un-rating leaves the bookmark standing', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.bookmark(a);
    await s.rate(a, 1);
    await s.rate(a, null);
    expect(only(await s.samples())).toMatchObject({
      signal: 'bookmark',
      y: 1,
      weight: 0.8,
      eventId: await s.eventId(a, 'bookmark'),
    });
  });

  it('+1 then -1 is y0 from the second rate event', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.rate(a, 1);
    await s.rate(a, -1);
    expect(only(await s.samples())).toMatchObject({
      signal: 'rating',
      y: 0,
      weight: 1,
      explicit: true,
      eventId: await s.eventId(a, 'rate', 1),
    });
  });

  it('+1, -1, then undo of the -1 is y1 with the first rate event, at its original time', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const first = await s.rate(a, 1);
    const second = await s.rate(a, -1);
    await s.undo(second.key!);
    const sample = only(await s.samples());
    expect(sample).toMatchObject({
      signal: 'rating',
      y: 1,
      weight: 1,
      explicit: true,
      eventId: await s.eventId(a, 'rate', 0),
    });
    expect(sample.feedbackAt).toEqual(first.now);
  });

  it('a rating whose only rate was undone gives no rating sample and falls through to the bookmark', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.bookmark(a);
    const rated = await s.rate(a, -1);
    expect(only(await s.samples()).signal).toBe('rating');
    await s.undo(rated.key!);
    expect(only(await s.samples())).toMatchObject({
      signal: 'bookmark',
      y: 1,
      weight: 0.8,
      eventId: await s.eventId(a, 'bookmark'),
    });
  });

  it('a rating whose only rate was undone falls through to the surviving implicit signal', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 45_000);
    const rated = await s.rate(a, -1);
    await s.undo(rated.key!);
    expect(only(await s.samples())).toMatchObject({
      signal: 'dwell',
      y: 1,
      weight: 0.3,
      eventId: await s.eventId(a, 'dwell'),
    });
  });

  it('a rating whose only rate was undone, with nothing else, gives no sample', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const rated = await s.rate(a, 1);
    await s.undo(rated.key!);
    expect(await s.samples()).toEqual([]);
  });

  it('undoing an un-rating restores the original rating event', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const first = await s.rate(a, 1);
    const cleared = await s.rate(a, null);
    expect(await s.samples()).toEqual([]);
    await s.undo(cleared.key!);
    const sample = only(await s.samples());
    expect(sample).toMatchObject({
      signal: 'rating',
      y: 1,
      weight: 1,
      eventId: await s.eventId(a, 'rate', 0),
    });
    expect(sample.feedbackAt).toEqual(first.now);
  });

  it('a prompt answer is the latest explicit signal over an earlier rate, and the reverse', async () => {
    const s = await Scenario.create(ctx);
    const answered = await s.article();
    const rated = await s.article();
    await s.rate(answered, 1);
    await s.answer(answered, false);
    await s.answer(rated, true);
    await s.rate(rated, -1);
    const samples = await s.samples();
    expect(samples.find((x) => x.articleId === answered)).toMatchObject({
      y: 0,
      eventId: await s.eventId(answered, 'prompt_answer'),
    });
    expect(samples.find((x) => x.articleId === rated)).toMatchObject({
      y: 0,
      eventId: await s.eventId(rated, 'rate'),
    });
  });
});

describe('priority: rating > bookmark > dwell > bounce > read', () => {
  it('a rating beats a bookmark and the implicit signals, and signals do not accumulate', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.bookmark(a);
    await s.open(a);
    await s.dwell(a, 45_000);
    await s.rate(a, -1);
    expect(only(await s.samples())).toMatchObject({
      signal: 'rating',
      y: 0,
      weight: 1,
      eventId: await s.eventId(a, 'rate'),
    });
  });

  it('a bookmark beats an observed dwell, whichever came first', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const bookmarkedFirst = await s.article();
    const dwelledFirst = await s.article();
    await s.bookmark(bookmarkedFirst);
    await s.open(bookmarkedFirst);
    await s.dwell(bookmarkedFirst, 45_000);
    await s.open(dwelledFirst);
    await s.dwell(dwelledFirst, 45_000);
    await s.bookmark(dwelledFirst);
    for (const sample of await s.samples()) {
      expect(sample).toMatchObject({ signal: 'bookmark', y: 1, weight: 0.8 });
    }
  });

  it('a dwell session beats a bounce session of the same article, whichever came first', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const bounceFirst = await s.article();
    const dwellFirst = await s.article();
    await s.open(bounceFirst);
    await s.dwell(bounceFirst, 2_000);
    await s.open(bounceFirst);
    await s.dwell(bounceFirst, 45_000);
    await s.open(dwellFirst);
    await s.dwell(dwellFirst, 45_000);
    await s.open(dwellFirst);
    await s.dwell(dwellFirst, 2_000);
    const samples = await s.samples();
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample).toMatchObject({ signal: 'dwell', y: 1, weight: 0.3 });
    }
  });

  it('a bounce beats an earlier explicit read', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.read(a);
    await s.open(a);
    await s.dwell(a, 2_000);
    expect(only(await s.samples())).toMatchObject({
      signal: 'bounce',
      y: 0,
      weight: 0.2,
      eventId: await s.eventId(a, 'dwell'),
    });
  });
});

describe('the event-time snapshot', () => {
  it('a dwell sample takes the features of the open event of the same session', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 45_000);
    const open = await s.event(a, 'open');
    const dwell = await s.event(a, 'dwell');
    expect(dwell.value.openedAt).toBe(open.createdAt.toISOString());
    expect(open.value.features.snapshotAt).not.toBe(dwell.value.features.snapshotAt);
    const sample = only(await s.samples());
    expect(sample.features?.snapshotAt).toBe(open.value.features.snapshotAt);
    expect(sample.eventId).toBe(dwell.id);
  });

  it('a bounce sample takes the open event features too', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    await s.open(a);
    await s.dwell(a, 2_000);
    const open = await s.event(a, 'open');
    expect(only(await s.samples()).features?.snapshotAt).toBe(open.value.features.snapshotAt);
  });

  it('a dwell sample falls back to its own features when the open event has none', async () => {
    const s = await Scenario.create(ctx, { implicitFeedback: false, implicitNegative: false });
    const a = await s.article();
    await s.open(a);
    expect((await s.event(a, 'open')).value.features).toBeUndefined();
    await s.setPrefs(BOTH);
    await s.dwell(a, 45_000);
    const dwell = await s.event(a, 'dwell');
    const sample = only(await s.samples());
    expect(sample.signal).toBe('dwell');
    expect(sample.features?.snapshotAt).toBe(dwell.value.features.snapshotAt);
  });

  it('a rating whose snapshot is null takes the latest earlier snapshot of the same content revision', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.rate(a, 1);
    await s.inferenceOff();
    await s.rate(a, -1);
    const first = await s.event(a, 'rate', 0);
    const second = await s.event(a, 'rate', 1);
    expect(second.value.features).toBeNull();
    const sample = only(await s.samples());
    expect(sample).toMatchObject({ y: 0, eventId: second.id });
    expect(sample.features).toEqual(first.value.features);
  });

  it('the fallback never borrows a snapshot of another content revision', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.rate(a, 1);
    await ctx.owner.query(`UPDATE articles SET content_revision = 2 WHERE id = $1`, [a]);
    await s.inferenceOff();
    await s.rate(a, -1);
    const second = await s.event(a, 'rate', 1);
    expect(second.value.contentRevision).toBe('2');
    expect(second.value.features).toBeNull();
    const sample = only(await s.samples());
    expect(sample).toMatchObject({ y: 0, eventId: second.id });
    expect(sample.features).toBeNull();
  });

  it('a lone rating with a null snapshot is still a sample, with null features', async () => {
    const s = await Scenario.create(ctx);
    await s.inferenceOff();
    const a = await s.article();
    await s.rate(a, 1);
    const sample = only(await s.samples());
    expect(sample).toMatchObject({ signal: 'rating', y: 1, groupId: a });
    expect(sample.features).toBeNull();
  });

  it('the group is the snapshot story cluster, else the article', async () => {
    const s = await Scenario.create(ctx);
    const clustered = await s.article();
    const alone = await s.article();
    const cluster = await s.cluster(clustered);
    await s.rate(clustered, 1);
    await s.rate(alone, 1);
    const samples = await s.samples();
    expect(samples.find((x) => x.articleId === clustered)?.groupId).toBe(cluster);
    expect(samples.find((x) => x.articleId === clustered)?.features?.values.clusterId).toBe(
      cluster,
    );
    expect(samples.find((x) => x.articleId === alone)?.groupId).toBe(alone);
  });
});

describe('selected analysis requests (spec 06 §8.2, spec 05 §1.1)', () => {
  const CARD = '501';
  const OTHER_CARD = '502';

  it('a completed request fills the missing p of the listed cards and the facets, keeping the event-time strength', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, {
      status: 'complete',
      cards: [
        { cardId: CARD, p: 0.8 },
        { cardId: OTHER_CARD, p: 0.9 },
      ],
      features: { 'topic.a': 0.25, 'topic.b': 0.75 },
    });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    const sample = only(await s.samples());
    expect(sample).toMatchObject({ articleId: a, signal: 'rating', y: 1 });
    expect(sample.features?.cards).toHaveLength(1);
    expect(sample.features?.cards[0]).toMatchObject({ id: CARD, strength: 'love', p: 0.8 });
    expect(sample.features?.values.facets).toEqual({ 'topic.a': 0.25, 'topic.b': 0.75 });
    expect(sample.features?.values.facetsEngine).toBe('typesafe');
  });

  it('a card the snapshot does not list is not added from the result', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, {
      status: 'complete',
      cards: [
        { cardId: CARD, p: 0.8 },
        { cardId: OTHER_CARD, p: 0.9 },
      ],
      features: { 'topic.a': 0.25 },
    });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({ cards: [{ id: CARD, strength: 'like', p: null, engine: null }] }),
    });
    expect(only(await s.samples()).features?.cards.map((c) => c.id)).toEqual([CARD]);
  });

  it('a card that already has p, and facets that are already set, keep their event-time values', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, {
      status: 'complete',
      cards: [
        { cardId: CARD, p: 0.1 },
        { cardId: OTHER_CARD, p: 0.2 },
      ],
      features: { 'topic.a': 0.99 },
    });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({
        cards: [
          { id: CARD, strength: 'must', p: 0.55, engine: 'typesafe' },
          { id: OTHER_CARD, strength: 'like', p: null, engine: null },
        ],
        values: {
          facets: { 'topic.a': 0.3 },
          facetsEngine: 'typesafe',
          clusterId: null,
        },
      }),
    });
    const features = only(await s.samples()).features!;
    expect(features.cards.find((c) => c.id === CARD)).toMatchObject({ strength: 'must', p: 0.55 });
    expect(features.cards.find((c) => c.id === OTHER_CARD)).toMatchObject({ p: 0.2 });
    expect(features.values.facets).toEqual({ 'topic.a': 0.3 });
  });

  it('the filled card carries the typesafe engine of the result (inferred: a p needs its engine family)', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, {
      status: 'complete',
      cards: [{ cardId: CARD, p: 0.8 }],
      features: {},
    });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    expect(only(await s.samples()).features?.cards[0]).toMatchObject({
      p: 0.8,
      engine: 'typesafe',
    });
  });

  it('a request whose input hash differs from the event inputSha completes nothing', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, {
      status: 'complete',
      cards: [{ cardId: CARD, p: 0.8 }],
      features: { 'topic.a': 0.5 },
    });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: '0'.repeat(64),
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    const sample = only(await s.samples());
    expect(sample.features?.cards[0]).toMatchObject({ id: CARD, p: null });
    expect(sample.features?.values.facets).toBeNull();
    expect(sample.features?.values.facetsEngine).toBeNull();
  });

  it('a request that is not complete completes nothing', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const request = await analysisRequest(s, a, { status: 'pending' });
    await s.insertRating(a, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    const sample = only(await s.samples());
    expect(sample.features?.cards[0]).toMatchObject({ p: null });
    expect(sample.features?.values.facets).toBeNull();
  });

  it('an unknown request id completes nothing and does not fail the load', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await s.insertRating(a, {
      analysisRequestId: '00000000-0000-4000-8000-000000000000',
      inputSha: 'a'.repeat(64),
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    expect(only(await s.samples()).features?.cards[0]).toMatchObject({ p: null });
  });

  it('a rating without an analysis request is never completed from anything', async () => {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    await analysisRequest(s, a, {
      status: 'complete',
      cards: [{ cardId: CARD, p: 0.8 }],
      features: { 'topic.a': 0.5 },
    });
    await s.insertRating(a, {
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    const sample = only(await s.samples());
    expect(sample.features?.cards[0]).toMatchObject({ p: null });
    expect(sample.features?.values.facets).toBeNull();
  });

  it("another reader never borrows this reader's request result", async () => {
    const owner = await Scenario.create(ctx);
    const other = await Scenario.create(ctx);
    const a = await owner.article();
    const request = await analysisRequest(owner, a, {
      status: 'complete',
      cards: [{ cardId: CARD, p: 0.8 }],
      features: { 'topic.a': 0.5 },
    });
    const b = await other.article();
    await other.insertRating(b, {
      analysisRequestId: request.requestId,
      inputSha: request.inputSha,
      features: snapshot({ cards: [{ id: CARD, strength: 'love', p: null, engine: null }] }),
    });
    const sample = only(await other.samples());
    expect(sample.features?.cards[0]).toMatchObject({ p: null });
    expect(sample.features?.values.facets).toBeNull();
  });
});

describe('cutoff and isolation', () => {
  it('cutoffEventId is the highest event id considered, as a decimal string', async () => {
    const s = await Scenario.create(ctx, BOTH);
    const a = await s.article();
    const b = await s.article();
    await s.rate(a, 1);
    await s.bookmark(b);
    await s.open(b);
    await s.dwell(b, 2_000);
    await s.rate(b, -1);
    const all = await s.events();
    const highest = all[all.length - 1]!.id;
    const { samples, cutoffEventId } = await s.load();
    expect(samples).toHaveLength(2);
    expect(cutoffEventId).toBe(highest);
    expect(typeof cutoffEventId).toBe('string');
    expect(cutoffEventId).toMatch(/^[1-9][0-9]*$/);
  });

  it('cutoffEventId ignores events newer than anything of this reader that belong to someone else', async () => {
    const s = await Scenario.create(ctx);
    const other = await Scenario.create(ctx);
    const a = await s.article();
    await s.rate(a, 1);
    const mine = (await s.events()).at(-1)!.id;
    const b = await other.article();
    await other.rate(b, 1);
    await other.rate(b, -1);
    expect(BigInt((await other.events()).at(-1)!.id)).toBeGreaterThan(BigInt(mine));
    expect((await s.load()).cutoffEventId).toBe(mine);
  });

  it('a reader without any feedback event has no samples and a null cutoff', async () => {
    const s = await Scenario.create(ctx, BOTH);
    await s.article();
    expect(await s.load()).toEqual({ samples: [], cutoffEventId: null });
  });

  it("another reader's events and ratings of the same article never leak", async () => {
    const mine = await Scenario.create(ctx, BOTH);
    const theirs = await Scenario.create(ctx, BOTH);
    const shared = await mine.article();
    await theirs.ctx.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid) VALUES ($1, $2, 'shared-guid')`,
      [theirs.feedId, shared],
    );
    await theirs.rate(shared, 1);
    await theirs.bookmark(shared);
    expect(await mine.load()).toEqual({ samples: [], cutoffEventId: null });
    await mine.rate(shared, -1);
    const sample = only(await mine.samples());
    expect(sample).toMatchObject({ y: 0, eventId: await mine.eventId(shared, 'rate') });
    const theirSample = only(await theirs.samples());
    expect(theirSample).toMatchObject({ y: 1, eventId: await theirs.eventId(shared, 'rate') });
  });
});

describe('derived snapshots from a frozen request (spec 06 §8.2)', () => {
  const RATING_SHA = 'e'.repeat(64);

  async function setup() {
    const s = await Scenario.create(ctx);
    const a = await s.article();
    const at = s.tick();
    const request = await frozenRequest(s, a, {
      publishedAt: new Date(at.getTime() - 5 * 3_600_000),
      firstSeenAt: new Date(at.getTime() - 3 * 3_600_000),
      cards: [
        { cardId: '501', kind: 'interest', strength: 'love', p: 0.8 },
        { cardId: '502', kind: 'interest', strength: 'never' },
        { cardId: '503', kind: 'label', strength: null, p: 0.4 },
      ],
      facets: { 'topic.a': 0.25 },
    });
    return { s, a, at, request };
  }

  it('a rating without features derives its snapshot from the matching frozen request', async () => {
    const { s, a, at, request } = await setup();
    await s.insertRating(
      a,
      {
        analysisRequestId: request.requestId,
        inputSha: request.inputSha,
        ratingSha: RATING_SHA,
        features: null,
      },
      { at },
    );
    const sample = only(await s.samples());
    expect(sample).toMatchObject({ articleId: a, signal: 'rating', y: 1, groupId: '77' });
    expect(sample.features).toEqual({
      specSha: FEATURE_SPEC_SHA,
      ratingSha: RATING_SHA,
      snapshotAt: at.toISOString(),
      cards: [
        { id: '501', strength: 'love', p: 0.8, engine: 'typesafe' },
        { id: '502', strength: 'never', p: null, engine: null },
      ],
      values: {
        facets: { 'topic.a': 0.25 },
        facetsEngine: 'typesafe',
        wordCount: 321,
        ageHours: 5,
        lang: 'cs',
        hasImage: true,
        hasVideo: false,
        bodyImageCount: 2,
        clusterId: '77',
        clusterSize: 4,
        sourceFeedId: s.feedId,
        author: 'Frozen Author',
      },
    });
  });

  it('a mismatching input sha, or a missing rating sha, leaves the features null', async () => {
    const { s, a, at, request } = await setup();
    await s.insertRating(
      a,
      {
        analysisRequestId: request.requestId,
        inputSha: '0'.repeat(64),
        ratingSha: RATING_SHA,
        features: null,
      },
      { at },
    );
    expect(only(await s.samples()).features).toBeNull();

    const other = await setup();
    await other.s.insertRating(
      other.a,
      {
        analysisRequestId: other.request.requestId,
        inputSha: other.request.inputSha,
        features: null,
      },
      { at: other.at },
    );
    expect(only(await other.s.samples()).features).toBeNull();
  });
});
