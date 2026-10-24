import { randomUUID } from 'node:crypto';

import * as db from '@bantoozi/db';
import { parseJobPayload, QUEUES } from '@bantoozi/shared';
import { startFakeOllama, type FakeOllamaServer } from '@bantoozi/testing';
import { createOllamaTranslator, type OllamaTranslator } from '@bantoozi/translate';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { dispatch } from '../src/handlers/index.js';
import {
  ClassifyHarness,
  ScriptedRouter,
  OLD_MODEL,
  NEW_MODEL,
  baseConfig,
  recorder,
  resetWorld,
  startRuntime,
  setSetting,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

let h: ClassifyHarness;
let ollama: FakeOllamaServer;
let translator: OllamaTranslator;
const runtimes: WorkerRuntimeLike[] = [];
beforeAll(async () => {
  h = await ClassifyHarness.start();
  ollama = await startFakeOllama({ apiKey: 'draft-test-key' });
  translator = createOllamaTranslator({ baseUrl: ollama.url });
}, 240_000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await translator?.close();
  await ollama?.close();
  await h?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetWorld(h);
  ollama.setOptions({
    reply: () =>
      JSON.stringify({ name: 'Space launches', interest: 'Rocket launches and crewed missions.' }),
  });
});

async function boot(model = OLD_MODEL) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', {
      typesafeModel: model,
      providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'libretranslate'],
    }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  return runtime;
}

function draftTranslation() {
  return {
    libretranslate: undefined as never,
    ollama: translator,
    credentials: createWorkerCredentialResolver({
      db: h.db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { ollama: 'draft-test-key' },
    }),
    modelFast: 'glm-5.3-flash',
    modelStrong: 'glm-5.3',
  };
}

it.each(['pin', 'restart'] as const)(
  'defers user.suggest before claiming a lease after a %s change',
  async (change) => {
    const old = await boot();
    const userId = await h.user();
    if (change === 'pin') await boot(NEW_MODEL);
    else await setSetting(h.owner, 'engine.ollama_max_concurrency', 2);
    await h.clearOutbox();
    const claim = vi.spyOn(db, 'claimSuggestLease');
    const router = new ScriptedRouter(h.db, old.processModel);
    await expect(
      dispatch(
        h.handlersWith({ classification: { ...old.models.classification, router } }),
        'user.suggest',
        { userId },
        { queue: 'user.suggest', jobId: 'suggest-last', retry: { count: 1, limit: 1 } },
      ),
    ).rejects.toMatchObject({ name: 'StaleWorkerError' });
    expect(claim).not.toHaveBeenCalled();
    expect(router.asks).toEqual([]);
    const replacements = await h.intents('user.suggest', { pending: true });
    expect(replacements).toHaveLength(1);
    const current = await boot(change === 'pin' ? NEW_MODEL : OLD_MODEL);
    await h.clearOutbox();
    await dispatch(
      h.handlersWith({ classification: current.models.classification }),
      'user.suggest',
      parseJobPayload('user.suggest', replacements[0]?.payload),
      { queue: 'user.suggest', jobId: 'suggest-current' },
    );
    expect(
      (
        await h.owner.query(
          'SELECT suggest_lease_token, last_suggested_at FROM users WHERE id = $1',
          [userId],
        )
      ).rows,
    ).toEqual([{ suggest_lease_token: null, last_suggested_at: null }]);
  },
);

it.each([
  ['engine.ollama_max_concurrency', 2],
  ['engine.ollama_base_url', 'https://ollama.com/v2'],
  ['engine.ollama_models', { fast: 'glm-5.3', strong: 'glm-5.3' }],
  ['translate.libretranslate_url', 'http://libretranslate:5001'],
] as const)('defers card.draft with pending work intact after %s changes', async (key, value) => {
  const old = await boot();
  const userId = await h.user();
  const articleId = await h.article({ feedIds: [] });
  const draftId = randomUUID();
  await h.owner.query(
    'INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, $3::bigint[], $4)',
    [draftId, userId, [articleId], 'en'],
  );
  await setSetting(h.owner, key, value);
  expect(await old.check()).toMatchObject({ pendingRestart: true });
  await h.clearOutbox();
  const router = new ScriptedRouter(h.db, old.processModel);
  await expect(
    dispatch(
      h.handlersWith({ classification: { ...old.models.classification, router } }),
      'card.draft',
      { draftId },
      { queue: 'card.draft', jobId: 'draft-last', retry: { count: 1, limit: 1 } },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  expect(
    (await h.owner.query('SELECT status FROM card_drafts WHERE id = $1', [draftId])).rows,
  ).toEqual([{ status: 'pending' }]);
  const replacements = await h.intents('card.draft', { pending: true });
  expect(replacements).toHaveLength(1);
  const current = await boot();
  await h.clearOutbox();
  await dispatch(
    h.handlersWith({ classification: current.models.classification }),
    'card.draft',
    parseJobPayload('card.draft', replacements[0]?.payload),
    { queue: 'card.draft', jobId: 'draft-current' },
  );
  expect(
    (await h.owner.query('SELECT status FROM card_drafts WHERE id = $1', [draftId])).rows,
  ).toEqual([{ status: 'complete' }]);
});

it('fences a pin move between the enrichment cache read and continuation', async () => {
  const old = await boot();
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.heldCard(userId, { topicIds: ['technology'] });
  const articleId = await h.article({ feedIds: [feedId] });
  await h.enrichDirect(articleId, { model: OLD_MODEL, state: 'extracted' });
  const read = db.readFacets;
  vi.spyOn(db, 'readFacets').mockImplementationOnce(async (...args) => {
    const row = await read(...args);
    await boot(NEW_MODEL);
    await h.clearOutbox();
    return row;
  });
  const router = new ScriptedRouter(h.db, OLD_MODEL);
  await expect(
    dispatch(
      h.handlersWith({ classification: { ...old.models.classification, router } }),
      'article.enrich',
      { articleId },
      { queue: 'article.enrich', jobId: 'cached-last', retry: { count: 1, limit: 1 } },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  expect(
    (await h.owner.query('SELECT pipeline_state FROM articles WHERE id = $1', [articleId])).rows,
  ).toEqual([{ pipeline_state: 'extracted' }]);
  expect(router.asks).toEqual([]);
  expect(await h.intents('article.enrich', { pending: true })).toHaveLength(1);
});

it('discards a card draft if the restart settings change after its work is read', async () => {
  const old = await boot();
  const userId = await h.user();
  const articleId = await h.article({ feedIds: [] });
  const draftId = randomUUID();
  await h.owner.query(
    'INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, $3::bigint[], $4)',
    [draftId, userId, [articleId], 'en'],
  );
  const read = db.heldCardTexts;
  vi.spyOn(db, 'heldCardTexts').mockImplementationOnce(async (...args) => {
    const cards = await read(...args);
    await setSetting(h.owner, 'engine.ollama_max_concurrency', 2);
    return cards;
  });
  await h.clearOutbox();
  await expect(
    dispatch(
      h.handlersWith({ classification: old.models.classification }),
      'card.draft',
      { draftId },
      { queue: 'card.draft', jobId: 'draft-race' },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  expect(
    (await h.owner.query('SELECT status FROM card_drafts WHERE id = $1', [draftId])).rows,
  ).toEqual([{ status: 'pending' }]);
  expect(await h.intents('card.draft', { pending: true })).toHaveLength(1);
});

it('releases the suggestion lease and defers if settings move before no-demand cleanup', async () => {
  const old = await boot();
  const userId = await h.user();
  const demand = db.hasSuggestDemand;
  vi.spyOn(db, 'hasSuggestDemand').mockImplementationOnce(async (...args) => {
    const found = await demand(...args);
    await setSetting(h.owner, 'engine.ollama_max_concurrency', 2);
    return found;
  });
  await h.clearOutbox();
  await expect(
    dispatch(
      h.handlersWith({ classification: old.models.classification }),
      'user.suggest',
      { userId },
      { queue: 'user.suggest', jobId: 'suggest-race' },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  expect(
    (
      await h.owner.query(
        'SELECT suggest_lease_token, last_suggested_at FROM users WHERE id = $1',
        [userId],
      )
    ).rows,
  ).toEqual([{ suggest_lease_token: null, last_suggested_at: null }]);
  expect(await h.intents('user.suggest', { pending: true })).toHaveLength(1);
});

it.each(['repair', 'completion'] as const)(
  'discards an LLM draft after its Ollama pin moves during the %s call',
  async (phase) => {
    const old = await boot();
    const userId = await h.user();
    const articleId = await h.article({ feedIds: [] });
    const draftId = randomUUID();
    await h.owner.query(
      'INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, $3::bigint[], $4)',
      [draftId, userId, [articleId], 'en'],
    );
    if (phase === 'repair') ollama.setOptions({ reply: () => 'invalid draft' });
    const call = translator.draftCardOnce.bind(translator);
    const sent = vi.spyOn(translator, 'draftCardOnce').mockImplementationOnce(async (input) => {
      const result = await call(input);
      expect(result.ok).toBe(phase === 'completion');
      await setSetting(h.owner, 'engine.ollama_models', {
        fast: 'glm-5.3',
        strong: 'glm-5.3',
      });
      await setSetting(h.owner, 'engine.model_pin', {
        model: OLD_MODEL,
        llm: { fast: 'glm-5.3', strong: 'glm-5.3' },
      });
      return result;
    });
    const router = new ScriptedRouter(h.db, old.processModel);
    await h.clearOutbox();
    await expect(
      dispatch(
        h.handlersWith({
          classification: {
            ...old.models.classification,
            router,
            translation: draftTranslation(),
          },
        }),
        'card.draft',
        { draftId },
        { queue: 'card.draft', jobId: `draft-${phase}`, retry: { count: 1, limit: 1 } },
      ),
    ).rejects.toMatchObject({ name: 'StaleWorkerError' });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(router.reservations).toHaveLength(1);
    expect(router.external).toHaveLength(1);
    expect(
      (
        await h.owner.query('SELECT status, source, completed_at FROM card_drafts WHERE id = $1', [
          draftId,
        ])
      ).rows,
    ).toEqual([{ status: 'pending', source: null, completed_at: null }]);
    expect(await h.intents('card.draft', { pending: true })).toHaveLength(1);
  },
);

it.each(['pin', 'engine.typesafe_base_url', 'engine.llm_fallback_enabled'] as const)(
  'completes card.draft immediately after a Jev-only %s change',
  async (change) => {
    const old = await boot();
    const userId = await h.user();
    const articleId = await h.article({ feedIds: [] });
    const draftId = randomUUID();
    await h.owner.query(
      'INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, $3::bigint[], $4)',
      [draftId, userId, [articleId], 'en'],
    );
    if (change === 'pin') await boot(NEW_MODEL);
    else
      await setSetting(
        h.owner,
        change,
        change === 'engine.llm_fallback_enabled' ? true : 'https://api.typesafe.ai/v2',
      );
    if (change !== 'pin') expect(await old.check()).toMatchObject({ pendingRestart: true });
    await h.clearOutbox();
    await dispatch(
      h.handlersWith({
        classification: {
          ...old.models.classification,
          router: new ScriptedRouter(h.db, old.processModel),
          translation: draftTranslation(),
        },
      }),
      'card.draft',
      { draftId },
      { queue: 'card.draft', jobId: 'draft-jev-only' },
    );
    expect(
      (await h.owner.query('SELECT status, source FROM card_drafts WHERE id = $1', [draftId])).rows,
    ).toEqual([{ status: 'complete', source: 'llm' }]);
    expect(await h.intents('card.draft', { pending: true })).toEqual([]);
  },
);

it('keeps the interactive card.draft retry immediate', () => {
  expect(QUEUES['card.draft'].options.retryDelay).toBeUndefined();
});
