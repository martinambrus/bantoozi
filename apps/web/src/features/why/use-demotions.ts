import type { Me, MePatch } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId, useMe } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import { articleKeys } from '../article/query-keys.js';

type Demote = Me['preferences']['demote'];

export type DemotionFlag = keyof Demote;

type Setting = Demote[DemotionFlag];

/** The demotions the drawer offers to switch on; depth has no meter of its own. */
export type NeverShowFlag = Exclude<DemotionFlag, 'shallow'>;

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
  const accountId = useAccountId();
  const me = useMe();

  const update = useApiMutation(routes.meUpdate, {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
    onError: (error) => {
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  // The answer may come after the drawer has closed. `mutate` would drop its own callbacks then,
  // the promise still settles; a failure has been shown by `onError` already.
  const send = (flag: DemotionFlag, value: Setting, then: () => void) => {
    const patch: MePatch = { preferences: { demote: { [flag]: value } } };
    update.mutateAsync({ body: patch }).then(
      (updated) => {
        storeSavedMe(queryClient, patch, updated);
        then();
      },
      () => {},
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
    /** A change is on its way; another would race it. */
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
