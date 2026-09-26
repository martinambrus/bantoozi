import type { ClassificationArticle, TranslationRow } from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import {
  buildArticleState,
  effectiveStateVariant,
  stateSha256,
  type ArticleState,
  type ArticleStateInput,
  type StateCall,
  type StateVariant,
} from '@bantoozi/questions';
import { selectBestTranslation, type TranslationTexts } from '@bantoozi/translate';

import { languageModeOf, type ClassificationConfig } from './config.js';

/**
 * The model input of an article at its current revision (spec 05 §3.1): the canonical feed's shared
 * metadata, the body lead stored at this revision and, when its language is in `translate` mode, the
 * best current translation row (spec 07 §3 step 4). Without a usable translation the state falls
 * back to native text; the variant actually used is stored with every answer.
 */
export interface ModelInput {
  input: ArticleStateInput;
  variant: StateVariant;
  /** The translation row the translated variant uses; null for native text. */
  translation: TranslationRow | null;
}

/** The registrable domain of the canonical feed's site (its feed URL when it has none). */
export function feedSite(feed: ClassificationArticle['feed']): string | null {
  if (feed === null) return null;
  return registrableDomain(feed.siteUrl) ?? registrableDomain(feed.url);
}

export function modelInput(
  article: ClassificationArticle,
  translations: readonly TranslationRow[],
  config: ClassificationConfig,
): ModelInput {
  const base: ArticleStateInput = {
    title: article.title,
    author: article.author,
    categories: article.categories,
    excerpt: article.excerpt,
    bodyLead: article.bodyLead,
    wordCount: article.wordCount,
    lang: article.lang,
    feed: { title: article.feed?.title ?? null, site: feedSite(article.feed) },
  };
  if (languageModeOf(config, article.lang) !== 'translate') {
    return { input: base, variant: 'native', translation: null };
  }
  const best = usableTranslation(translations, article.revision);
  return best === null
    ? { input: base, variant: 'native', translation: null }
    : {
        input: {
          ...base,
          translation: { title: best.title, excerpt: best.excerpt, bodyLead: best.bodyLead },
        },
        variant: 'translated',
        translation: best,
      };
}

/**
 * The best current-revision row (spec 07 §3 step 4) when it can carry the translated variant (it
 * has a translated title, spec 05 §3.1); null means native text.
 */
export function usableTranslation(
  translations: readonly TranslationRow[],
  revision: string,
): TranslationRow | null {
  const best = selectBestTranslation(translations, revision);
  if (best === null) return null;
  const texts = { title: best.title, excerpt: best.excerpt, bodyLead: best.bodyLead };
  return effectiveStateVariant('translated', texts) === 'translated' ? best : null;
}

/** The effective translated text a state is built from, in the translate package's field names. */
export function effectiveTranslationTexts(
  translations: readonly TranslationRow[],
  revision: string,
): TranslationTexts | null {
  const best = usableTranslation(translations, revision);
  return best === null
    ? null
    : { title: best.title, excerpt: best.excerpt, body_lead: best.bodyLead };
}

/** One built state and its hash (the `state_sha256` of every answer it produces). */
export interface BuiltState {
  state: ArticleState;
  sha256: string;
  variant: StateVariant;
}

export function buildState(input: ModelInput, call: StateCall): BuiltState {
  const state = buildArticleState(input.input, input.variant, { call });
  return { state, sha256: stateSha256(state), variant: input.variant };
}
