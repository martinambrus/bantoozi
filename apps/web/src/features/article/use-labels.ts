import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { labelsKey } from '../labels/queries.js';

const LABELS_STALE_MS = 60_000;

/**
 * The signed-in account's labels, shared by every row and detail that names one. The Labels page
 * reads and changes the same cache entry, so what it saves shows here at once.
 */
export function useLabels(enabled: boolean) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: labelsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.labelList, undefined, { signal }),
    enabled,
    staleTime: LABELS_STALE_MS,
  });
}
