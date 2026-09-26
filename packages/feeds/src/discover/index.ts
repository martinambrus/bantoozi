/** Feed discovery (spec 03 §10) and feed URL validation (spec 03 §4, §5, §11) — M1-T6. */
export {
  DISCOVERY_DEADLINE_MS,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_CONCURRENT_PROBES,
  DISCOVERY_MAX_REQUESTS,
  FEED_PROBE_PATHS,
  discoverFeed,
  type DiscoverDeps,
  type DiscoverResult,
  type DiscoveryFailure,
  type DiscoveryFetchOptions,
  type DiscoverySuccess,
  type FeedCandidate,
} from './discover-feed.js';
export {
  CREDENTIAL_PARAMS,
  MAX_FEED_IDENTITY_BYTES,
  MAX_FEED_URL_BYTES,
  redactFeedUrl,
  validateFeedUrl,
  type FeedUrlCheck,
  type FeedUrlRejection,
  type ValidateFeedUrlOptions,
} from './feed-url.js';
export {
  ALTERNATE_FEED_TYPES,
  findAlternateFeeds,
  type AlternateFeedLink,
  type AlternateFeedType,
} from './html-links.js';
