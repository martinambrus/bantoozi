import { randomUUID } from 'node:crypto';

import { systemClock } from '@bantoozi/shared';
import {
  createFeed,
  createSubscription,
  startFakeLibreTranslate,
  type FakeLibreTranslate,
} from '@bantoozi/testing';
import { createLibreTranslateClient, type LibreTranslateClient } from '@bantoozi/translate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T5 card text translation (spec 07 §5, spec 05 §5.1): under `card_text_mode = 'english'` the
 * API detects the card language and translates a non-English card with tier 1 (the fake
 * LibreTranslate server, no network) before its transaction, stores `lang` and the English pair in
 * the new card row, records each attempt through `record_card_translation`, and never lets a
 * translation authorize inference: only an active (or selected) feed receives backfill and
 * `house.translate-cards`; an off-feed user's edit triggers no unattended work.
 */

let h: ApiHarness;
let fake: FakeLibreTranslate;
let client: LibreTranslateClient;
let server: FastifyInstance;

const SLOVAK_INTEREST =
  'Nové chémie batérií pre elektrické autá, ich výroba a výskum na Slovensku a v Česku';
const SLOVAK_NOT_FOR = 'Pohyby cien akcií a reklamné správy o nových autách';

beforeAll(async () => {
  h = await createApiHarness();
  fake = await startFakeLibreTranslate();
  client = createLibreTranslateClient({ baseUrl: fake.url, clock: systemClock, backoffMs: 1 });
  server = await h.buildAnother({ libreTranslate: client });
});

afterAll(async () => {
  await client.close();
  await fake.close();
  await h.close();
});

async function setMode(mode: 'as_written' | 'english'): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('card_text_mode', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(mode)],
  );
}

async function storedCard(id: string) {
  const { rows } = await h.owner.query<{ lang: string; body: Record<string, unknown> }>(
    'SELECT lang, body FROM interest_cards WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

async function translationCalls(userId: string) {
  const { rows } = await h.owner.query<{
    engine: string;
    kind: string;
    status: string;
    free: boolean;
    error: string | null;
  }>(
    `SELECT engine, kind, status, (cost_usd = 0) AS free, error FROM engine_calls
      WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows;
}

async function drainOutbox(): Promise<void> {
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
}

async function queuesOf(userId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ queue: string }>(
    'SELECT queue FROM job_outbox WHERE user_id = $1 AND delivered_at IS NULL ORDER BY id',
    [userId],
  );
  return rows.map((row) => row.queue);
}

async function slovakReader(mode: 'off' | 'active'): Promise<TestUser> {
  const user = await createTestUser(h, { locale: 'sk' });
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode });
  return user;
}

let sequence = 0;
const variant = (text: string) => {
  sequence += 1;
  return `${text} ${sequence}`;
};

beforeEach(async () => {
  fake.reset();
  await setMode('english');
  await drainOutbox();
});

describe("card_text_mode = 'english'", () => {
  it('stores lang and the English pair of a Slovak card created on an active feed', async () => {
    const user = await slovakReader('active');
    const res = await apiClient(server, user).post('/cards', {
      interest: variant(SLOVAK_INTEREST),
      notFor: SLOVAK_NOT_FOR,
      strength: 'like',
    });
    expect(res.statusCode).toBe(201);
    const { card, translation } = res.json();
    expect(translation).toBe('translated');
    expect(card.lang).toBe('sk');
    // The user always sees what they wrote.
    expect(card.interest).toContain('Nové chémie batérií');
    const stored = await storedCard(card.id);
    expect(stored.lang).toBe('sk');
    expect(stored.body['interest']).toContain('Nové chémie batérií');
    expect(typeof stored.body['interest_en']).toBe('string');
    expect(typeof stored.body['not_for_en']).toBe('string');
    expect(fake.requests.filter((r) => r.path === '/translate')).toHaveLength(1);
    expect(await translationCalls(user.id)).toEqual([
      { engine: 'libretranslate', kind: 'translate', status: 'ok', free: true, error: null },
    ]);
    // Active demand: the card's backfill also schedules the user's card translations.
    expect(await queuesOf(user.id)).toEqual(
      expect.arrayContaining(['card.backfill', 'house.translate-cards', 'user.rank']),
    );
  });

  it('translates an explicit edit on an off feed without any unattended inference', async () => {
    const user = await slovakReader('off');
    const api = apiClient(server, user);
    const created = await api.post('/cards', {
      interest: variant('Hiking routes and trail conditions in the Tatra mountains'),
      strength: 'like',
    });
    expect(created.json().translation).toBe('english');
    expect(fake.requests).toHaveLength(0);
    await drainOutbox();

    const edited = await api.patch(`/cards/${created.json().card.id}`, {
      interest: variant(SLOVAK_INTEREST),
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().translation).toBe('translated');
    expect(edited.json().idChange).not.toBeNull();
    expect((await storedCard(edited.json().card.id)).body['interest_en']).toEqual(
      expect.any(String),
    );
    // Only the card text was sent; no backfill, no translate-cards, no analysis request.
    expect(fake.requests.filter((r) => r.path === '/translate')).toHaveLength(1);
    const queues = await queuesOf(user.id);
    expect(queues).not.toContain('card.backfill');
    expect(queues).not.toContain('house.translate-cards');
    expect(queues).not.toContain('analysis.process');
    const { rows } = await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM analysis_requests WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('keeps the original text with a non-blocking status when the translation fails', async () => {
    const user = await slovakReader('active');
    fake.setOptions({ mode: 'fail' });
    const res = await apiClient(server, user).post('/cards', {
      interest: variant(SLOVAK_INTEREST),
      strength: 'like',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().translation).toBe('failed');
    const stored = await storedCard(res.json().card.id);
    expect(stored.lang).toBe('sk');
    expect(stored.body['interest_en'] ?? null).toBeNull();
    const calls = await translationCalls(user.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.engine === 'libretranslate' && c.free)).toBe(true);

    fake.setOptions({ mode: 'weak' });
    const weak = await apiClient(server, user).post('/cards', {
      interest: variant(SLOVAK_INTEREST),
      strength: 'like',
    });
    expect(weak.json().translation).toBe('weak');
  });

  it('records failed attempts even when the mutation itself fails afterwards', async () => {
    const user = await slovakReader('active');
    fake.setOptions({ mode: 'status', status: 503 });
    const scope = await createFeed(h.owner); // not subscribed: the create is refused
    const res = await apiClient(server, user).post('/cards', {
      interest: variant(SLOVAK_INTEREST),
      strength: 'like',
      scopeFeedId: scope.id,
    });
    expect(res.statusCode).toBe(400);
    const calls = await translationCalls(user.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({ engine: 'libretranslate', error: 'http_5xx' });
  });

  it('sends nothing again for a replayed Idempotency-Key', async () => {
    const user = await slovakReader('active');
    const key = randomUUID();
    const body = { interest: variant(SLOVAK_INTEREST), strength: 'like' };
    const first = await apiClient(server, user).post('/cards', body, { idempotencyKey: key });
    const second = await apiClient(server, user).post('/cards', body, { idempotencyKey: key });
    expect(second.json()).toEqual(first.json());
    expect(fake.requests.filter((r) => r.path === '/translate')).toHaveLength(1);
  });

  it('translates a Slovak label definition', async () => {
    const user = await slovakReader('active');
    const res = await apiClient(server, user).post('/labels', {
      name: variant('Batérie'),
      definition: variant(SLOVAK_INTEREST),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().translation).toBe('translated');
    const stored = await storedCard(res.json().label.id);
    expect(stored.lang).toBe('sk');
    expect(stored.body['interest_en']).toEqual(expect.any(String));
  });
});

describe("card_text_mode = 'as_written'", () => {
  it('detects the language but sends nothing and stores no pair', async () => {
    await setMode('as_written');
    const user = await slovakReader('active');
    const res = await apiClient(server, user).post('/cards', {
      interest: variant(SLOVAK_INTEREST),
      strength: 'like',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().translation).toBeNull();
    const stored = await storedCard(res.json().card.id);
    expect(stored.lang).toBe('sk');
    expect(stored.body['interest_en'] ?? null).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(await queuesOf(user.id)).not.toContain('house.translate-cards');
  });
});
