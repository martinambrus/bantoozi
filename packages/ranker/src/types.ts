import type { Strength } from '@bantoozi/shared';

/**
 * Ranker inputs (spec 06 §1). The rank handler (M5) loads and validates them; the functions of this
 * package are pure and treat a missing or invalid value as unknown, never as zero (§2).
 */

/** Strengths that add positive evidence to the card score (§4.1); `never` is an anti-interest. */
export type PositiveStrength = Exclude<Strength, 'never'>;

/**
 * Engine of a stored card answer (spec 02 `card_answers.engine`). A `prefilter` row is a
 * provisional unknown marker (spec 05 §5.5), not a measured zero.
 */
export type AnswerEngine = 'typesafe' | 'llm' | 'laya' | 'prefilter';

/** An engine that measures answers. */
export type ModelEngine = Exclude<AnswerEngine, 'prefilter'>;

/** One current card answer (`item.cardAnswers[cardId]`). */
export interface CardAnswer {
  p: number;
  engine: AnswerEngine;
}

/**
 * The current answers of the user's interest and label cards for one article, keyed by card id.
 * The handler has already discarded answers for another content revision, state/question manifest
 * or inactive card (§2).
 */
export type CardAnswers = Readonly<Record<string, CardAnswer>>;

/** One of the user's held interest cards (`UserRankContext.cards`). */
export interface RankCard {
  /** Bigint card id as a decimal string. */
  cardId: string;
  /** The holder's display title. */
  title: string;
  strength: Strength;
  /** A scoped card applies only to items this feed carries with authorization (§2). */
  scopeFeedId?: string | undefined;
  /** The card text as written; also the BM25 query (§9). */
  interest: string;
  /** The English translation of `interest`, when `card_text_mode` produced one (spec 05 §5.1). */
  interestEn?: string | undefined;
  /**
   * `interest_cards.lang`: the language `interest` is written in. BM25 uses it to pair a card
   * written in English with a translated (English) document (§9). Absent means unknown.
   */
  lang?: string | undefined;
}

/** This reader's coverage of their applicable positive cards (§2, spec 05 §5.5). */
export type MatchCoverage = 'complete' | 'pending' | 'unavailable';

/** Tier 1–5 derived from P (§6.1). */
export type Tier = 1 | 2 | 3 | 4 | 5;

/** One article as the rank handler presents it to the ranker (`RankItem`, §1). */
export interface RankItem {
  articleId: string;
  /** All carriers of the article ∩ the user's subscriptions (manual rules). */
  feedIds: readonly string[];
  /** Only the carriers authorized for this user and article revision (§2, spec 05 §1.1). */
  inferenceFeedIds: readonly string[];
  /** `inferenceFeedIds` is non-empty; says nothing about global cache availability. */
  inferenceEligible: boolean;
  /** A current selected analysis request authorizes this revision (spec 05 §1.1). */
  explicitSelection: boolean;
  domain: string;
  author: string | null;
  titleNorm: string;
  excerptNorm: string;
  /** The selected translation (always English, spec 07), when one exists. */
  translatedTitleNorm?: string | undefined;
  translatedExcerptNorm?: string | undefined;
  firstSeenAt: Date;
  publishedAt?: Date | undefined;
  contentRevision: string;
  wordCount: number | null;
  hasImage: boolean;
  /** Detected article language (`articles.lang`). */
  lang: string;
  /** `articles.has_video` / `body_image_count` / `media_revision` (spec 03 §6.4). */
  hasVideo: boolean | null;
  bodyImageCount: number | null;
  mediaRevision: string;
  clusterId?: string | undefined;
  clusterSize: number;
  pipelineState: string;
  /** This user's coverage of their applicable positive cards (see `matchCoverage`). */
  matchCoverage: MatchCoverage;
  /** `article_facets.features` (spec 05 §3.4). */
  facets?: Readonly<Record<string, number>> | undefined;
  /** `articles.enrich_engine`. */
  facetsEngine?: ModelEngine | undefined;
  /** The user's interest and label card answers. */
  cardAnswers: CardAnswers;
  /** Labels already assigned (`user_article.label_ids`). */
  labelIds: readonly string[];
  translation?: { engine: string; quality: string } | undefined;
}
