import type { IdChange, LabelDto } from '@bantoozi/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId, useSignInLasts } from '../../session/context.js';
import { mergeById } from '../interests/merge-by-id.js';
import { articlesKey } from '../interests/queries.js';

export function labelsKey(accountId: string) {
  return accountKey(accountId, 'labels');
}

export function useLabels() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: labelsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.labelList, undefined, { signal }),
  });
}

/**
 * Keeps the caches in step with what a label mutation just did. Labels are immutable like cards,
 * so an answer can carry an `idChange`: the list takes the new id in the old one's place. The
 * labels shown on articles follow the label, so the account's article queries go stale with it.
 * With `lasts`, nothing changes once the sign-in the screen was mounted in has ended.
 */
export function labelCache(
  queryClient: QueryClient,
  accountId: string,
  lasts: () => boolean = () => true,
) {
  const refreshArticles = () => {
    void queryClient.invalidateQueries({ queryKey: articlesKey(accountId) });
  };
  return {
    apply(result: { label: LabelDto; idChange: IdChange | null }) {
      if (!lasts()) return;
      writeQueryData<LabelDto[]>(queryClient, labelsKey(accountId), (labels) =>
        labels === undefined ? labels : mergeById(labels, result.label, result.idChange),
      );
      refreshArticles();
    },
    remove(id: string) {
      if (!lasts()) return;
      writeQueryData<LabelDto[]>(queryClient, labelsKey(accountId), (labels) =>
        labels?.filter((label) => label.id !== id),
      );
      refreshArticles();
    },
  };
}

export function useLabelCache() {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const lasts = useSignInLasts();
  return useMemo(() => labelCache(queryClient, accountId, lasts), [queryClient, accountId, lasts]);
}
