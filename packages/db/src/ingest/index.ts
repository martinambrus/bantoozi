/**
 * Worker-side ingestion repositories (spec 03 §1.1, §7–§9; spec 05 §1.1, §5.3–§5.6): inference
 * demand, answer resets, the match queue, article bodies, item identity, merges, feed bookkeeping,
 * extraction results, bookmark capture and the origin limiter. They take a worker-role transaction
 * (BYPASSRLS) and record follow-on work through the caller's outbox sender; the next pipeline stage
 * is always decided by `apps/worker/src/pipeline.ts`.
 */
export * from './articles.js';
export * from './bodies.js';
export * from './bookmarks.js';
export * from './carriers.js';
export * from './clusters.js';
export * from './demand.js';
export * from './dev-cli.js';
export * from './extraction.js';
export * from './feeds.js';
export * from './match-queue.js';
export * from './merge-articles.js';
export * from './merge-feeds.js';
export * from './origin-limiter.js';
export * from './rank-intents.js';
export * from './reset.js';
export * from './retry.js';
