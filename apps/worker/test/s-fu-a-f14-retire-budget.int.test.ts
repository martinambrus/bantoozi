import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cutBudgetAfterPages } from './support/budget.js';
import { ClassifyHarness } from './support/classify.js';
import { RetentionBWorld } from './support/retention-b-world.js';
import { DAY, RetentionCWorld } from './support/retention-c-world.js';
import { RetentionWorld } from './support/retention-world.js';

/**
 * M8-F14 (PLAN §14.1, spec 11 §6): the `house.retire-cards` sweeps stop when the run budget is
 * spent, save the keyset position in `house.progress`, and the next run resumes after it.
 *
 * Clock reads of the handler (`cutBudgetAfterPages('house-retire-cards', 2)`): one at the start,
 * one before the single page of the `unretired` sweep, one before the first page of `retired`
 * (runs), one before its second page (cut).
 *
 * Note: the handler already behaves this way; this test is a regression guard, not a failing test.
 */

const NOW = new Date(Date.now() + 100 * DAY);
const RETIRE = 'house.retire-cards' as const;
const CARDS = 230; // 100 per page: pages of 100, 100, 30

let h: ClassifyHarness;
let c: RetentionCWorld;
let b: RetentionBWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  b = new RetentionBWorld(new RetentionWorld(h));
  c = new RetentionCWorld(b);
}, 240_000);

afterAll(async () => {
  await b?.w.close();
  await h?.close();
});

describe('M8-F14 house.retire-cards resumes a budget-cut sweep from its saved cursor', () => {
  it('retires 100 cards per cut run, saves the position, and finishes in later runs', async () => {
    const user = await b.user();
    const ids: string[] = [];
    for (let i = 0; i < CARDS; i += 1) ids.push(await c.privateCard(user));
    const retiredCount = async (): Promise<number> =>
      (
        await h.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM interest_cards WHERE id = ANY($1::bigint[]) AND retired_at IS NOT NULL`,
          [ids],
        )
      ).rows[0]!.n;
    const position = async (): Promise<bigint | undefined> => {
      const row = (
        await h.owner.query<{
          value: Record<string, { cursor?: { sweeps?: { retired?: string } } }>;
        }>("SELECT value FROM settings WHERE key = 'house.progress'")
      ).rows[0];
      const at = row?.value[RETIRE]?.cursor?.sweeps?.retired;
      return at === undefined ? undefined : BigInt(at);
    };
    const cut = async (): Promise<void> => {
      const restore = cutBudgetAfterPages('house-retire-cards', 2);
      try {
        await c.run(RETIRE, NOW);
      } finally {
        restore();
      }
    };

    await cut();
    const first = await position();
    expect(first, 'a cut run saves where it stopped').toBeDefined();
    const afterFirst = await retiredCount();
    expect(afterFirst, 'the cut run did not finish the sweep').toBeLessThan(CARDS);
    expect(afterFirst).toBeGreaterThan(0);

    await cut();
    const second = await position();
    expect(second! > first!, 'the next run continues after the saved position').toBe(true);
    expect(await retiredCount()).toBeGreaterThan(afterFirst);

    await c.run(RETIRE, NOW);
    expect(await retiredCount(), 'an uncut run reaches the last cards').toBe(CARDS);
    expect(await position(), 'a finished pass clears the position').toBeUndefined();
  }, 180_000);
});
