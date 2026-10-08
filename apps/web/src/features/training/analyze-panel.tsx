import type { AnalyzeResponse, ArticleListItem, Subscription } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { useSubscriptionsCache } from '../feeds/subscriptions.js';
import { MAX_SELECTED_ARTICLES } from './selection.js';

export interface AnalyzePanelProps {
  /** The feed the selected articles belong to, as the person last saw it. */
  subscription: Subscription;
  /** The selected articles, in the order they are sent. */
  items: readonly ArticleListItem[];
  /** The requests the API made, once it has accepted them. */
  onSubmitted: (requests: AnalyzeResponse['requests']) => void;
  /** The ids of selected articles the API found changed; they cannot be analyzed as chosen. */
  onDrop?: ((articleIds: readonly string[]) => void) | undefined;
}

type Refusal =
  | { kind: 'changed'; articleIds: string[] }
  | { kind: 'version' }
  | { kind: 'conflict' }
  | { kind: 'gone' }
  | { kind: 'other' };

function articleIdsOf(details: Readonly<Record<string, unknown>> | undefined): string[] | null {
  const ids = details?.['articleIds'];
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? (ids as string[]) : null;
}

/** What a refused analysis means (spec 08 §4.1); anything else is `other`. */
function refusalOf(error: unknown): Refusal {
  if (!isApiError(error)) return { kind: 'other' };
  if (error.code === 'STALE_STATE') {
    const articleIds = articleIdsOf(error.details);
    if (articleIds !== null) return { kind: 'changed', articleIds };
    if (typeof error.details?.['currentVersion'] === 'string') return { kind: 'version' };
  }
  if (error.code === 'CONFLICT') return { kind: 'conflict' };
  if (error.code === 'NOT_FOUND') return { kind: 'gone' };
  return { kind: 'other' };
}

/**
 * The selected articles of one feed, named in full, and the one button that sends them to be
 * analyzed (spec 09 §3.2). A feed that is off is switched to training by that same request.
 * Nothing here selects anything or sends anything but on that button.
 */
export function AnalyzePanel({ subscription, items, onSubmitted, onDrop }: AnalyzePanelProps) {
  const { t } = useTranslation('training');
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const subscriptions = useSubscriptionsCache();
  const analyze = useApiMutation(routes.subscriptionsAnalyze);
  const hintId = useId();
  const sending = useRef(false);

  const off = subscription.inferenceMode === 'off';
  const empty = items.length === 0;
  const hint = empty
    ? t('panel.hint', { max: MAX_SELECTED_ARTICLES })
    : off
      ? t('panel.offNote')
      : null;
  const refusal = analyze.error === null ? null : refusalOf(analyze.error);

  function refreshArticles() {
    void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
  }

  function send() {
    if (empty || sending.current) return;
    sending.current = true;
    analyze.mutate(
      {
        params: { feedId: subscription.feed.id },
        body: {
          articles: items.map(({ id, contentRevision }) => ({ id, contentRevision })),
          expectedInferenceVersion: subscription.inferenceVersion,
          ...(off ? { startTraining: true } : {}),
        },
      },
      {
        onSuccess: ({ requests }) => {
          void subscriptions.refresh();
          refreshArticles();
          onSubmitted(requests);
        },
        onError: (error) => {
          const refused = refusalOf(error);
          switch (refused.kind) {
            case 'changed':
              onDrop?.(refused.articleIds);
              refreshArticles();
              break;
            case 'version':
            case 'conflict':
              void subscriptions.refresh();
              break;
            case 'gone':
              refreshArticles();
              break;
            case 'other':
              break;
          }
        },
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  }

  function problem(): string | null {
    if (refusal === null) return null;
    switch (refusal.kind) {
      case 'changed':
        return t('errors.changed', { count: refusal.articleIds.length });
      case 'version':
        return t('errors.version');
      case 'gone':
        return t('errors.gone');
      case 'conflict':
      case 'other':
        return errorMessage(t, analyze.error);
    }
  }

  const message = problem();

  return (
    <section aria-label={t('panel.title')} className="flex flex-col gap-3">
      <p className="text-sm font-medium">
        {t('panel.count', { selected: items.length, max: MAX_SELECTED_ARTICLES })}
      </p>
      {empty ? null : (
        <ol
          aria-label={t('panel.selected')}
          className="flex list-decimal flex-col gap-1 ps-6 text-sm"
        >
          {items.map((item) => (
            <li key={item.id} className="break-words">
              {item.title}
            </li>
          ))}
        </ol>
      )}
      {hint === null ? null : (
        <p id={hintId} className="text-sm text-slate-600 dark:text-slate-300">
          {hint}
        </p>
      )}
      <div>
        <Button
          disabled={empty}
          loading={analyze.isPending}
          aria-describedby={hint === null ? undefined : hintId}
          onClick={send}
        >
          {empty
            ? t('panel.none')
            : t(off ? 'panel.start' : 'panel.analyze', { count: items.length })}
        </Button>
      </div>
      {message === null ? null : <InlineAlert>{message}</InlineAlert>}
    </section>
  );
}
