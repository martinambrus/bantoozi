import type { Me } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';

import { useApi } from '../../api/context.js';
import { useApiMutation } from '../../api/mutation.js';
import { meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useSession } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import type { Lane } from '../reader/lanes.js';

export type FinishButton = 'skip' | 'finish';

export interface Finishing {
  /** The button that was pressed while the wizard is being closed. */
  pressed: FinishButton | null;
  /** What stopped the last attempt. */
  error: unknown;
  finish: (button: FinishButton) => Promise<void>;
}

/**
 * Closes the wizard (spec 09 §4 step 5): saves that it is done, once, then opens For you when it
 * has articles for the person and New otherwise. It starts no classification and no analysis. An
 * answer that comes after the sign-in that asked has ended goes nowhere.
 */
export function useFinish(): Finishing {
  const api = useApi();
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const save = useApiMutation(routes.meUpdate);
  const { mutateAsync } = save;
  const completedAt = useRef<string | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<{ pressed: FinishButton | null; error: unknown }>({
    pressed: null,
    error: null,
  });

  // For you when it has articles for the person, else New, where untrained articles can be read.
  const firstLane = useCallback(async (): Promise<Lane> => {
    try {
      const counts = await api.call(routes.articleCounts);
      return counts.forYou > 0 ? 'for_you' : 'new';
    } catch {
      return 'new';
    }
  }, [api]);

  const finish = useCallback(
    async (button: FinishButton) => {
      if (busy.current) return;
      busy.current = true;
      setState({ pressed: button, error: null });
      const signIn = session.currentSignIn();
      const lasts = () => session.currentSignIn() === signIn;
      try {
        const saved = queryClient.getQueryData<Me | null>(meKey())?.preferences;
        if (saved?.onboardingCompletedAt === null) {
          // The same time on every attempt, so a repeated request is the same request.
          completedAt.current ??= new Date().toISOString();
          const patch = { preferences: { onboardingCompletedAt: completedAt.current } };
          const updated = await mutateAsync({ body: patch });
          if (!lasts()) return;
          storeSavedMe(queryClient, patch, updated);
        }
        const lane = await firstLane();
        if (!lasts()) return;
        await navigate({ to: '/read/$lane', params: { lane } });
        setState({ pressed: null, error: null });
      } catch (error) {
        setState({ pressed: null, error });
      } finally {
        busy.current = false;
      }
    },
    [firstLane, mutateAsync, navigate, queryClient, session],
  );

  return { ...state, finish };
}
