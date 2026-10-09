import type { Me, MePatch } from '@bantoozi/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId, useMe, useSession } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import { articleKeys } from '../article/query-keys.js';

type Demote = Me['preferences']['demote'];

export type DemotionFlag = keyof Demote;

type Setting = Demote[DemotionFlag];

/** The demotions the drawer offers to switch on; depth has no meter of its own. */
export type NeverShowFlag = Exclude<DemotionFlag, 'shallow'>;

/** The demotion change last asked for in each app, which the next one waits for. */
const queues = new WeakMap<QueryClient, Promise<void>>();

/**
 * The quality demotions of the ranking (spec 06 §5): "on" always ranks that kind of article lower,
 * "off" never does, "auto" leaves it to the ranker. They change the ranking, so the articles are
 * loaded again. The drawer holds one for all its sections, so none of them offers a change while
 * another's is on its way.
 */
export function useDemotions() {
  const { t } = useTranslation('why');
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const accountId = useAccountId();
  const me = useMe();

  const update = useApiMutation(routes.meUpdate, {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
  });

  // One change at a time, in the order they were asked for, from every drawer and from the toasts
  // they left behind: two on their way at once could be saved in either order. The answer may come
  // after the drawer has closed; `mutate` would drop its own callbacks then, the promise still
  // settles. A change asked for in a sign-in that has ended is not sent, and what is answered
  // after it ended shows nothing: its toast's undo would change the account signed in now.
  const send = (flag: DemotionFlag, value: Setting, then: () => void) => {
    const signIn = session.currentSignIn();
    const signedIn = () => session.currentSignIn() === signIn;
    const patch: MePatch = { preferences: { demote: { [flag]: value } } };
    const turn = (queues.get(queryClient) ?? Promise.resolve()).then(async () => {
      if (!signedIn()) return;
      let updated: Me;
      try {
        updated = await update.mutateAsync({ body: patch });
      } catch (error) {
        if (signedIn()) toast.show({ message: errorMessage(t, error), tone: 'error' });
        return;
      }
      if (!signedIn()) return;
      storeSavedMe(queryClient, patch, updated);
      then();
    });
    queues.set(
      queryClient,
      turn.catch(() => undefined),
    );
  };

  function reset(flag: DemotionFlag, then: () => void = () => {}) {
    send(flag, 'auto', () => {
      toast.show({ message: t('demote.reset'), tone: 'info' });
      then();
    });
  }

  /** "Off" again after a change was taken back: confirmed, with nothing left to undo. */
  function backOff(flag: DemotionFlag) {
    send(flag, 'off', () => {
      toast.show({ message: t(`demote.off.${flag}`), tone: 'info' });
    });
  }

  return {
    /** A change is on its way. */
    pending: update.isPending,
    neverShow: (flag: NeverShowFlag) => {
      // The meters offer this while the setting is "auto" or "off"; the undo puts that back.
      const wasOff = me.preferences.demote[flag] === 'off';
      send(flag, 'on', () => {
        toast.show({
          message: t(`demote.on.${flag}`),
          tone: 'success',
          action: {
            label: t('common:actions.undo'),
            onAction: () => (wasOff ? backOff(flag) : reset(flag)),
          },
        });
      });
    },
    reset,
    /** Stops a demotion the ranker applies by itself ("auto"); the undo hands it back. */
    turnOff: (flag: DemotionFlag, then: () => void = () => {}) => {
      send(flag, 'off', () => {
        toast.show({
          message: t(`demote.off.${flag}`),
          tone: 'success',
          action: { label: t('common:actions.undo'), onAction: () => reset(flag) },
        });
        then();
      });
    },
  };
}

export type Demotions = ReturnType<typeof useDemotions>;
