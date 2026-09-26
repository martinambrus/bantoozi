import { canonicalJson } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';

/** Prefix of every linkless item's `canonical_url` and `url_key` (spec 03 §5 step 8). */
export const LINKLESS_URL_KEY_PREFIX = 'urn:bantoozi:';

/** The normalized item fields that identify a feed item without a link (spec 03 §5 step 8, §6). */
export interface LinklessIdentityInput {
  /** RSS guid, Atom id or JSON Feed id, complete and case-sensitive; `null` when absent. */
  guid: string | null;
  title: string;
  publishedAt: Date | null;
  excerpt: string | null;
}

/** A feed ID as it travels in code: a positive bigint in decimal, without leading zeros. */
const FEED_ID = /^[1-9][0-9]*$/;

/**
 * Identity of a linkless item (spec 03 §5 step 8): the full GUID/Atom id/JSON Feed id when it is
 * nonempty, else `canonicalJson([title, published_at, excerpt])` with `published_at` as an ISO
 * string or `null`. Fetch time never substitutes for a missing publication time, and an invalid
 * `Date` counts as unknown (spec 03 §6). A whitespace-only GUID is not an identifier: it would
 * merge every such item of the feed into one article.
 */
export function linklessIdentity(item: LinklessIdentityInput): string {
  if (item.guid !== null && item.guid.trim() !== '') return item.guid;
  const publishedAt =
    item.publishedAt !== null && Number.isFinite(item.publishedAt.getTime())
      ? item.publishedAt.toISOString()
      : null;
  return canonicalJson([item.title, publishedAt, item.excerpt]);
}

/**
 * `canonical_url` and `url_key` of a linkless item (spec 03 §5 step 8):
 * `'urn:bantoozi:' + feedId + ':' + sha256Hex(linklessIdentity(item))`. Identity is scoped to the
 * feed, because GUIDs are only unique within one feed.
 *
 * @throws TypeError when `feedId` is not a positive decimal bigint string.
 */
export function linklessUrlKey(feedId: string, item: LinklessIdentityInput): string {
  if (!FEED_ID.test(feedId)) {
    throw new TypeError('linklessUrlKey: feedId must be a positive decimal integer string');
  }
  return `${LINKLESS_URL_KEY_PREFIX}${feedId}:${sha256Hex(linklessIdentity(item))}`;
}
