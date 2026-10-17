/**
 * The card and label lifecycle repository (spec 05 §5.1, §5.3, §8; spec 08 §7): immutable card rows
 * reused by `text_hash`, private forks for examples, per-holder names, labels with `array_replace`,
 * opt-in library updates and the worker's one-time English pair fill. The API calls the
 * `TenantTx` functions; each returns its effects after running `refresh_feed_cards` and recording
 * the backfill, rank and learn intents in the same transaction.
 */
export type { LibraryCardDiff } from './body.js';
export {
  CARD_DRAFT_CONTEXT_CARDS,
  CARD_DRAFT_DEMAND_MINUTES,
  CARD_DRAFT_TTL_HOURS,
  cardDraftAuthorized,
  createCardDraft,
  finishCardDraft,
  getCardDraft,
  heldCardTexts,
  loadCardDraftArticles,
  loadCardDraftWork,
  type CardDraftArticle,
  type CardDraftKind,
  type CardDraftSource,
  type CardDraftStatus,
  type CardDraftView,
  type CardDraftWork,
  type HeldCardText,
} from './drafts.js';
export {
  addCardExample,
  adoptLibraryCard,
  createCardFromArticle,
  createUserCard,
  deleteUserCard,
  deleteUserCardForReplacement,
  editCardText,
  removeCardExample,
  renameCard,
  setCardScope,
  setCardStrength,
  updateUserCard,
  type AdoptLibraryCardInput,
  type CreateCardFromArticleInput,
  type CreateUserCardInput,
  type UpdateUserCardInput,
} from './interest-cards.js';
export { listCardUsage, type CardUsage } from './usage.js';
export {
  addLabelExample,
  createUserLabel,
  deleteUserLabel,
  removeLabelExample,
  setLabelColor,
  updateUserLabel,
  type CreateUserLabelInput,
  type UpdateUserLabelInput,
} from './labels.js';
export {
  applyLibraryUpdate,
  listLibraryUpdates,
  type ApplyLibraryUpdateInput,
  type LibraryUpdateOffer,
} from './library-updates.js';
export {
  fillCardTranslation,
  markCardTranslationAttempt,
  type CardTranslationFill,
  type CardTranslationFillInput,
} from './translations.js';
export {
  cardsAwaitingTranslation,
  recordCardTranslationDemand,
  type CardAwaitingTranslation,
} from './translation-demand.js';
export type * from './types.js';
export {
  CARD_LANG_PATTERN,
  CARD_STRENGTHS,
  CARD_TEXT_LIMITS,
  EXAMPLE_SIDES,
  LABEL_COLOR_PATTERN,
  type CardStrength,
  type CardTranslationPair,
  type ExampleSide,
} from './validation.js';
export { getUserCard, getUserLabel, listUserCards, listUserLabels } from './views.js';
