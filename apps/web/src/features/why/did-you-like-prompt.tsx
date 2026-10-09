import type { ArticleListItem, Me } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { ThumbsDownIcon, ThumbsUpIcon } from '../../components/icons.js';
import { Sheet } from '../../components/sheet.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useMe } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import { useReaderActions, useSettledActions } from '../reader/actions/provider.js';

type FeedbackPrompt = Me['preferences']['feedbackPrompt'];

/** "Ask less often" moves the setting one step down; below "never" there is nothing. */
const LESS_OFTEN: Partial<Record<FeedbackPrompt, FeedbackPrompt>> = {
  often: 'occasionally',
  occasionally: 'never',
};

/**
 * "Did you like it?" (spec 09 §3.6): after the reader came back from an original and the server
 * asked for a prompt, one question at a time.
 */
export function DidYouLikePrompt() {
  const { t } = useTranslation('why');
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const actions = useReaderActions();
  const [asked, setAsked] = useState<ArticleListItem | null>(null);

  const setting = useApiMutation(routes.meUpdate, {
    onError: (error) => {
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  useSettledActions((handle, result) => {
    if (handle.action.type !== 'dwell' || result.status !== 'done' || !result.prompt) return;
    if (!me.preferences.implicitFeedback) return;
    setAsked(result.item);
  });

  const lessOften = LESS_OFTEN[me.preferences.feedbackPrompt];

  function answer(liked: boolean) {
    if (asked === null) return;
    const { requestId } = asked.analysis;
    actions.dispatch(asked, {
      type: 'promptAnswer',
      liked,
      ...(requestId === null ? {} : { analysisRequestId: requestId }),
    });
    setAsked(null);
  }

  function askLessOften() {
    setAsked(null);
    if (lessOften === undefined) return;
    // The answer may come after the prompt has gone; the promise settles then too, unlike the
    // callbacks of `mutate`. A failure has been shown by `onError` already.
    const patch = { preferences: { feedbackPrompt: lessOften } };
    setting.mutateAsync({ body: patch }).then(
      (updated) => storeSavedMe(queryClient, patch, updated),
      () => {},
    );
  }

  return (
    <Sheet
      open={asked !== null}
      onClose={() => setAsked(null)}
      title={asked === null ? '' : t('prompt.title', { title: asked.title })}
      side="bottom"
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => answer(true)}>
            <ThumbsUpIcon className="size-4" />
            {t('prompt.yes')}
          </Button>
          <Button variant="secondary" onClick={() => answer(false)}>
            <ThumbsDownIcon className="size-4" />
            {t('prompt.no')}
          </Button>
        </div>
        {lessOften === undefined ? null : (
          <div>
            <Button variant="ghost" size="sm" onClick={askLessOften}>
              {t('prompt.askLessOften')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
