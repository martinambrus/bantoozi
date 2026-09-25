/**
 * `@bantoozi/shared` — isomorphic entry (safe for the web bundle). Node-only modules (config,
 * logger, mailer, hashing, language detection) live in `@bantoozi/shared/server`; credential
 * cryptography lives in `@bantoozi/shared/server/credential-crypto`.
 */
export const PACKAGE_NAME = '@bantoozi/shared';

export * from './clock.js';
export * from './dto/common.js';
export * from './dto/explain.js';
export * from './dto/provider-credentials.js';
export * from './errors.js';
export * from './ids.js';
export * from './jobs.js';
export * from './json.js';
export * from './plans.js';
export * from './policies/images.js';
export * from './policies/inference.js';
export * from './ports.js';
export * from './preferences.js';
export * from './ranker-config.js';
export * from './settings.js';
export * from './text/canonical-json.js';
export * from './text/normalize-text.js';
