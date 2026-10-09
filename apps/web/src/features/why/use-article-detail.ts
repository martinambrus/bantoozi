import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys, type ArticleDetailScope } from '../article/query-keys.js';

/**
 * `GET /articles/:id` under the key the expanded article uses, so the two share one cache entry
 * and one request, and a change that reloads the account's articles reloads this too.
 */
export function useArticleDetail(articleId: string, { sourceFeedId, saved }: ArticleDetailScope) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: articleKeys.detail(accountId, articleId, { sourceFeedId, saved }),
    queryFn: ({ signal }) =>
      api.call(
        routes.articleGet,
        {
          params: { id: articleId },
          query: {
            ...(sourceFeedId === undefined ? {} : { sourceFeedId }),
            ...(saved === true ? { view: 'saved' as const } : {}),
          },
        },
        { signal },
      ),
  });
}
