import { canonicalSha256 } from '@bantoozi/shared/server';

import { stateLanguageName } from './languages.js';
import { boundedText } from './text.js';

/**
 * The article state of Call A and Call B (spec 05 §3.1): shared publisher metadata and text only,
 * never a subscriber's feed-title override, folder, identity or rating. The caller picks the
 * canonical feed (oldest `feed_items.first_seen_at`, then feed id), computes `feed.site` (the
 * registrable domain) and, for the translated variant, the best translation row. Every field is
 * bounded, so the state size is bounded too; the concrete state is hashed with {@link stateSha256}.
 */

export type StateVariant = 'native' | 'translated';

/** Call A (`enrich`) sends a longer body lead than Call B (`match`). */
export type StateCall = 'enrich' | 'match';

export type ArticleLength = 'short' | 'medium' | 'long' | 'very_long' | 'unknown';

/** Field bounds in code points (spec 05 §3.1 fixes excerpt and body lead; the rest bound the size). */
export const STATE_LIMITS = {
  title: 300,
  author: 120,
  category: 60,
  maxCategories: 8,
  feedTitle: 120,
  feedSite: 100,
  excerpt: 600,
  bodyLead: { enrich: 1500, match: 1000 },
} as const;

/** The translated title, excerpt and body lead of the best translation row (spec 07 §3). */
export interface ArticleStateTranslation {
  title: string | null;
  excerpt: string | null;
  bodyLead: string | null;
}

export interface ArticleStateInput {
  title: string;
  author: string | null;
  categories: readonly string[];
  excerpt: string | null;
  bodyLead: string | null;
  wordCount: number | null;
  /** `articles.lang` (ISO 639-1; `und`/null when unknown). */
  lang: string | null;
  /** The canonical feed's shared metadata; `site` is its registrable domain. */
  feed: { title: string | null; site: string | null };
  /** Required for the translated variant. */
  translation?: ArticleStateTranslation | null | undefined;
}

/** The native state. Type aliases (not interfaces) keep states assignable to `JsonValue`. */
export type NativeArticleState = {
  article: {
    title: string;
    feed: { title: string | null; site: string | null };
    author: string | null;
    categories: string[];
    excerpt: string | null;
    body_lead: string | null;
    length: ArticleLength;
    language: string;
  };
};

/** The translated state: translated text, the original title and "<Language> (machine-translated to English)". */
export type TranslatedArticleState = {
  article: {
    title: string;
    original_title: string;
    feed: { title: string | null; site: string | null };
    author: string | null;
    categories: string[];
    excerpt: string | null;
    body_lead: string | null;
    length: ArticleLength;
    language: string;
  };
};

export type ArticleState = NativeArticleState | TranslatedArticleState;

/** `word_count` bucket: <150 short, <600 medium, <1,500 long, ≥1,500 very long, null unknown. */
export function lengthBucket(wordCount: number | null): ArticleLength {
  if (wordCount === null || !Number.isFinite(wordCount) || wordCount < 0) return 'unknown';
  if (wordCount < 150) return 'short';
  if (wordCount < 600) return 'medium';
  if (wordCount < 1500) return 'long';
  return 'very_long';
}

function boundedCategories(categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const category of categories) {
    const value = boundedText(category, STATE_LIMITS.category);
    if (value === null) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
    if (kept.length === STATE_LIMITS.maxCategories) break;
  }
  return kept;
}

/**
 * Whether a translation can carry the translated variant: it needs a translated title. A caller
 * whose language mode is `translate` but has no usable translation falls back to `native` (§3.1)
 * and stores the variant it actually used.
 */
export function effectiveStateVariant(
  requested: StateVariant,
  translation: ArticleStateTranslation | null | undefined,
): StateVariant {
  if (requested === 'native') return 'native';
  return translation !== null &&
    translation !== undefined &&
    boundedText(translation.title, STATE_LIMITS.title) !== null
    ? 'translated'
    : 'native';
}

/**
 * The §3.1 state for one call. `translated` requires `input.translation` with a title (use
 * {@link effectiveStateVariant} first); it replaces title, excerpt and body lead with the
 * translation and adds `original_title`.
 */
export function buildArticleState(
  input: ArticleStateInput,
  variant: StateVariant,
  opts: { call: StateCall },
): ArticleState {
  const bodyLeadLimit = STATE_LIMITS.bodyLead[opts.call];
  const originalTitle = boundedText(input.title, STATE_LIMITS.title) ?? '';
  const common = {
    feed: {
      title: boundedText(input.feed.title, STATE_LIMITS.feedTitle),
      site: boundedText(input.feed.site, STATE_LIMITS.feedSite),
    },
    author: boundedText(input.author, STATE_LIMITS.author),
    categories: boundedCategories(input.categories),
  };
  const tail = { length: lengthBucket(input.wordCount) };
  const language = stateLanguageName(input.lang);

  if (variant === 'native') {
    const article: NativeArticleState['article'] = {
      title: originalTitle,
      ...common,
      excerpt: boundedText(input.excerpt, STATE_LIMITS.excerpt),
      body_lead: boundedText(input.bodyLead, bodyLeadLimit),
      ...tail,
      language,
    };
    return { article };
  }

  const translation = input.translation;
  const title =
    translation === null || translation === undefined
      ? null
      : boundedText(translation.title, STATE_LIMITS.title);
  if (translation === null || translation === undefined || title === null) {
    throw new TypeError('the translated state needs a translation with a title');
  }
  return {
    article: {
      title,
      original_title: originalTitle,
      ...common,
      excerpt: boundedText(translation.excerpt, STATE_LIMITS.excerpt),
      body_lead: boundedText(translation.bodyLead, bodyLeadLimit),
      ...tail,
      language: `${language} (machine-translated to English)`,
    },
  };
}

/** `state_sha256`: SHA-256 of the canonical JSON of the exact state sent (spec 05 §2). */
export function stateSha256(state: unknown): string {
  return canonicalSha256(state);
}

/** A liked article in the suggest state (spec 05 §7 step 4). */
export interface SuggestStateArticle {
  title: string;
  excerpt: string | null;
}

/** Excerpt bound of the cluster and suggest states (spec 05 §6 step 3, §7 step 4). */
export const SHORT_EXCERPT_CHARS = 300;

/** Liked articles in the suggest state (spec 05 §7 step 4). */
export const SUGGEST_MAX_ARTICLES = 5;

export type SuggestState = {
  liked_articles: { title: string; excerpt: string | null }[];
};

/**
 * The suggest state `{ liked_articles: [≤ 5 × {title, excerpt ≤ 300}] }` (spec 05 §7 step 4): the
 * articles in the given order (the caller passes the most recent first), at most five.
 */
export function buildSuggestState(articles: readonly SuggestStateArticle[]): SuggestState {
  return {
    liked_articles: articles.slice(0, SUGGEST_MAX_ARTICLES).map((article) => ({
      title: boundedText(article.title, STATE_LIMITS.title) ?? '',
      excerpt: boundedText(article.excerpt, SHORT_EXCERPT_CHARS),
    })),
  };
}
