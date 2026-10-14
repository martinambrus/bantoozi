import { randomUUID } from 'node:crypto';

import type { CredentialResolver } from '@bantoozi/shared/server';
import { startFakeOllama, type FakeOllamaServer } from '@bantoozi/testing';
import { createOllamaTranslator, type OllamaTranslator } from '@bantoozi/translate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TranslationDeps } from '../src/classify/translation.js';
import { CredentialUnavailableError } from '../src/credentials/resolver.js';
import { fallbackDraft } from '../src/handlers/card-draft.js';
import { ClassifyHarness, LLM_MODEL } from './support/classify.js';

/**
 * `card.draft {draftId}` (D-240): the fast GLM model drafts a card's name and interest from the
 * draft's articles in the person's language, through the router's reservation and accounting; the
 * fallback (main topic and first title) answers when the key, the spend or the output fails.
 */

const DRAFT = {
  name: 'Space launches',
  interest: 'Rocket launches, landings and crewed missions.',
};

let h: ClassifyHarness;
let ollama: FakeOllamaServer;
let translator: OllamaTranslator;
const key: { available: boolean } = { available: true };
let reply: () => string = () => JSON.stringify(DRAFT);

beforeAll(async () => {
  ollama = await startFakeOllama({ apiKey: 'test-key', reply: () => reply() });
  translator = createOllamaTranslator({ baseUrl: ollama.url });
  const credentials: CredentialResolver = {
    metadata: async () => ({ source: 'db', enabled: true, activeVersion: '3' }),
    useActive: async (_provider, _signal, send) => {
      if (!key.available) throw new CredentialUnavailableError('ollama', 'none');
      return send({ apiKey: 'test-key', source: 'db', credentialVersion: '3' });
    },
    useCandidate: async () => {
      throw new Error('candidate keys are not used here');
    },
  };
  const translation: TranslationDeps = {
    libretranslate: undefined as never,
    ollama: translator,
    credentials,
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
  };
  h = await ClassifyHarness.start({ translation });
});

afterAll(async () => {
  await h.close();
  await translator.close();
  await ollama.close();
});

beforeEach(() => {
  h.router.reset();
  key.available = true;
  reply = () => JSON.stringify(DRAFT);
});

async function draftOf(articleIds: string[], locale = 'en') {
  const userId = await h.user();
  const id = randomUUID();
  await h.owner.query(
    `INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, $3::bigint[], $4)`,
    [id, userId, articleIds, locale],
  );
  return { id, userId };
}

async function runDraft(draftId: string): Promise<void> {
  const entry = h.handlers['card.draft'];
  if (entry.status !== 'implemented') throw new Error('card.draft is not implemented');
  await entry.handle({ draftId }, { queue: 'card.draft', jobId: '1' });
}

async function row(id: string) {
  const result = await h.owner.query<{
    status: string;
    title: string | null;
    interest: string | null;
    source: string | null;
    completed_at: Date | null;
  }>(`SELECT status, title, interest, source, completed_at FROM card_drafts WHERE id = $1`, [id]);
  return result.rows[0];
}

async function articles(...titles: string[]): Promise<string[]> {
  const feed = await h.feed();
  const ids: string[] = [];
  for (const title of titles) ids.push(await h.article({ feedIds: [feed], title }));
  return ids;
}

describe('card.draft', () => {
  it('writes the LLM’s draft in the person’s language under a card_draft reservation', async () => {
    const ids = await articles('SpaceX lands a booster again', 'NASA picks a Moon landing site');
    const { id, userId } = await draftOf(ids, 'sk');
    const before = ollama.requestCount();

    await runDraft(id);

    expect(await row(id)).toMatchObject({
      status: 'complete',
      title: DRAFT.name,
      interest: DRAFT.interest,
      source: 'llm',
      completed_at: expect.any(Date),
    });
    expect(ollama.requestCount() - before).toBe(1);
    const sent = ollama.requests.at(-1)?.body as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).toContain('in Slovak');
    expect(sent.messages[1]?.content).toContain('SpaceX lands a booster again');
    expect(h.router.reservations.map((r) => r.input)).toEqual([
      expect.objectContaining({
        engine: 'llm',
        kind: 'card_draft',
        priority: 'interactive',
        userId,
        authorization: { type: 'card_draft', userId, draftId: id },
      }),
    ]);
    expect(h.router.external.map((e) => e.call)).toEqual([
      expect.objectContaining({ engine: 'llm', kind: 'card_draft', status: 'ok' }),
    ]);

    // An answered draft is left alone.
    await runDraft(id);
    expect(ollama.requestCount() - before).toBe(1);
  });

  it('repairs invalid output once, then falls back to the first title', async () => {
    const [first] = await articles('Quantum chips get a new error-correction record');
    const { id } = await draftOf([first!]);
    reply = () => 'Here is your card: quantum computing';

    await runDraft(id);

    expect(await row(id)).toMatchObject({
      status: 'complete',
      title: null,
      interest: 'Quantum chips get a new error-correction record',
      source: 'fallback',
    });
    expect(h.router.external.map((e) => e.call.status)).toEqual([
      'invalid_response',
      'invalid_response',
    ]);
  });

  it('falls back without any call when there is no Ollama key', async () => {
    const [first] = await articles('A new indie game studio opens in Košice');
    const { id } = await draftOf([first!]);
    key.available = false;
    const before = ollama.requestCount();

    await runDraft(id);

    expect(await row(id)).toMatchObject({ status: 'complete', source: 'fallback' });
    expect(ollama.requestCount()).toBe(before);
    expect(h.router.reservations).toEqual([]);
  });
});

describe('fallbackDraft', () => {
  const article = (title: string, facets: Record<string, unknown> | null) => ({
    id: '1',
    title,
    excerpt: null,
    lang: 'en',
    facets,
  });

  it('names the level-2 topic the articles lean to most, in the person’s language', () => {
    const a = article('Falcon 9 flies again', { 't2.science.space': 0.9, 't2.technology.ai': 0.2 });
    const b = article('Moon base plans', { 't2.science.space': 0.6, 't2.technology.ai': 0.5 });
    const en = fallbackDraft([a, b], 'en');
    expect(en?.interest).toBe('Falcon 9 flies again');
    expect(en?.title).not.toBeNull();
    expect(fallbackDraft([a, b], 'sk')?.title).not.toBe(en?.title);
  });

  it('has no name without topics, and nothing without a usable title', () => {
    expect(fallbackDraft([article('Moon base plans', null)], 'en')).toEqual({
      title: null,
      interest: 'Moon base plans',
    });
    expect(fallbackDraft([article('Hi', null)], 'en')).toBeNull();
    expect(fallbackDraft([], 'en')).toBeNull();
  });
});
