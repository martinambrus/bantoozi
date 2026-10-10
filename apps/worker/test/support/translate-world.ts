import { loadCardInputs } from '@bantoozi/db';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  createCard,
  pseudoTranslate,
  startFakeLibreTranslate,
  startFakeOllama,
  type FakeLibreTranslate,
  type FakeOllamaServer,
} from '@bantoozi/testing';
import { createLibreTranslateClient, createOllamaTranslator } from '@bantoozi/translate';

import { builtCardQuestion } from '../../src/classify/card-questions.js';
import type { TranslationDeps } from '../../src/classify/translation.js';
import { CredentialUnavailableError } from '../../src/credentials/resolver.js';

import { ClassifyHarness, DAY, HOUR, LLM_MODEL, ago, forArticles } from './classify.js';

/**
 * Fixtures of `house-translate.int.test.ts` (M8-T2 `house.translate-cards` and
 * `house.retranslate-skipped`): the classification harness with real translators against the fake
 * LibreTranslate and Ollama servers (a controllable Ollama key), Slovak articles whose tier-2 row
 * is skipped for a given reason through the real `article.translate` handler, and cards that lack
 * their English pair. No live provider is ever reached.
 */

export const MODES_SK_TRANSLATE = { en: 'native', sk: 'translate', cs: 'native' } as const;

export const SLOVAK_ARTICLE = {
  title: 'Nové električky v Bratislave jazdia od pondelka',
  excerpt: 'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky.',
  bodyLead:
    'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky. Dopravný podnik ' +
    'ich nasadil najskôr na linku, ktorá vedie cez Starý most, pretože tam je najviac cestujúcich.',
};

export const SLOVAK_INTEREST =
  'Nové chémie batérií pre elektrické autá, ich výroba a výskum na Slovensku a v Česku';
export const SLOVAK_NOT_FOR = 'Pohyby cien akcií a reklamné správy o nových autách';
export const CZECH_INTEREST =
  'Nové železniční spoje mezi Prahou a Brnem, jejich jízdní řády a ceny jízdenek pro cestující';

export type CredentialMetadata = Awaited<ReturnType<CredentialResolver['metadata']>>;
export type SkipReason = 'no_key' | 'cap' | 'budget';

/** A tier-2 reply: the pseudo-translation of every field of the JSON the translator sent. */
function translatedReply(body: unknown): string {
  const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
  const source = JSON.parse(messages.at(-1)?.content ?? '{}') as Record<string, string>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(source).map(([field, text]) => [
        field,
        text === '' ? '' : pseudoTranslate(text),
      ]),
    ),
  );
}

export interface TranslateWorld {
  h: ClassifyHarness;
  lt: FakeLibreTranslate;
  ollama: FakeOllamaServer;
  /** The Ollama credential a fresh read sees; tests replace `current`. */
  credential: { current: CredentialMetadata };
  /** Tier-2 HTTP requests received since the last reset. */
  ollamaCalls(): number;
  /** Tier-1 `/translate` requests received since the last reset. */
  ltCalls(): number;
  close(): Promise<void>;
}

const ENABLED_KEY: CredentialMetadata = { source: 'db', enabled: true, activeVersion: '3' };

export async function startTranslateWorld(): Promise<TranslateWorld> {
  const lt = await startFakeLibreTranslate();
  const ollama = await startFakeOllama({ apiKey: 'test-key', reply: translatedReply });
  const libretranslate = createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 });
  const translator = createOllamaTranslator({ baseUrl: ollama.url });
  const credential = { current: ENABLED_KEY };
  const credentials: CredentialResolver = {
    metadata: async () => credential.current,
    useActive: async (_provider, _signal, send) => {
      const current = credential.current;
      if (current.source === 'none') throw new CredentialUnavailableError('ollama', 'none');
      if (!current.enabled) throw new CredentialUnavailableError('ollama', 'disabled');
      if (current.source === 'env') return send({ apiKey: 'test-key', source: 'env' });
      return send({
        apiKey: 'test-key',
        source: 'db',
        credentialVersion: current.activeVersion ?? '3',
      });
    },
    useCandidate: async () => {
      throw new Error('candidate keys are not used here');
    },
  };
  const translation: TranslationDeps = {
    libretranslate,
    ollama: translator,
    credentials,
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
    // What the fake server installs for `→ en` besides English itself.
    supportedSources: async () => new Set(['sk', 'cs']),
  };
  const h = await ClassifyHarness.start({ languageModes: { ...MODES_SK_TRANSLATE }, translation });
  let ollamaBase = 0;
  const world: TranslateWorld = {
    h,
    lt,
    ollama,
    credential,
    ollamaCalls: () => ollama.requestCount() - ollamaBase,
    ltCalls: () => lt.requests.filter((request) => request.path === '/translate').length,
    close: async () => {
      await h.close();
      await libretranslate.close();
      await translator.close();
      await lt.close();
      await ollama.close();
    },
  };
  resetBases.set(world, () => {
    ollamaBase = ollama.requestCount();
  });
  return world;
}

const resetBases = new WeakMap<TranslateWorld, () => void>();

/**
 * Every test starts from a clean world: earlier articles are stale, nobody holds a card, no queue
 * rows, selections, progress or breaker state; sk is `translate`, card text as written, the tier-2
 * cap at its default, a working Ollama key, healthy providers.
 */
export async function resetTranslateWorld(w: TranslateWorld): Promise<void> {
  const { h } = w;
  h.router.reset();
  w.lt.reset({ mode: 'ok' });
  w.ollama.setOptions({
    mode: 'ok',
    reply: translatedReply,
    status: undefined,
    headers: undefined,
    statusOverride: undefined,
  });
  w.ollama.requests.length = 0;
  resetBases.get(w)?.();
  w.credential.current = ENABLED_KEY;
  await h.owner.query(
    `UPDATE articles SET pipeline_state = 'stale' WHERE pipeline_state <> 'stale'`,
  );
  await h.owner.query('DELETE FROM match_queue');
  await h.owner.query('DELETE FROM analysis_requests');
  await h.owner.query('DELETE FROM pgboss.job');
  await h.owner.query('DELETE FROM user_cards');
  await h.owner.query('DELETE FROM user_labels');
  for (const key of [
    'house.progress',
    'engine.circuit',
    'engine.prefilter_enabled',
    'card_text_mode',
    'translate.tier2_daily_cap',
  ]) {
    await h.deleteSetting(key);
  }
  await h.setSetting('language_modes', MODES_SK_TRANSLATE);
  await h.clearOutbox();
}

// ── Cards ─────────────────────────────────────────────────────────────────────────────────────

let sequence = 0;
/** A text no other card of the run shares (a card is reused by its text hash). */
export const unique = (text: string): string => `${text} ${(sequence += 1)}`;

export interface HeldCard {
  userId: string;
  feedId: string;
  cardId: string;
}

/**
 * A card in `lang` that lacks its English pair, held by a new reader whose subscription of a new
 * feed is in `mode` (active since 40 days, active in the app).
 */
export async function holder(
  h: ClassifyHarness,
  mode: 'off' | 'training' | 'active',
  card: {
    lang?: string;
    interest?: string;
    notFor?: string | null;
    kind?: 'interest' | 'label';
  } = {},
): Promise<HeldCard> {
  const userId = await h.user();
  await h.owner.query('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]);
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, mode, ago(40 * DAY));
  const cardId = await untranslatedCard(h, userId, card);
  return { userId, feedId, cardId };
}

/** Another card for the user (not scoped to a feed). */
export async function untranslatedCard(
  h: ClassifyHarness,
  userId: string,
  card: {
    lang?: string;
    interest?: string;
    notFor?: string | null;
    kind?: 'interest' | 'label';
    scopeFeedId?: string;
  } = {},
): Promise<string> {
  const kind = card.kind ?? 'interest';
  const created = await createCard(h.owner, {
    kind,
    visibility: 'shared',
    lang: card.lang ?? 'sk',
    interest: unique(card.interest ?? SLOVAK_INTEREST),
    notFor: card.notFor === undefined ? SLOVAK_NOT_FOR : card.notFor,
    ...(kind === 'label' ? { title: unique('Označenie') } : {}),
  });
  if (kind === 'label') {
    await h.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)`, [
      userId,
      created.id,
      `label ${created.id}`,
    ]);
  } else {
    await h.hold(
      userId,
      created.id,
      card.scopeFeedId === undefined ? {} : { scopeFeedId: card.scopeFeedId },
    );
  }
  return created.id;
}

export interface StoredCard {
  lang: string;
  interest: string;
  notFor: string | null;
  interestEn: string | null;
  notForEn: string | null;
  textHash: string;
}

export async function storedCard(h: ClassifyHarness, cardId: string): Promise<StoredCard> {
  const result = await h.owner.query<{
    lang: string;
    body: Record<string, unknown>;
    text_hash: string;
  }>('SELECT lang, body, text_hash FROM interest_cards WHERE id = $1', [cardId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`card ${cardId} is gone`);
  const text = (key: string): string | null =>
    typeof row.body[key] === 'string' ? (row.body[key] as string) : null;
  return {
    lang: row.lang,
    interest: text('interest') ?? '',
    notFor: text('not_for'),
    interestEn: text('interest_en'),
    notForEn: text('not_for_en'),
    textHash: row.text_hash,
  };
}

/** The card's built-question digest under `mode` (what a current answer must carry). */
export async function cardDigest(
  h: ClassifyHarness,
  cardId: string,
  mode: 'as_written' | 'english',
): Promise<string> {
  const card = (await loadCardInputs(h.db, [cardId])).get(cardId);
  if (card === undefined) throw new Error(`card ${cardId} is gone`);
  return builtCardQuestion(card, mode).sha256;
}

/**
 * An English article of the feed, enriched and matched, with a current answer of the card under the
 * card text in effect now: the pair the card's new digest makes incompatible.
 */
export async function answeredArticle(
  h: ClassifyHarness,
  feedId: string,
  cardId: string,
  options: { firstSeenAt?: Date } = {},
): Promise<string> {
  const articleId = await h.article({
    feedIds: [feedId],
    lang: 'en',
    title: unique('A current article'),
    firstSeenAt: options.firstSeenAt ?? ago(HOUR),
  });
  await h.enrichDirect(articleId, { state: 'matched' });
  await h.answerCard(articleId, cardId, { engine: 'typesafe' });
  return articleId;
}

/**
 * Whether the pair is queued for matching once `house.rematch` intents recorded so far have run:
 * either the job queued it itself or it recorded a rematch for the card.
 */
export async function pairRematched(
  h: ClassifyHarness,
  articleId: string,
  cardId: string,
): Promise<boolean> {
  await h.run('house.rematch');
  return (await h.queueRows(articleId)).some((row) => row.cardId === cardId);
}

// ── Skipped tier-2 translations ───────────────────────────────────────────────────────────────

export async function translationRows(h: ClassifyHarness, articleId: string) {
  const result = await h.owner.query<{
    engine: string;
    model: string | null;
    quality: string;
    revision: string;
    title: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT t.engine, t.model, t.quality, t.article_revision::text AS revision, t.title,
            t.quality_detail AS detail
       FROM article_translations t
       JOIN articles a ON a.id = t.article_id AND a.content_revision = t.article_revision
      WHERE t.article_id = $1 ORDER BY t.engine`,
    [articleId],
  );
  return result.rows;
}

/** A Slovak article of `feedId` (carried an hour ago unless told otherwise), not yet translated. */
export async function slovakArticle(
  h: ClassifyHarness,
  feedId: string,
  firstSeenAt: Date = ago(HOUR),
): Promise<string> {
  return h.article({
    feedIds: [feedId],
    lang: 'sk',
    firstSeenAt,
    ...SLOVAK_ARTICLE,
    title: unique(SLOVAK_ARTICLE.title),
  });
}

/**
 * Translate the Slovak article through the real handler while tier 1 fails and tier 2 is wanted
 * but not allowed for `reason`, so its current-revision `ollama` row is `skipped: reason`; then
 * enrich it from the native text and restore the providers, the key and the budget.
 */
export async function skippedArticle(
  w: TranslateWorld,
  articleId: string,
  reason: SkipReason,
): Promise<void> {
  const { h } = w;
  w.lt.setOptions({ mode: 'fail' });
  if (reason === 'no_key') w.credential.current = { source: 'none', enabled: false };
  // A refused reservation is a cap skip unless the budget cannot spend either (runTier2).
  if (reason === 'cap' || reason === 'budget') h.router.reservation = () => null;
  if (reason === 'budget') h.router.spendable = false;
  await h.dispatch('article.translate', { articleId });
  w.lt.setOptions({ mode: 'ok' });
  w.credential.current = ENABLED_KEY;
  h.router.reset();
  const rows = await translationRows(h, articleId);
  const ollamaRow = rows.find((row) => row.engine === 'ollama');
  if (ollamaRow?.detail['skipped'] !== reason) {
    throw new Error(`article ${articleId} was not skipped for ${reason}`);
  }
  await h.run('article.enrich', forArticles(articleId));
  await h.clearOutbox();
}
