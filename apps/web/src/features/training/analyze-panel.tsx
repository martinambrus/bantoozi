import type {
  AnalyzeResponse,
  ArticleCounts,
  ArticleDetail,
  ArticleListItem,
  ArticleListResponse,
  Subscription,
} from '@bantoozi/shared';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { IconButton } from '../../components/icon-button.js';
import { CloseIcon } from '../../components/icons.js';
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
  /** Takes one article out of the selection; the titles have no button for it without this. */
  onRemove?: ((articleId: string) => void) | undefined;
  /**
   * Takes the focus the panel is about to lose: once the articles it sent are accepted (their ids,
   * in order) or once its last title is taken out (that id). Without it the panel keeps the focus.
   */
  returnFocus?: ((articleIds: readonly string[]) => void) | undefined;
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

type Requests = ReadonlyMap<string, AnalyzeResponse['requests'][number]>;

/** What the article queries hold: the pages of a list, a list, one article, or the counts. */
type CachedArticles =
  InfiniteData<ArticleListResponse> | ArticleListResponse | ArticleDetail | ArticleCounts;

/** The article with the request it was just given; the same object if it was not sent. */
function requested<T extends ArticleListItem>(article: T, requests: Requests): T {
  const request = requests.get(article.id);
  return request === undefined
    ? article
    : {
        ...article,
        analysis: { ...article.analysis, status: request.status, requestId: request.id },
      };
}

function requestedList(list: ArticleListResponse, requests: Requests): ArticleListResponse {
  const items = list.items.map((article) => requested(article, requests));
  return items.some((article, index) => article !== list.items[index]) ? { ...list, items } : list;
}

/** What the cached articles become once `requests` are made; undefined where none was sent. */
function withRequests(
  cached: CachedArticles | undefined,
  requests: Requests,
): CachedArticles | undefined {
  if (cached === undefined) return undefined;
  let next: CachedArticles;
  if ('pages' in cached) {
    const pages = cached.pages.map((list) => requestedList(list, requests));
    next = pages.some((list, index) => list !== cached.pages[index])
      ? { ...cached, pages }
      : cached;
  } else if ('items' in cached) {
    next = requestedList(cached, requests);
  } else if ('analysis' in cached) {
    next = requested(cached, requests);
  } else {
    return undefined;
  }
  return next === cached ? undefined : next;
}

const sameArticles = (a: readonly ArticleListItem[], b: readonly ArticleListItem[]) =>
  a.length === b.length && a.every((article, index) => article.id === b[index]?.id);

/** The focus is in `section`, or nowhere: moving it then takes it from nothing the person chose. */
function focusWithin(section: HTMLElement): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || section.contains(active);
}

/** The focus is nowhere, or on a control of `section` that can no longer take it. */
function focusLost(section: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    (section.contains(active) && active.matches(':disabled'))
  );
}

/** Where the focus goes once the selection is no longer `from`: a title's button, else the panel. */
interface Refocus {
  from: readonly ArticleListItem[];
  to: string | null;
}

/**
 * The selected articles of one feed, named in full, and the one button that sends them to be
 * analyzed (spec 09 §3.2). A feed that is off is switched to training by that same request.
 * Nothing here selects anything or sends anything but on that button.
 */
export function AnalyzePanel({
  subscription,
  items,
  onSubmitted,
  onDrop,
  onRemove,
  returnFocus,
}: AnalyzePanelProps) {
  const { t } = useTranslation('training');
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const subscriptions = useSubscriptionsCache();
  const analyze = useApiMutation(routes.subscriptionsAnalyze);
  const hintId = useId();
  const sending = useRef(false);
  const section = useRef<HTMLElement>(null);
  const removers = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<Refocus | null>(null);
  const [seen, setSeen] = useState(items);
  const [movedOn, setMovedOn] = useState<unknown>(null);

  const off = subscription.inferenceMode === 'off';
  const empty = items.length === 0;
  const hint = empty
    ? t('panel.hint', { max: MAX_SELECTED_ARTICLES })
    : off
      ? t('panel.offNote')
      : null;
  const refusal = analyze.error === null ? null : refusalOf(analyze.error);

  // A refusal is about the selection that was sent: the person adding or removing an article ends
  // it, but dropping the articles it names is its own doing.
  if (seen !== items) {
    setSeen(items);
    const named = refusal?.kind === 'changed' ? refusal.articleIds : [];
    const dropped = seen.filter((article) => !named.includes(article.id));
    if (analyze.error !== null && !sameArticles(items, seen) && !sameArticles(items, dropped)) {
      setMovedOn(analyze.error);
    }
  }

  useEffect(() => {
    const pending = refocus.current;
    if (pending === null || pending.from === items) return;
    refocus.current = null;
    const panel = section.current;
    if (panel === null || !focusLost(panel)) return;
    const button = pending.to === null ? undefined : removers.current.get(pending.to);
    (button ?? panel).focus();
  }, [items]);

  function refreshArticles() {
    void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
  }

  function recordRequests(made: AnalyzeResponse['requests']) {
    const requests: Requests = new Map(made.map((request) => [request.articleId, request]));
    queryClient.setQueriesData<CachedArticles>({ queryKey: articleKeys.all(accountId) }, (cached) =>
      withRequests(cached, requests),
    );
  }

  function accepted(sent: readonly ArticleListItem[], requests: AnalyzeResponse['requests']) {
    void subscriptions.refresh();
    recordRequests(requests);
    refreshArticles();
    const panel = section.current;
    if (returnFocus === undefined) refocus.current = { from: sent, to: null };
    else if (panel !== null && focusWithin(panel)) {
      returnFocus(requests.map(({ articleId }) => articleId));
    }
    onSubmitted(requests);
  }

  function refused(sent: readonly ArticleListItem[], error: unknown) {
    const reason = refusalOf(error);
    switch (reason.kind) {
      case 'changed':
        refocus.current = { from: sent, to: null };
        onDrop?.(reason.articleIds);
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
  }

  // The answer is acted on even when the panel is gone by then: the cache still has to know.
  async function send() {
    if (empty || sending.current) return;
    sending.current = true;
    const sent = items;
    let requests: AnalyzeResponse['requests'];
    try {
      ({ requests } = await analyze.mutateAsync({
        params: { feedId: subscription.feed.id },
        body: {
          articles: sent.map(({ id, contentRevision }) => ({ id, contentRevision })),
          expectedInferenceVersion: subscription.inferenceVersion,
          ...(off ? { startTraining: true } : {}),
        },
      }));
    } catch (error) {
      refused(sent, error);
      return;
    } finally {
      sending.current = false;
    }
    accepted(sent, requests);
  }

  function remove(articleId: string) {
    const index = items.findIndex((item) => item.id === articleId);
    const next = items[index + 1] ?? items[index - 1];
    if (next === undefined && returnFocus !== undefined) returnFocus([articleId]);
    else refocus.current = { from: items, to: next?.id ?? null };
    onRemove?.(articleId);
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

  const message = analyze.error === movedOn ? null : problem();

  return (
    <section
      ref={section}
      aria-label={t('panel.title')}
      tabIndex={-1}
      className="flex flex-col gap-3 outline-none"
    >
      <p className="text-sm font-medium">
        {t('panel.count', { selected: items.length, max: MAX_SELECTED_ARTICLES })}
      </p>
      {empty ? null : (
        <ol
          aria-label={t('panel.selected')}
          className="flex list-decimal flex-col gap-1 ps-6 text-sm"
        >
          {items.map((item) => (
            <li key={item.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-words">{item.title}</span>
                {onRemove === undefined ? null : (
                  <IconButton
                    ref={(button) => {
                      if (button !== null) removers.current.set(item.id, button);
                      return () => {
                        removers.current.delete(item.id);
                      };
                    }}
                    label={t('panel.remove', { title: item.title })}
                    onClick={() => {
                      remove(item.id);
                    }}
                  >
                    <CloseIcon className="size-4" />
                  </IconButton>
                )}
              </div>
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
          onClick={() => {
            void send();
          }}
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
