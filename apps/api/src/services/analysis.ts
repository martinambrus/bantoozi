import {
  listTranslations,
  loadActiveQuestionSets,
  loadAnalysisCaptureContext,
  loadCardInputs,
  loadClassificationArticle,
  readStoredSetting,
  tenantUserId,
  type MatchFingerprint,
  type RatingDefaults,
  type TenantTx,
} from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import {
  buildAnalysisInputSnapshot,
  builtCardQuestion,
  enrichStateSha256,
  isCodeQuestionSet,
  matchStateSha256,
} from '@bantoozi/questions';
import {
  AppError,
  readSetting,
  type AnalysisInputSnapshot,
  type AnalysisSetRef,
  type CardTextMode,
  type LanguageModes,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import { selectBestTranslation } from '@bantoozi/translate';

import type { ApiConfig } from '../context.js';

/**
 * Frozen inputs of selected-article analysis requests (spec 05 §1.1, spec 08 §4.1): the API side of
 * the shared snapshot builder (`buildAnalysisInputSnapshot` in `@bantoozi/questions`, D-71). The
 * training endpoints (`POST /subscriptions/:feedId/analyze`, and the rating-triggered training of
 * M4-T7) capture a request's input in its creating transaction with these helpers.
 */

/** The classification configuration a capture freezes (read once per request transaction). */
export interface SnapshotConfig {
  questionSets: { enrich: AnalysisSetRef; match: AnalysisSetRef };
  languageModes: LanguageModes;
  cardTextMode: CardTextMode;
  /** The Jev model the worker answers with: `settings['engine.model_pin'].model`. */
  primaryModel: string;
}

function settingEnv(config: ApiConfig): SettingEnvDefaults {
  return {
    dailyBudgetUsd: config.dailyBudgetUsd,
    languageModes: config.languageModes,
    signupMode: config.signupMode,
  };
}

const notConfigured = () =>
  new AppError('CONFLICT', 'Article analysis is not available until classification is configured');

/**
 * Read the active enrich/match sets (verified against this build's definitions, spec 05 §2), the
 * card text mode, the language modes and the pinned Jev model. The model pin is the one workers
 * record when they start (`settings['engine.model_pin']`, spec 05 §2); before any worker recorded
 * it, `TYPESAFE_MODEL` (default `jev-1.13.0`) stands in. Without active sets nothing can be frozen
 * (`409 CONFLICT`).
 */
export async function loadSnapshotConfig(tx: TenantTx, config: ApiConfig): Promise<SnapshotConfig> {
  const env = settingEnv(config);
  const sets = await loadActiveQuestionSets(tx);
  const ref = (kind: 'enrich' | 'match'): AnalysisSetRef => {
    const row = sets[kind];
    if (row === undefined || !isCodeQuestionSet(kind, row)) throw notConfigured();
    return { id: row.id, version: row.version, sha256: row.sha256 };
  };
  const pin = readSetting('engine.model_pin', await readStoredSetting(tx, 'engine.model_pin'), env);
  return {
    questionSets: { enrich: ref('enrich'), match: ref('match') },
    languageModes:
      readSetting('language_modes', await readStoredSetting(tx, 'language_modes'), env) ?? {},
    cardTextMode:
      readSetting('card_text_mode', await readStoredSetting(tx, 'card_text_mode'), env) ??
      'as_written',
    primaryModel: pin?.model ?? config.typesafeModel,
  };
}

/**
 * Capture the immutable pre-feedback input of one selected article (spec 05 §1.1): the article at
 * its current revision, the request feed's arrival and context, the user's held cards and labels
 * that apply to the feed, built exactly under `config`. The caller has validated that the owned
 * feed carries the article at the selected revision under its locks.
 */
export async function captureSelectionSnapshot(
  tx: TenantTx,
  input: { feedId: string; articleId: string; config: SnapshotConfig; capturedAt: Date },
): Promise<AnalysisInputSnapshot> {
  const article = await loadClassificationArticle(tx, input.articleId);
  const context = await loadAnalysisCaptureContext(tx, {
    userId: tenantUserId(tx),
    feedId: input.feedId,
    articleId: input.articleId,
  });
  if (article === null || context === null) {
    throw new AppError('NOT_FOUND', 'Article not found');
  }
  const cards = await loadCardInputs(
    tx,
    context.cards.map((card) => card.cardId),
  );
  const translations = await listTranslations(tx, article.id, article.revision);
  const feed = article.feed;
  const snapshot = buildAnalysisInputSnapshot({
    article,
    feed: {
      title: feed?.title ?? null,
      site: feed === null ? null : (registrableDomain(feed.siteUrl) ?? registrableDomain(feed.url)),
    },
    context,
    bestTranslation: selectBestTranslation(translations, article.revision),
    cards,
    questionSets: input.config.questionSets,
    languageModes: input.config.languageModes,
    cardTextMode: input.config.cardTextMode,
    primaryModel: input.config.primaryModel,
    capturedAt: input.capturedAt,
  });
  // An article not yet extracted is analysed on its extracted text: the worker waits for it.
  return article.pipelineState === 'ingested'
    ? { ...snapshot, awaitingExtraction: true }
    : snapshot;
}

/**
 * The environment defaults of the fingerprint settings (spec 06 §8.1): the model an unset pin
 * stands for and the language and card text modes of a missing setting.
 */
export function ratingDefaultsFor(config: ApiConfig): RatingDefaults {
  return {
    model: config.typesafeModel,
    languageModes: config.languageModes,
    cardTextMode: 'as_written',
  };
}

/**
 * The current match input of an article for a feature snapshot (spec 06 §8.2): the `state_sha256`
 * of its match and enrich states and the per-card `card_input_sha256` the ranker compares stored
 * answers and facets with, built under the language modes and card text mode of the snapshot's one
 * locked settings read. Null when the article is gone.
 */
export function matchFingerprintFor(config: ApiConfig): MatchFingerprint {
  const env = settingEnv(config);
  const current = async (tx: TenantTx, input: Parameters<MatchFingerprint>[1]) => {
    const article = await loadClassificationArticle(tx, input.articleId);
    if (article === null) return null;
    const languageModes =
      readSetting('language_modes', input.settings.get('language_modes'), env) ?? {};
    const cardTextMode =
      readSetting('card_text_mode', input.settings.get('card_text_mode'), env) ?? 'as_written';
    const translations = await listTranslations(tx, article.id, article.revision);
    const feed = article.feed;
    const base = {
      title: article.title,
      author: article.author,
      categories: article.categories,
      excerpt: article.excerpt,
      bodyLead: article.bodyLead,
      wordCount: article.wordCount,
      lang: article.lang,
      feed: {
        title: feed?.title ?? null,
        site:
          feed === null ? null : (registrableDomain(feed.siteUrl) ?? registrableDomain(feed.url)),
      },
    };
    const best = selectBestTranslation(translations, article.revision);
    const cards = await loadCardInputs(tx, input.cardIds);
    const cardInputSha256 = new Map<string, string>();
    for (const [id, card] of cards)
      cardInputSha256.set(id, builtCardQuestion(card, cardTextMode).sha256);
    return {
      stateSha256: matchStateSha256(base, languageModes, best),
      enrichStateSha256: enrichStateSha256(base, languageModes, best),
      cardInputSha256,
    };
  };
  return Object.assign(current, { defaults: ratingDefaultsFor(config) });
}
