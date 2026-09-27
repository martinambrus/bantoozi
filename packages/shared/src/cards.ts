/**
 * Card text limits in code points (spec 05 §5.1), shared by the question builders and the card
 * repository, since `packages/db` cannot import `packages/questions` (spec 01 §2). The web client
 * and the API use the same numbers.
 */
export const CARD_LIMITS = {
  titleMin: 1,
  titleMax: 60,
  interestMin: 3,
  interestMax: 300,
  notForMax: 300,
  examplesPerSide: 5,
  exampleMax: 200,
  /** Sanity bound of a derived translation (`interest_en`, `not_for_en`): twice the original's. */
  translatedMax: 600,
} as const;
