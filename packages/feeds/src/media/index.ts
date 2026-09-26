/**
 * Media signals (spec 03 §6.4, revision R2) — M1-T3/T5: video evidence and the in-body image count
 * of an article, read from feed item metadata, the article link and HTML before it is sanitized.
 */
export {
  isVideoEmbedUrl,
  isVideoHostUrl,
  VIDEO_EMBED_HOSTS,
  VIDEO_EMBED_PATH_PREFIXES,
  VIDEO_HOSTS,
  videoEmbedRegex,
} from './hosts.js';
export {
  isVideoMediaObject,
  mediaSignals,
  type MediaObject,
  type MediaSignals,
  type MediaSignalsInput,
} from './media-signals.js';
