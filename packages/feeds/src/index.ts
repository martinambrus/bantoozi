/**
 * `@bantoozi/feeds` — the SSRF-safe HTTP client, URL canonicalization, feed parsing, adaptive
 * scheduling, article extraction, discovery and OPML (spec 03). Pure logic plus the safe client;
 * database wiring lives in `apps/worker` and `packages/db`.
 */
export const PACKAGE_NAME = '@bantoozi/feeds';

export * from './canonical/index.js';
export * from './http/index.js';
export * from './parse/index.js';
export * from './schedule/index.js';
