import type { ArticleDetail, ArticleListItem } from '@bantoozi/shared';

/**
 * What the offline store may keep of an article (spec 09 §1): what a row and the opened article
 * render, and the fences their actions need. The score, the explanation, the rank and the cluster
 * members never leave the server's view; a key that is not named here is not stored.
 */
const ITEM_KEYS = [
  'id',
  'title',
  'url',
  'feed',
  'author',
  'publishedAt',
  'firstSeenAt',
  'excerpt',
  'imageUrl',
  'lang',
  'topReason',
  'labelIds',
  'labelSuggestions',
  'rating',
  'reason',
  'readAt',
  'bookmarkedAt',
  'archivedAt',
  'stateVersion',
  'contentRevision',
  'translationAvailable',
  'analysis',
  'mediaPolicyFeedId',
  'effectiveImagesAllowed',
  'bookmarkCapture',
  'cluster',
] as const satisfies readonly (keyof ArticleListItem)[];

const DETAIL_KEYS = [
  ...ITEM_KEYS,
  'excerptHtml',
  'bodyLead',
  'translation',
  'bookmarkSnapshot',
] as const satisfies readonly (keyof ArticleDetail)[];

export type OfflineItem = Pick<ArticleListItem, (typeof ITEM_KEYS)[number]>;
export type OfflineDetail = Pick<ArticleDetail, (typeof DETAIL_KEYS)[number]>;

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
}

export function projectItem(item: ArticleListItem): OfflineItem {
  return pick(item, ITEM_KEYS);
}

export function projectDetail(detail: ArticleDetail): OfflineDetail {
  return pick(detail, DETAIL_KEYS);
}
