import type { ImagePolicy } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId, useSession } from '../../session/context.js';
import { articleKeys } from './query-keys.js';

const POLICIES = [
  { policy: 'allow', label: 'images.allow' },
  { policy: 'block', label: 'images.block' },
  { policy: 'inherit', label: 'images.inherit' },
] as const satisfies readonly { policy: ImagePolicy; label: string }[];

/**
 * Shown where remote images are not loaded: the reader can remember a setting for the feed
 * (spec 09 §1) instead of changing the global one. It is one line with a disclosure, because the
 * question comes with every article of the feed; the three choices are one press away. An answer
 * that comes after the sign-in that asked has ended shows nothing.
 */
export function ImagePolicyPanel({ feedId }: { feedId: string }) {
  const { t, i18n } = useTranslation('article');
  const choicesId = useId();
  const [open, setOpen] = useState(false);
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const save = useApiMutation(routes.feedPreferenceSet, {
    onMutate: () => session.currentSignIn(),
    onSuccess: (_answer, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      setOpen(false);
      toast.show({ message: i18n.t('article:images.saved'), tone: 'success' });
      return queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
    onError: (error, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      toast.show({ message: errorMessage(i18n.t, error), tone: 'error' });
    },
  });

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-x-2">
        <p className="text-sm text-slate-700 dark:text-slate-200">{t('images.blocked')}</p>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={choicesId}
          onClick={() => setOpen((current) => !current)}
        >
          {t('images.change')}
        </Button>
      </div>
      <div id={choicesId} hidden={!open} className="flex flex-wrap gap-2">
        {POLICIES.map(({ policy, label }) => (
          <Button
            key={policy}
            variant="secondary"
            size="sm"
            loading={save.isPending && save.variables.body.imagePolicy === policy}
            disabled={save.isPending}
            onClick={() => save.mutate({ params: { feedId }, body: { imagePolicy: policy } })}
          >
            {t(label)}
          </Button>
        ))}
      </div>
    </div>
  );
}
