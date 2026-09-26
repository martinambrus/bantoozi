/**
 * `@bantoozi/translate` (spec 07): the LibreTranslate tier-1 client, the Ollama Cloud tier-2
 * translator, the pure quality assessment and the translation-row selection rules. The package
 * only makes HTTP calls and pure decisions; the `article.translate` handler reserves budget,
 * records every attempt through the engine router and stores `article_translations` rows.
 */
export const PACKAGE_NAME = '@bantoozi/translate';

export * from './assess.js';
export * from './best-row.js';
export * from './card-text.js';
export * from './language-names.js';
export * from './libretranslate.js';
export * from './ollama.js';
export * from './policy.js';
export * from './preflight.js';
export * from './quality-detail.js';
export * from './source.js';
export * from './types.js';
