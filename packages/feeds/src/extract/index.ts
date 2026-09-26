/** Article extraction, robots.txt and politeness (spec 03 §8) — M1-T5. */
export { EXTRACTOR_VERSION, extractArticle } from './extract-article.js';
export { extractFromHtml } from './extract-html.js';
export {
  createMemoryOriginLimiter,
  type MemoryOriginLimiterOptions,
} from './memory-origin-limiter.js';
export { EXTRACT_MAX_OUTPUT_BYTES } from './output-cap.js';
export {
  createRobotsChecker,
  ROBOTS_PRODUCT_TOKEN,
  type RobotsChecker,
  type RobotsCheckerOptions,
  type RobotsDecision,
  type RobotsFetch,
} from './robots.js';
export {
  EXTRACTION_SKIP_EXTENSIONS,
  EXTRACTION_SKIP_HOSTS,
  type ExtractionSkipReason,
  extractionSkipReason,
} from './skip-list.js';
export { BODY_LEAD_MAX_CHARS, bodyLead, countWords } from './text-metrics.js';
export type {
  BeforeRequest,
  ExtractArticleOptions,
  ExtractDeps,
  ExtractResult,
  ExtractStatus,
  HtmlExtractResult,
  PageFetchOptions,
} from './types.js';
