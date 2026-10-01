import type {
  AnalysisCaptureContext,
  CardInput,
  ClassificationArticle,
  TranslationRow,
} from '@bantoozi/db';
import { buildAnalysisInputSnapshot } from '@bantoozi/questions';
import type { AnalysisInputSnapshot } from '@bantoozi/shared';
import { selectBestTranslation } from '@bantoozi/translate';

import { requireSet, type ClassificationConfig } from './config.js';
import { feedSite } from './model-input.js';

/** The pure snapshot helpers live in `@bantoozi/questions`, shared with the training API (D-71). */
export { frozenTranslation } from '@bantoozi/questions';

/**
 * Capture a selected request's immutable pre-feedback input (spec 05 §1.1, spec 03 §2.2) from the
 * worker's loaded rows and classification configuration. The decisions are made by
 * `buildAnalysisInputSnapshot` (`@bantoozi/questions`), the one implementation the training API
 * uses as well (D-71); this adapter only supplies the canonical feed's registrable site and the best
 * current-revision translation. Tests build requests the same way.
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
  const { article, config } = input;
  const enrich = requireSet(config.enrich, 'enrich');
  const match = requireSet(config.match, 'match');
  return buildAnalysisInputSnapshot({
    article,
    feed: { title: article.feed?.title ?? null, site: feedSite(article.feed) },
    context: input.context,
    bestTranslation: selectBestTranslation(input.translations, article.revision),
    cards: input.cards,
    questionSets: {
      enrich: { id: enrich.id, version: enrich.version, sha256: enrich.sha256 },
      match: { id: match.id, version: match.version, sha256: match.sha256 },
    },
    languageModes: config.languageModes,
    cardTextMode: config.cardTextMode,
    primaryModel: input.primaryModel,
    capturedAt: input.capturedAt,
  });
}
