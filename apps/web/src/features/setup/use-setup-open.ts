import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';

export const SETUP_STATE_KEY = ['setup', 'state'] as const;

/** Whether first-run setup is open; `undefined` while unknown, and `false` when it cannot be read. */
export function useSetupOpen(): boolean | undefined {
  const api = useApi();
  const state = useQuery({
    queryKey: SETUP_STATE_KEY,
    queryFn: ({ signal }) => api.call(routes.setupState, undefined, { signal }),
    retry: false,
    staleTime: 0,
  });
  if (state.isError) return false;
  return state.data?.open;
}
