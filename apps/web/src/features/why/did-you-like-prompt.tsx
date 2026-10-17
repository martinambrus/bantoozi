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
import { useMe, useSession } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import { useReaderActions, useReasonBar, useSettledActions } from '../reader/actions/provider.js';

type FeedbackPrompt = Me['preferences']['feedbackPrompt'];

/** "Ask less often" moves the setting one step down; below "never" there is nothing. */
const LESS_OFTEN: Partial<Record<FeedbackPrompt, FeedbackPrompt>> = {
  often: 'occasionally',
  occasionally: 'never',
};

/**
 * "Did you like it?" (spec 09 §3.6): after the reader came back from an original and the server
 * asked for a prompt, one question at a time. An answer that comes after the sign-in that asked has
 * ended shows nothing.
 */
export function DidYouLikePrompt() {
  const { t } = useTranslation('why');
  const queryClient = useQueryClient();
  const session = useSession();
  const toast = useToast();
  const me = useMe();
  const actions = useReaderActions();
  const reasonBar = useReasonBar();
  const [asked, setAsked] = useState<ArticleListItem | null>(null);

  const setting = useApiMutation(routes.meUpdate, {
    onMutate: () => session.currentSignIn(),
    onError: (error, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
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
    const action = {
      type: 'promptAnswer' as const,
      liked,
      ...(requestId === null ? {} : { analysisRequestId: requestId }),
    };
    setAsked(null);
    if (liked) {
      actions.dispatch(asked, action);
      return;
    }
    // A "no" is a dislike: it waits for its reason in the reason bar, as the thumb's does (D-266).
    const handle = actions.dispatch(asked, action, { hold: true });
    reasonBar.open({
      actionId: handle.id,
      articleId: asked.id,
      title: asked.title,
      before: asked.rating,
    });
  }

  function askLessOften() {
    setAsked(null);
    if (lessOften === undefined) return;
    // The answer may come after the prompt has gone; the promise settles then too, unlike the
    // callbacks of `mutate`. A failure has been shown by `onError` already.
    const patch = { preferences: { feedbackPrompt: lessOften } };
    const signIn = session.currentSignIn();
    setting.mutateAsync({ body: patch }).then(
      (updated) => {
        if (session.currentSignIn() === signIn) storeSavedMe(queryClient, patch, updated);
      },
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
