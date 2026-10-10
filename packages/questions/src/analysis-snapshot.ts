import {
  AnalysisInputSnapshotSchema,
  type AnalysisInputSnapshot,
  type AnalysisSetRef,
  type AnalysisTranslation,
  type CardTextMode,
  type JsonObject,
  type LanguageModes,
} from '@bantoozi/shared';

import { cardInputSha256, cardQuestion, labelQuestion, type CardBody } from './cards.js';
import { questionSetByVersion } from './sets/index.js';
import {
  buildArticleState,
  effectiveStateVariant,
  stateSha256,
  type ArticleStateInput,
} from './state.js';
import type { NoulQuestion } from './types.js';

/**
 * The frozen input of a selected-article analysis request (spec 05 §1.1, spec 03 §2.2, D-71): one
 * pure builder that the training API (which creates requests) and the worker (its tests and the
 * request checks) share. Callers load the rows; everything that decides what is frozen lives here.
 * The two values that need other packages are passed in already computed: the canonical feed's
 * registrable site (`registrableDomain`, `@bantoozi/feeds`) and the best current-revision
 * translation row (`selectBestTranslation`, `@bantoozi/translate`).
 */

/** Call B card questions and their cache identity (spec 05 §2, §5.2). */
export interface BuiltCardQuestion {
  question: NoulQuestion;
  /** `card_input_sha256`: the hash of the exact built question. */
  sha256: string;
}

/** What a card or label question is built from: the shared card row. */
export interface CardQuestionSource {
  kind: 'interest' | 'label';
  /** The shared card's title: part of a label's semantic text (never `user_labels.name`). */
  title: string;
  body: CardBody;
}

/**
 * The exact built question of a card or label under the card text mode. A label is asked with its
 * shared card title (part of its text hash), never `user_labels.name`.
 */
export function builtCardQuestion(card: CardQuestionSource, mode: CardTextMode): BuiltCardQuestion {
  const question =
    card.kind === 'label'
      ? labelQuestion({ title: card.title, body: card.body }, mode)
      : cardQuestion(card.body, mode);
  return { question, sha256: cardInputSha256(question) };
}

/** An `article_translations` row as far as a frozen snapshot reads it (spec 07 §3). */
export interface SnapshotTranslationRow {
  engine: 'libretranslate' | 'ollama';
  model: string | null;
  sourceLang: string;
  sourceSha256: string;
  quality: 'ok' | 'weak' | 'fail';
  title: string | null;
  excerpt: string | null;
  bodyLead: string | null;
}

/**
 * The best current-revision row when it can carry the translated variant (it has a translated
 * title, spec 05 §3.1); null means native text. `best` is `selectBestTranslation`'s choice.
 */
export function usableTranslationRow<R extends SnapshotTranslationRow>(best: R | null): R | null {
  if (best === null) return null;
  const texts = { title: best.title, excerpt: best.excerpt, bodyLead: best.bodyLead };
  return effectiveStateVariant('translated', texts) === 'translated' ? best : null;
}

/** A usable translation row as a frozen snapshot translation. */
export function frozenTranslation(row: SnapshotTranslationRow): AnalysisTranslation {
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

/** The language mode of an article language; an unknown language is native (spec 05 §3.1). */
export function languageModeFor(
  languageModes: Readonly<LanguageModes>,
  lang: string | null,
): 'native' | 'translate' {
  if (lang === null || lang === 'und') return 'native';
  return languageModes[lang] ?? 'native';
}

/**
 * Whether a stored active question set is the code's definition of its version (spec 05 §2): the
 * version is known to this build, of the same kind and with the same sha. Anything else is a
 * deploy/seed mismatch and must not be asked or frozen.
 */
export function isCodeQuestionSet(kind: string, row: { version: string; sha256: string }): boolean {
  const code = questionSetByVersion(row.version);
  return code !== undefined && code.kind === kind && code.sha256 === row.sha256;
}

/** A held card or label of the requesting user that applies to the request's feed. */
export interface SnapshotHeldCard {
  cardId: string;
  kind: 'interest' | 'label';
  /** The holder's strength; null for a label. */
  strength: 'must' | 'love' | 'like' | 'never' | null;
}

export interface AnalysisSnapshotInput {
  /** The model-state source fields of the article at its current revision. */
  article: {
    id: string;
    revision: string;
    title: string;
    author: string | null;
    categories: readonly string[];
    excerpt: string | null;
    bodyLead: string | null;
    wordCount: number | null;
    lang: string | null;
  };
  /** The canonical feed's shared metadata: its title and registrable site (spec 05 §3.1). */
  feed: { title: string | null; site: string | null };
  /** The request feed's arrival, source timestamps, media and story-group context (spec 06 §8.1). */
  context: {
    firstSeenAt: Date;
    publishedAt: Date | null;
    hasImage: boolean;
    hasVideo: boolean | null;
    bodyImageCount: number | null;
    storyClusterId: string | null;
    clusterSize: number;
    cards: readonly SnapshotHeldCard[];
  };
  /** `selectBestTranslation` over the current-revision rows; read only in translate mode. */
  bestTranslation: SnapshotTranslationRow | null;
  /** Card rows of `context.cards` (a held card without a row is left out). */
  cards: ReadonlyMap<string, CardQuestionSource>;
  questionSets: { enrich: AnalysisSetRef; match: AnalysisSetRef };
  languageModes: Readonly<LanguageModes>;
  cardTextMode: CardTextMode;
  /** The pinned Jev model the answers must come from. */
  primaryModel: string;
  capturedAt: Date;
}

/**
 * Capture a selected request's immutable pre-feedback input (spec 05 §1.1, spec 03 §2.2): the
 * model-state source fields of the article at its current revision with the canonical feed's shared
 * metadata, the language mode and the usable translation in effect (else `null`: in translate mode
 * the request translates the frozen source itself), the active enrich/match sets, the card text
 * mode, the pinned Jev model, the feature context and every held card or label that applies to the
 * request's feed, each built exactly under that card text mode. Never a rating. The training API
 * stores the result as `input_snapshot` (spec 08 §4.1); the worker answers exactly it.
 */
export function buildAnalysisInputSnapshot(input: AnalysisSnapshotInput): AnalysisInputSnapshot {
  const { article, context } = input;
  const languageMode = languageModeFor(input.languageModes, article.lang);
  const best = languageMode === 'translate' ? usableTranslationRow(input.bestTranslation) : null;
  const cards = context.cards.flatMap((held) => {
    const card = input.cards.get(held.cardId);
    if (card === undefined) return [];
    const built = builtCardQuestion(card, input.cardTextMode);
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
      feed: { title: input.feed.title, site: input.feed.site },
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
      enrich: { ...input.questionSets.enrich },
      match: { ...input.questionSets.match },
    },
    cardTextMode: input.cardTextMode,
    model: { engine: 'typesafe', model: input.primaryModel },
    cards,
  });
}

/**
 * The `state_sha256` of an article's Call B (match) state at its current revision: native text, or
 * the usable best translation when the language is in `translate` mode (spec 05 §3.1). `base` is
 * the native state input; `bestTranslation` is `selectBestTranslation`'s choice.
 */
export function matchStateSha256(
  base: Omit<ArticleStateInput, 'translation'>,
  languageModes: Readonly<LanguageModes>,
  bestTranslation: SnapshotTranslationRow | null,
): string {
  return callStateSha256('match', base, languageModes, bestTranslation);
}

/** The `state_sha256` of an article's Call A (enrich) state: `matchStateSha256` for the other call. */
export function enrichStateSha256(
  base: Omit<ArticleStateInput, 'translation'>,
  languageModes: Readonly<LanguageModes>,
  bestTranslation: SnapshotTranslationRow | null,
): string {
  return callStateSha256('enrich', base, languageModes, bestTranslation);
}

function callStateSha256(
  call: 'enrich' | 'match',
  base: Omit<ArticleStateInput, 'translation'>,
  languageModes: Readonly<LanguageModes>,
  bestTranslation: SnapshotTranslationRow | null,
): string {
  const best =
    languageModeFor(languageModes, base.lang) === 'translate'
      ? usableTranslationRow(bestTranslation)
      : null;
  const input: ArticleStateInput =
    best === null
      ? base
      : {
          ...base,
          translation: { title: best.title, excerpt: best.excerpt, bodyLead: best.bodyLead },
        };
  return stateSha256(buildArticleState(input, best === null ? 'native' : 'translated', { call }));
}
