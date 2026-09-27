import type { CardStrength } from './validation.js';

export type CardKind = 'interest' | 'label';
export type CardOrigin = 'library' | 'user' | 'fork';
export type CardVisibility = 'public' | 'shared' | 'private';

/** A holding moved to another immutable card (spec 08 §7 `idChange`). */
export interface CardIdChange {
  from: string;
  to: string;
}

/**
 * What a lifecycle function did beyond its rows (spec 05 §5.1). The repository has already run
 * `refresh_feed_cards(refreshFeedIds)` and written the matching `card.backfill`, `user.rank
 * {full: true}` (with the `rank_revision` increment) and `user.learn` intents to `job_outbox` in the
 * caller's transaction; the object reports them for the API response and tests.
 */
export interface CardEffects {
  /** Feeds whose `feed_cards` rows were recomputed (numeric order). */
  refreshFeedIds: string[];
  /** The admitted-demand backfill recorded (spec 05 §1.1, §5.4); absent when none was needed. */
  backfill?: { cardIds: string[]; feedIds?: string[] };
  rankFull: boolean;
  /** True for interest-card changes; labels never train the interest model (spec 06 §8.4). */
  learn: boolean;
  /** A label holding moved to another card; `label_ids`/`label_suggestions` were migrated. */
  labelIdChange?: CardIdChange;
}

/** One of the user's interest cards (spec 08 §7 `Card`). */
export interface HeldCard {
  id: string;
  kind: 'interest';
  /** The display title: the holder's `title_override`, else the card's default title. */
  title: string;
  titleOverride: string | null;
  /** `interest_cards.title`: the default (shared) name of the card. */
  cardTitle: string;
  interest: string;
  notFor: string | null;
  interestEn: string | null;
  notForEn: string | null;
  strength: CardStrength;
  scopeFeedId: string | null;
  origin: CardOrigin;
  visibility: CardVisibility;
  isPrivateFork: boolean;
  /** For a private fork: the original shared/library card it was made from. */
  parentCardId: string | null;
  examplesYes: string[];
  examplesNo: string[];
  topicIds: string[];
  lang: string;
  /** The library discovery slug while this card is the current library version. */
  librarySlug: string | null;
  /** Localized library metadata (e.g. `{sk: {title}}`), `{}` for user cards. */
  i18n: Record<string, unknown>;
  /** When the user started holding this card (kept across re-points). */
  createdAt: Date;
  updatedAt: Date;
}

/** One of the user's labels (spec 08 §7 `Label`); `id` is the label card id. */
export interface HeldLabel {
  id: string;
  /** `user_labels.name`: display only, never sent to the model. */
  name: string;
  color: string;
  /** The label card's title: part of its hashed meaning (spec 05 §5.1). */
  cardTitle: string;
  definition: string;
  notFor: string | null;
  definitionEn: string | null;
  notForEn: string | null;
  examplesYes: string[];
  examplesNo: string[];
  origin: CardOrigin;
  visibility: CardVisibility;
  isPrivateFork: boolean;
  lang: string;
  /** Articles this user labelled with it. */
  count: number;
  createdAt: Date;
}

/** Result of a card lifecycle action that leaves the user holding a card. */
export interface CardMutation {
  card: HeldCard;
  /** Set when the holding moved to another card id (forks, edits, library updates). */
  idChange: CardIdChange | null;
  /** A new holding was inserted (create/adopt/from-article); false for an idempotent replay. */
  created: boolean;
  effects: CardEffects;
}

/** Result of a label lifecycle action that leaves the user holding a label. */
export interface LabelMutation {
  label: HeldLabel;
  idChange: CardIdChange | null;
  created: boolean;
  effects: CardEffects;
}

/** Result of removing a card or label from the user. */
export interface CardRemoval {
  effects: CardEffects;
}
