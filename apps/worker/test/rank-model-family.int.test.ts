import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { V113, V114, V2, begin, flip } from './support/jev4-world.js';
import {
  SIMPLE_MODEL,
  installModel,
  rank,
  rankRow,
  reader,
  simpleP,
} from './support/rank-model-world.js';

/**
 * JEV-3 F1b (spec 06 §8.1): the personal model scores a row whose facets and interest-card answers
 * come from another release of the pin's Jev major. Another major, a moving alias, a major alone,
 * a null model or a non-Jev id never count. Through the real `user.rank`; effects read from
 * `user_article`.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

type Model = string | null;

/** A reader with an active simple model stored under pin `pin`, then the pin moved to `to`. */
async function world(pin: string, to?: string) {
  await begin(h, pin);
  const r = await reader(h);
  await installModel(h, r.userId, SIMPLE_MODEL);
  if (to !== undefined) await flip(h, to);
  return r;
}

async function article(
  r: { feedId: string; cardId: string },
  facets: Model,
  answer: Model,
): Promise<string> {
  const articleId = await h.article({ feedIds: [r.feedId] });
  await h.enrichDirect(articleId, { state: 'matched', model: facets });
  await h.answerCard(articleId, r.cardId, { engine: 'typesafe', model: answer, p: 0.9 });
  return articleId;
}

describe('the model scores rows of the same Jev major (spec 06 §8.1)', () => {
  it('an unrebuilt row of the older release scores by the model after the pin moves inside the major', async () => {
    const r = await world(V113, V114);
    const old = await article(r, V113, V113);
    const fresh = await article(r, V114, V114);
    await rank(h, r.userId, { full: true });
    for (const id of [old, fresh]) {
      const row = await rankRow(h, r.userId, id);
      expect(row.source).toBe('model');
      expect(row.p).toBeCloseTo(simpleP(0.9), 4);
    }
  });

  it.each([
    ['facets of the new release, answer of the old', V114, V113],
    ['facets of the old release, answer of the new', V113, V114],
  ] as const)('a mixed row (%s) scores by the model', async (_name, facets, answer) => {
    const r = await world(V113, V114);
    const id = await article(r, facets, answer);
    await rank(h, r.userId, { full: true });
    const row = await rankRow(h, r.userId, id);
    expect(row.source).toBe('model');
    expect(row.p).toBeCloseTo(simpleP(0.9), 4);
  });

  it('a row keeps the model across the pin move, the rematch and the full re-rank', async () => {
    const r = await world(V113);
    const id = await article(r, V113, V113);
    await rank(h, r.userId, { full: true });
    expect((await rankRow(h, r.userId, id)).source).toBe('model');

    await flip(h, V114);
    await h.dispatchAs(V114, 'house.rematch', {});
    await rank(h, r.userId, { full: true });
    const row = await rankRow(h, r.userId, id);
    expect(row.source).toBe('model');
    expect(row.p).toBeCloseTo(simpleP(0.9), 4);
  });
});

describe('answers that are not of the pin family never feed the model', () => {
  const others: Array<[string, Model]> = [
    ['another major', V2],
    ['the moving alias', 'jev-latest'],
    ['a major alone', 'jev-1'],
    ['an older non-Jev id', 'older-model'],
    ['no model', null],
  ];

  it.each(others)('facets of %s score by the cards', async (_name, model) => {
    const r = await world(V113, V114);
    const id = await article(r, model, V114);
    await rank(h, r.userId, { full: true });
    const row = await rankRow(h, r.userId, id);
    expect(row.source).toBe('cards');
    expect(row.p).toBeCloseTo(0.72, 4);
  });

  it.each(others)('an answer of %s scores by the cards', async (_name, model) => {
    const r = await world(V113, V114);
    const id = await article(r, V114, model);
    await rank(h, r.userId, { full: true });
    const row = await rankRow(h, r.userId, id);
    expect(row.source).toBe('cards');
    expect(row.p).toBeCloseTo(0.72, 4);
  });

  it.each(['facets', 'answer'] as const)(
    'a Jev release in the %s under a non-Jev pin scores by the cards',
    async (part) => {
      const r = await world('jev-test-1');
      const id = await article(
        r,
        part === 'facets' ? V113 : 'jev-test-1',
        part === 'answer' ? V113 : 'jev-test-1',
      );
      await rank(h, r.userId, { full: true });
      const row = await rankRow(h, r.userId, id);
      expect(row.source).toBe('cards');
      expect(row.p).toBeCloseTo(0.72, 4);
    },
  );
});
