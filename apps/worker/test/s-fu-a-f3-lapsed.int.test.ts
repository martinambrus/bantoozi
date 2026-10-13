import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 * M8-F3 follow-up: only a real weak or failed translation attempt stamps
 * `interest_cards.translation_attempted_at`. A card whose demand lapsed before the attempt is not
 * stamped, so a later unrestricted run inside the 6 h backoff tries it once demand returns.
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

const JOB = 'house.translate-cards' as const;

async function attemptedAt(cardId: string): Promise<Date | null> {
  return (
    await h.owner.query<{ at: Date | null }>(
      'SELECT translation_attempted_at AS at FROM interest_cards WHERE id = $1',
      [cardId],
    )
  ).rows[0]!.at;
}

async function runAt(at: Date): Promise<void> {
  const handlers = h.handlersWith({ now: () => at });
  const { dispatch } = await import('../src/handlers/index.js');
  const { parseJobPayload } = await import('@bantoozi/shared');
  await dispatch(handlers, JOB, parseJobPayload(JOB, {}), { queue: JOB, jobId: 'direct' });
}

describe('M8-F3 translation_attempted_at is stamped only for a real attempt', () => {
  it('does not stamp a card whose demand lapsed before the attempt', async () => {
    await h.setSetting('card_text_mode', 'english');
    const { userId, cardId: first } = await holder(h, 'active');
    const second = await untranslatedCard(h, userId);
    const t0 = new Date();

    // The first card's request is slow; while it is in flight the second card loses its demand.
    w.lt.setOptions({ delayMs: 400 });
    const running = runAt(t0);
    for (let i = 0; i < 200 && w.ltCalls() < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(w.ltCalls(), 'the first card is in flight').toBe(1);
    await h.owner.query('DELETE FROM user_cards WHERE card_id = $1', [second]);
    await running;

    expect(w.ltCalls(), 'the lapsed card was never sent').toBe(1);
    expect((await storedCard(h, first)).interestEn).toEqual(expect.any(String));
    expect((await storedCard(h, second)).interestEn).toBeNull();
    expect(await attemptedAt(second), 'a lapsed card is not stamped').toBeNull();

    w.lt.setOptions({ delayMs: 0 });
    await h.hold(userId, second);
    await runAt(new Date(t0.getTime() + HOUR));
    expect(w.ltCalls(), 'demand returned: tried once, inside the 6 h backoff').toBe(2);
    expect((await storedCard(h, second)).interestEn).toEqual(expect.any(String));
  }, 60_000);

  it('stamps a weak result (control)', async () => {
    await h.setSetting('card_text_mode', 'english');
    const { cardId } = await holder(h, 'active');
    w.lt.setOptions({ mode: 'weak' });
    await runAt(new Date());
    expect(w.ltCalls()).toBe(1);
    expect(await attemptedAt(cardId), 'a weak result is stamped').not.toBeNull();
  });
});
