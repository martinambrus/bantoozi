import type {
  AnalysisCaptureContext,
  CardInput,
  ClassificationArticle,
  TranslationRow,
} from '@bantoozi/db';
import {
  AnalysisInputSnapshotSchema,
  type AnalysisInputSnapshot,
  type AnalysisTranslation,
  type JsonObject,
} from '@bantoozi/shared';

import { builtCardQuestion } from './card-questions.js';
import { languageModeOf, requireSet, type ClassificationConfig } from './config.js';
import { feedSite, usableTranslation } from './model-input.js';

/**
 * Capture a selected request's immutable pre-feedback input (spec 05 §1.1, spec 03 §2.2): the
 * model-state source fields of the article at its current revision with the canonical feed's shared
 * metadata, the language mode and the usable translation in effect (else `null`: in translate mode
 * the request translates the frozen source itself), the active enrich/match sets, the card text
 * mode, the pinned Jev model, the feature context and every held card or label that applies to the
 * request's feed, each built exactly under that card text mode. Never a rating. The training API
 * stores the result as `input_snapshot` (spec 08); tests build requests the same way.
 */
export function captureAnalysisSnapshot(input: {
  article: ClassificationArticle;
  /** `article_translations` rows of the article's current revision. */
  translations: readonly TranslationRow[];
  context: AnalysisCaptureContext;
  /** Card rows of `context.cards` (a held card without a row is left out). */
  cards: ReadonlyMap<string, CardInput>;
  config: ClassificationConfig;
  primaryModel: string;
  capturedAt: Date;
}): AnalysisInputSnapshot {
  const { article, context, config } = input;
  const enrich = requireSet(config.enrich, 'enrich');
  const match = requireSet(config.match, 'match');
  const languageMode = languageModeOf(config, article.lang);
  const best =
    languageMode === 'translate' ? usableTranslation(input.translations, article.revision) : null;
  const cards = context.cards.flatMap((held) => {
    const card = input.cards.get(held.cardId);
    if (card === undefined) return [];
    const built = builtCardQuestion(card, config.cardTextMode);
    return [
      {
        cardId: held.cardId,
        kind: held.kind,
        strength: held.kind === 'label' ? null : held.strength,
        question: built.question as unknown as JsonObject,
        cardInputSha256: built.sha256,
      },
    ];
  });
  return AnalysisInputSnapshotSchema.parse({
    v: 1,
    capturedAt: input.capturedAt.toISOString(),
    article: {
      id: article.id,
      revision: article.revision,
      title: article.title,
      author: article.author,
      categories: article.categories,
      excerpt: article.excerpt,
      bodyLead: article.bodyLead,
      wordCount: article.wordCount,
      lang: article.lang,
      feed: { title: article.feed?.title ?? null, site: feedSite(article.feed) },
      firstSeenAt: context.firstSeenAt.toISOString(),
      publishedAt: context.publishedAt?.toISOString() ?? null,
      hasImage: context.hasImage,
      hasVideo: context.hasVideo,
      bodyImageCount: context.bodyImageCount,
      storyClusterId: context.storyClusterId,
      clusterSize: context.clusterSize,
    },
    languageMode,
    translation: best === null ? null : frozenTranslation(best),
    questionSets: {
      enrich: { id: enrich.id, version: enrich.version, sha256: enrich.sha256 },
      match: { id: match.id, version: match.version, sha256: match.sha256 },
    },
    cardTextMode: config.cardTextMode,
    model: { engine: 'typesafe', model: input.primaryModel },
    cards,
  });
}

/** A usable translation row as a frozen snapshot translation. */
export function frozenTranslation(row: TranslationRow): AnalysisTranslation {
  if (row.quality === 'fail' || row.title === null) {
    throw new TypeError('only a usable translation row can be frozen');
  }
  return {
    engine: row.engine,
    model: row.model,
    sourceLang: row.sourceLang,
    sourceSha256: row.sourceSha256,
    quality: row.quality,
    title: row.title,
    excerpt: row.excerpt,
    bodyLead: row.bodyLead,
  };
}
