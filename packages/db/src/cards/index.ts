/**
 * The card and label lifecycle repository (spec 05 §5.1, §5.3, §8; spec 08 §7): immutable card rows
 * reused by `text_hash`, private forks for examples, per-holder names, labels with `array_replace`,
 * opt-in library updates and the worker's one-time English pair fill. The API calls the
 * `TenantTx` functions; each returns its effects after running `refresh_feed_cards` and recording
 * the backfill, rank and learn intents in the same transaction.
 */
export type { LibraryCardDiff } from './body.js';
export {
  addCardExample,
  adoptLibraryCard,
  createCardFromArticle,
  createUserCard,
  deleteUserCard,
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
  type CardTranslationFill,
  type CardTranslationFillInput,
} from './translations.js';
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
