import type { ImagePolicy } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from './query-keys.js';

const POLICIES = [
  { policy: 'allow', label: 'images.allow' },
  { policy: 'block', label: 'images.block' },
  { policy: 'inherit', label: 'images.inherit' },
] as const satisfies readonly { policy: ImagePolicy; label: string }[];

/**
 * Shown where remote images are not loaded: the reader can remember a setting for the feed
 * (spec 09 §1) instead of changing the global one.
 */
export function ImagePolicyPanel({ feedId }: { feedId: string }) {
  const { t, i18n } = useTranslation('article');
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const save = useApiMutation(routes.feedPreferenceSet, {
    onSuccess: () => {
      toast.show({ message: i18n.t('article:images.saved'), tone: 'success' });
      return queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
    onError: (error) => {
      toast.show({ message: errorMessage(i18n.t, error), tone: 'error' });
    },
  });

  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-slate-300 p-3 dark:border-slate-600">
      <p className="text-sm text-slate-700 dark:text-slate-200">{t('images.blocked')}</p>
      <div className="flex flex-wrap gap-2">
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
