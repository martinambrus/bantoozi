/**
 * `@bantoozi/ranker` — pure ranking functions (spec 06): every function takes plain inputs and
 * returns plain outputs; the `user.rank` handler does the I/O and `apps/eval` runs the same code.
 *
 * The M2 bootstrap (M2-T10) provides the card score, never-card and must-floor evaluation,
 * reader-specific match coverage, lanes and tiers, the lane policy preview, BM25, the view-scoped
 * inference projection and the score-version key. M5 adds `rankArticle` (rules, demotions,
 * explanations, label suggestions) and M7 the personal model.
 */
export const PACKAGE_NAME = '@bantoozi/ranker';

export * from './bm25/index.js';
export * from './cards.js';
export * from './config.js';
export * from './coverage.js';
export * from './lanes.js';
export * from './policy.js';
export * from './projection.js';
export * from './rule-codes.js';
export * from './types.js';
export * from './version.js';
