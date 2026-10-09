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

/**
 * What a row shows for the view it is listed in (spec 08 §5.2): the feed it is shown from, its
 * arrival there, its reason, label suggestions, analysis and story, and the image setting. Two
 * views can show one article differently, so each saved view keeps these for its own rows; the rest
 * of the row is the article and the reader's state, which every view shares.
 */
const VIEW_KEYS = [
  'feed',
  'firstSeenAt',
  'topReason',
  'labelSuggestions',
  'analysis',
  'mediaPolicyFeedId',
  'effectiveImagesAllowed',
  'cluster',
] as const satisfies readonly (typeof ITEM_KEYS)[number][];

export type OfflineItem = Pick<ArticleListItem, (typeof ITEM_KEYS)[number]>;
export type OfflineDetail = Pick<ArticleDetail, (typeof DETAIL_KEYS)[number]>;
export type ViewProjection = Pick<ArticleListItem, (typeof VIEW_KEYS)[number]>;

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

export function projectView(item: ArticleListItem): ViewProjection {
  return pick(item, VIEW_KEYS);
}
