import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cutBudgetAfterPages } from './support/budget.js';
import { HOUR } from './support/classify.js';
import {
  holder,
  resetTranslateWorld,
  startTranslateWorld,
  storedCard,
  untranslatedCard,
  type TranslateWorld,
} from './support/translate-world.js';

/**
 * M8-F3 (PLAN §14.1, spec 07 §5, spec 11 §6): `house.translate-cards`
 *
 * Rules pinned here:
 * 1. Budget: the handler runs under HOUSE_RUN_BUDGET_MS and reads `Date.now()` from its own source
 *    file (`house-translate-cards`) once at the start and once before each page, like
 *    `house.retire-cards`. A cut run stops after the page in progress, records `house.progress`
 *    WITHOUT `completedAt` and WITH a `cursor`; the next run resumes and finishes (completedAt set,
 *    cursor dropped).
 * 2. Backoff: a card whose translation came back weak or failed is not sent to the translator
 *    again by an unrestricted (`{}`) run for 6 hours after that attempt (by the run clock
 *    `deps.now`); after 6 hours it is retried. A `{userId}` run (a user event, spec 07 §5) always
 *    retries it. A card never attempted before is not held back by another card's backoff.
 */

let w: TranslateWorld;
let h: TranslateWorld['h'];

beforeAll(async () => {
  w = await startTranslateWorld();
  h = w.h;
});
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  await resetTranslateWorld(w);
});

const ENGLISH = 'english' as const;
const JOB = 'house.translate-cards';

async function progress(): Promise<{ completedAt?: string; cursor?: unknown } | undefined> {
  const row = (
    await h.owner.query<{ value: Record<string, { completedAt?: string; cursor?: unknown }> }>(
      "SELECT value FROM settings WHERE key = 'house.progress'",
    )
  ).rows[0];
  return row?.value[JOB];
}

describe('M8-F3 house.translate-cards run budget', () => {
  it('stops at the budget with a saved cursor and resumes in the next run', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const first = await holder(h, 'active');
    const ids = [first.cardId];
    for (let i = 0; i < 109; i += 1) ids.push(await untranslatedCard(h, first.userId));
    const translated = async (): Promise<number> =>
      (
        await h.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM interest_cards
            WHERE id = ANY($1::bigint[]) AND body->>'interest_en' IS NOT NULL`,
          [ids],
        )
      ).rows[0]!.n;

    const restore = cutBudgetAfterPages('house-translate-cards', 1);
    try {
      await h.dispatch('house.translate-cards', {});
    } finally {
      restore();
    }
    const afterCut = await translated();
    expect(afterCut, 'the cut run stops after one page (100 cards)').toBe(100);
    const cut = await progress();
    expect(cut?.completedAt, 'a cut run is not complete').toBeUndefined();
    expect(cut?.cursor, 'a cut run saves a cursor').toBeDefined();

    await h.dispatch('house.translate-cards', {});
    expect(await translated(), 'the next run finishes the rest').toBe(110);
    expect(w.ltCalls(), 'no card is sent twice').toBe(110);
    const done = await progress();
    expect(done?.completedAt).toBeDefined();
    expect(done?.cursor, 'a finished pass drops the cursor').toBeUndefined();
  }, 180_000);
});

describe('M8-F3 weak or failed card translations are not retried on every {} run', () => {
  for (const mode of ['weak', 'fail'] as const) {
    it(`backs off a ${mode} card for 6 hours, retries it after, and always on a user event`, async () => {
      await h.setSetting('card_text_mode', ENGLISH);
      const { userId, cardId } = await holder(h, 'active');
      const t0 = new Date();
      const run = async (at: Date, payload: { userId?: string } = {}): Promise<void> => {
        const handlers = h.handlersWith({ now: () => at });
        const { dispatch } = await import('../src/handlers/index.js');
        const { parseJobPayload } = await import('@bantoozi/shared');
        await dispatch(handlers, JOB, parseJobPayload(JOB, payload), {
          queue: JOB,
          jobId: 'direct',
        });
      };
      w.lt.setOptions({ mode });

      await run(t0);
      expect(w.ltCalls(), 'first attempt').toBe(1);

      await run(new Date(t0.getTime() + HOUR));
      expect(w.ltCalls(), 'an hour later a {} run does not retry').toBe(1);

      // A card never attempted is not held back by the first card's backoff.
      const other = await untranslatedCard(h, userId);
      await run(new Date(t0.getTime() + 2 * HOUR));
      expect(w.ltCalls(), 'only the new card is sent').toBe(2);

      await run(new Date(t0.getTime() + 3 * HOUR), { userId });
      expect(w.ltCalls(), 'a user event retries both held cards').toBe(4);

      w.lt.setOptions({ mode: 'ok' });
      await run(new Date(t0.getTime() + 4 * HOUR));
      expect(w.ltCalls(), 'still inside 6 h of the last attempt: no retry').toBe(4);
      expect((await storedCard(h, cardId)).interestEn).toBeNull();

      await run(new Date(t0.getTime() + 10 * HOUR));
      expect(w.ltCalls(), 'after 6 h both cards are retried').toBe(6);
      expect((await storedCard(h, cardId)).interestEn).toEqual(expect.any(String));
      expect((await storedCard(h, other)).interestEn).toEqual(expect.any(String));
    });
  }
});
