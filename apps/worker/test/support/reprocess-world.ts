import { fillCardTranslation, loadCardInputs } from '@bantoozi/db';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  startFakeLibreTranslate,
  startFakeOllama,
  type FakeLibreTranslate,
  type FakeOllamaServer,
} from '@bantoozi/testing';
import { createLibreTranslateClient, createOllamaTranslator } from '@bantoozi/translate';

import { builtCardQuestion } from '../../src/classify/card-questions.js';
import { loadClassificationConfig } from '../../src/classify/config.js';
import type { TranslationDeps } from '../../src/classify/translation.js';
import { CredentialUnavailableError } from '../../src/credentials/resolver.js';

import { ClassifyHarness, DAY, LLM_MODEL, ago } from './classify.js';

/**
 * Fixtures of `house-reprocess.int.test.ts` (M8-T2 `house.reenrich` / `house.rematch`): the
 * classification harness with real translators against the fake LibreTranslate server (no Ollama
 * key, so tier 2 never runs), a clean-window reset, readers, cluster membership, a drain loop that
 * also runs continuation jobs, and snapshots of the work a job left behind. No live provider is
 * ever reached.
 */

export const OLD_MODEL = 'jev-old-0';
export const MODES_NATIVE = { en: 'native', sk: 'native', cs: 'native' } as const;
export const MODES_SK_TRANSLATE = { en: 'native', sk: 'translate', cs: 'native' } as const;

/** The queues a rebuild passes through, in the order a drain runs them. */
export const REBUILD_QUEUES = [
  'house.reenrich',
  'house.rematch',
  'article.translate',
  'article.enrich',
  'article.match',
] as const;

export interface ReprocessWorld {
  h: ClassifyHarness;
  lt: FakeLibreTranslate;
  ollama: FakeOllamaServer;
  close(): Promise<void>;
}

export async function startReprocessWorld(): Promise<ReprocessWorld> {
  const lt = await startFakeLibreTranslate();
  const ollama = await startFakeOllama({ apiKey: 'test-key' });
  const libretranslate = createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 });
  const translator = createOllamaTranslator({ baseUrl: ollama.url });
  // No Ollama key at all: tier 2 is skipped, tier 1 is the only translation.
  const credentials: CredentialResolver = {
    metadata: async () => ({ source: 'none', enabled: false }),
    useActive: async () => {
      throw new CredentialUnavailableError('ollama', 'none');
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
  };
  const h = await ClassifyHarness.start({ languageModes: { ...MODES_NATIVE }, translation });
  return {
    h,
    lt,
    ollama,
    close: async () => {
      await h.close();
      await libretranslate.close();
      await translator.close();
      await lt.close();
      await ollama.close();
    },
  };
}

/**
 * Every test starts from a clean window: earlier articles are stale, no queue rows, selections,
 * progress or breaker state; language modes native, card text as written, prefilter off.
 */
export async function resetWindow(w: ReprocessWorld): Promise<void> {
  const { h } = w;
  h.router.reset();
  await h.owner.query(
    `UPDATE articles SET pipeline_state = 'stale' WHERE pipeline_state <> 'stale'`,
  );
  await h.owner.query('DELETE FROM match_queue');
  await h.owner.query('DELETE FROM analysis_requests');
  await h.owner.query('DELETE FROM pgboss.job');
  for (const key of [
    'house.progress',
    'engine.circuit',
    'engine.prefilter_enabled',
    'card_text_mode',
  ]) {
    await h.deleteSetting(key);
  }
  await h.setSetting('language_modes', MODES_NATIVE);
  w.lt.reset({ mode: 'ok' });
  await h.clearOutbox();
}

/** A reader of a new feed in `mode` (active since 40 days), active in the app unless told otherwise. */
export async function reader(
  h: ClassifyHarness,
  mode: 'off' | 'training' | 'active' = 'active',
  options: { lastActiveAt?: Date; feedId?: string } = {},
): Promise<{ userId: string; feedId: string }> {
  const userId = await h.user();
  await h.owner.query('UPDATE users SET last_active_at = $2 WHERE id = $1', [
    userId,
    options.lastActiveAt ?? new Date(),
  ]);
  const feedId = options.feedId ?? (await h.feed());
  await h.subscribe(userId, feedId, mode, ago(40 * DAY));
  return { userId, feedId };
}

/** Put the article into a new story of its own (cluster membership under the active cluster set). */
export async function joinCluster(h: ClassifyHarness, articleId: string): Promise<string> {
  const story = await h.owner.query<{ id: string }>(
    `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, 1) RETURNING id::text AS id`,
    [articleId],
  );
  const id = story.rows[0]?.id ?? '';
  await h.owner.query(
    `UPDATE articles SET story_cluster_id = $2, cluster_set_id = $3 WHERE id = $1`,
    [articleId, id, h.sets.cluster],
  );
  return id;
}

/** A completed explicit selection (a result in place) of the user's request for the article. */
export async function selectComplete(
  h: ClassifyHarness,
  userId: string,
  feedId: string,
  articleId: string,
): Promise<string> {
  const { requestId } = await h.select(userId, feedId, articleId);
  await h.owner.query(
    `UPDATE analysis_requests
        SET status = 'complete', result_snapshot = '{}'::jsonb, result_sha = 'test',
            completed_at = now()
      WHERE id = $1`,
    [requestId],
  );
  await h.clearOutbox();
  return requestId;
}

/** Give the card its derived English pair (the one-time fill of `house.translate-cards`). */
export async function translateCard(
  h: ClassifyHarness,
  cardId: string,
  pair: { interestEn: string; notForEn?: string | null },
): Promise<void> {
  const result = await h.db.transaction((tx) =>
    fillCardTranslation(tx, {
      cardId,
      interestEn: pair.interestEn,
      notForEn: pair.notForEn ?? null,
    }),
  );
  if (result !== 'filled') throw new Error(`card ${cardId} was not filled: ${result}`);
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

/** The stored answers of an article with the fields that decide whether they are current. */
export async function storedAnswers(
  h: ClassifyHarness,
  articleId: string,
): Promise<
  Array<{
    cardId: string;
    engine: string;
    model: string | null;
    questionSetSha: string;
    cardInputSha: string;
  }>
> {
  const result = await h.owner.query<{
    card_id: string;
    engine: string;
    model: string | null;
    question_set_sha: string;
    card_input_sha256: string;
  }>(
    `SELECT card_id::text AS card_id, engine, model, question_set_sha, card_input_sha256
       FROM card_answers WHERE article_id = $1 ORDER BY card_answers.card_id`,
    [articleId],
  );
  return result.rows.map((row) => ({
    cardId: row.card_id,
    engine: row.engine,
    model: row.model,
    questionSetSha: row.question_set_sha,
    cardInputSha: row.card_input_sha256,
  }));
}

/** The active match set's sha, which a current answer carries. */
export async function matchSetSha(h: ClassifyHarness): Promise<string> {
  const config = await loadClassificationConfig(h.db, h.settingsEnv);
  return config.match?.sha256 ?? '';
}

/**
 * Run the rebuild queues until none has due work: continuation jobs of a long window are made due
 * at once (their delay only paces production).
 */
export async function drainRebuild(
  h: ClassifyHarness,
  queues: readonly (typeof REBUILD_QUEUES)[number][] = REBUILD_QUEUES,
): Promise<void> {
  for (let cycle = 0; cycle < 60; cycle += 1) {
    await h.owner.query(
      `UPDATE job_outbox SET available_at = now()
        WHERE delivered_at IS NULL AND queue IN ('house.reenrich', 'house.rematch')`,
    );
    let ran = 0;
    for (const queue of queues) ran += await h.run(queue);
    if (ran === 0) return;
  }
  throw new Error('the rebuild did not settle');
}

/** Pending (undelivered) intents of the queues, as comparable strings. */
export async function pendingWork(
  h: ClassifyHarness,
  queues: readonly string[],
  articleIds: readonly string[],
): Promise<string[]> {
  const result = await h.owner.query<{ queue: string; payload: Record<string, unknown> }>(
    `SELECT queue, payload FROM job_outbox
      WHERE delivered_at IS NULL AND queue = ANY($1::text[]) ORDER BY id`,
    [queues],
  );
  return result.rows
    .filter(
      (row) =>
        row.payload['articleId'] === undefined ||
        articleIds.includes(String(row.payload['articleId'])),
    )
    .map((row) => `${row.queue} ${JSON.stringify(row.payload)}`)
    .sort();
}

/** The match queue rows of the articles, as comparable strings. */
export async function queueState(
  h: ClassifyHarness,
  articleIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const articleId of articleIds) {
    for (const row of await h.queueRows(articleId)) {
      out.push(
        `${articleId}/${row.cardId} r${row.revision} p${row.priority} a${row.attempts} e${row.lastError ?? '-'}`,
      );
    }
  }
  return out.sort();
}

/**
 * Rewrite the answers to the earlier match set (the code defines only one, so a switch of the
 * active set is represented by what it leaves behind: answers stamped with another set's sha).
 */
export async function asEarlierMatchSet(
  h: ClassifyHarness,
  articleId: string,
  cardId?: string,
): Promise<void> {
  await h.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', 'match-v0-earlier', 'earlier-match-set', '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  await h.owner.query(
    `UPDATE card_answers SET question_set_sha = 'earlier-match-set'
      WHERE article_id = $1 AND ($2::bigint IS NULL OR card_id = $2::bigint)`,
    [articleId, cardId ?? null],
  );
}
