import { accountKey } from '../../api/query-keys.js';

export interface ArticleDetailScope {
  /** The feed view the detail is opened from. */
  sourceFeedId?: string | undefined;
  /** The saved copy of the bookmarks view. */
  saved?: boolean | undefined;
}

/**
 * Query keys of the article features. Everything starts with the account id (spec 09 §1), and the
 * key of a list or counts query for the account extends `all` and `counts`, so invalidating those
 * prefixes reaches every variant.
 */
export const articleKeys = {
  all: (accountId: string) => accountKey(accountId, 'articles'),
  counts: (accountId: string) => accountKey(accountId, 'articles', 'counts'),
  detail: (accountId: string, articleId: string, scope: ArticleDetailScope) =>
    accountKey(
      accountId,
      'articles',
      'detail',
      articleId,
      scope.sourceFeedId ?? null,
      scope.saved === true,
    ),
};
