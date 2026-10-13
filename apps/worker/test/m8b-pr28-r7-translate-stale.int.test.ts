import { dispatch } from '../src/handlers/index.js';
import type { ClassificationDeps } from '../src/handlers/deps.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  holder,
  resetTranslateWorld,
  slovakArticle,
  startTranslateWorld,
  translationRows,
  type TranslateWorld,
} from './support/translate-world.js';
import { DAY, ago } from './support/classify.js';

/**
 * PR #28 Codex round 7, finding 1 (audit): `article.translate` and `house.translate-cards` call the
 * LibreTranslate/Ollama clients, which are restart-class, and store results the classification
 * reads. Both carry the stale-worker guards: the start refuses a stale process and the storing
 * transaction discards a result produced while the pin (or a restart-class value) moved.
 */
let w: TranslateWorld;
let h: TranslateWorld['h'];

beforeAll(async () => {
  w = await startTranslateWorld();
  h = w.h;
}, 240_000);
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  await resetTranslateWorld(w);
  await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
});

const movePin = () =>
  h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('engine.model_pin', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ model: 'jev-other-9', since: '2026-10-02T00:00:00.000Z' })],
  );

/** The handler map whose LibreTranslate client runs `during` before each translate call. */
function handlersDuring(during: () => Promise<unknown>) {
  const classification = h.deps.classification as ClassificationDeps;
  const translation = classification.translation!;
  const original = translation.libretranslate;
  return h.handlersWith({
    classification: {
      ...classification,
      translation: {
        ...translation,
        libretranslate: {
          ...original,
          translate: (async (...args: Parameters<typeof original.translate>) => {
            await during();
            return original.translate(...args);
          }) as typeof original.translate,
          translateArticle: (async (...args: Parameters<typeof original.translateArticle>) => {
            await during();
            return original.translateArticle(...args);
          }) as typeof original.translateArticle,
        },
      },
    },
  });
}

const run = (
  handlers: ReturnType<typeof handlersDuring>,
  queue: 'article.translate' | 'house.translate-cards',
  payload: object,
) =>
  dispatch(handlers, queue, payload as never, { queue, jobId: 'r7' }).then(
    () => undefined,
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number },
  );

async function translateSetup() {
  const userId = await h.user();
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, 'active', ago(40 * DAY));
  return slovakArticle(h, feedId);
}

describe('article.translate stale-worker guards (PR #28 round 7)', () => {
  it('discards the rows and fails when the pin moved during the translator call', async () => {
    const articleId = await translateSetup();
    const error = await run(handlersDuring(movePin), 'article.translate', { articleId });
    expect(w.ltCalls(), 'the translator was called').toBe(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await translationRows(h, articleId)).toEqual([]);
    expect((await h.articleRow(articleId)).state).toBe('extracted');
  });

  it('refuses before calling the translator when the pin already moved', async () => {
    const articleId = await translateSetup();
    await movePin();
    const error = await run(h.handlers, 'article.translate', { articleId });
    expect(error).toMatchObject({ name: 'StaleWorkerError' });
    expect(w.ltCalls()).toBe(0);
  });

  it('control: nothing moved stores the row and continues', async () => {
    const articleId = await translateSetup();
    const error = await run(
      handlersDuring(async () => {}),
      'article.translate',
      { articleId },
    );
    expect(error).toBeUndefined();
    expect((await translationRows(h, articleId)).length).toBeGreaterThan(0);
    expect((await h.articleRow(articleId)).state).toBe('translated');
  });
});

describe('house.translate-cards stale-worker guards (PR #28 round 7)', () => {
  const filled = async (cardId: string) =>
    (
      await h.owner.query<{ en: string | null }>(
        `SELECT body->>'interest_en' AS en FROM interest_cards WHERE id = $1`,
        [cardId],
      )
    ).rows[0]?.en ?? null;

  it('discards the pair when the pin moved during the translator call', async () => {
    await h.setSetting('card_text_mode', 'english');
    const { cardId } = await holder(h, 'active');
    const error = await run(handlersDuring(movePin), 'house.translate-cards', {});
    expect(w.ltCalls()).toBe(1);
    expect(error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
    expect(await filled(cardId)).toBeNull();
  });

  it('refuses before calling the translator when the pin already moved', async () => {
    await h.setSetting('card_text_mode', 'english');
    await holder(h, 'active');
    await movePin();
    const error = await run(h.handlers, 'house.translate-cards', {});
    expect(error).toMatchObject({ name: 'StaleWorkerError' });
    expect(w.ltCalls()).toBe(0);
  });

  it('control: nothing moved stores the pair', async () => {
    await h.setSetting('card_text_mode', 'english');
    const { cardId } = await holder(h, 'active');
    const error = await run(
      handlersDuring(async () => {}),
      'house.translate-cards',
      {},
    );
    expect(error).toBeUndefined();
    expect(await filled(cardId)).not.toBeNull();
  });
});
