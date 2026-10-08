import {
  compareBigIntStrings,
  type ArticleDetail as ArticleDetailDto,
  type ArticleListItem,
  type BookmarkSnapshot,
} from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { ExternalIcon } from '../../components/icons.js';
import { SafeHtml } from '../../components/safe-html.js';
import { QueryState } from '../../components/states/query-state.js';
import { useAccountId } from '../../session/context.js';
import { useObserveItems, useReaderItem, useReturnTracker } from '../reader/actions/provider.js';
import { Paragraphs, SavedCopy } from './article-body.js';
import { CapturePanel } from './capture-panel.js';
import { DetailActions } from './detail-actions.js';
import { httpUrl } from './http-url.js';
import { ImagePolicyPanel } from './image-policy-panel.js';
import { articleKeys } from './query-keys.js';
import { useArticleActions } from './use-article-actions.js';

/** A capture in progress is asked about at the idle polling rate while visible (spec 09 §1). */
const CAPTURE_POLL_MS = 30_000;

export interface ArticleDetailProps {
  /** The article as the list holds it; the detail adds its body to it. */
  item: ArticleListItem;
  /** The feed the reader is looking at; the detail is projected like its rows (spec 08 §5.2). */
  sourceFeedId?: string | undefined;
  /** The Bookmarks view: the saved copy is shown and the actions are fenced against it. */
  saved?: boolean | undefined;
  onWhyThis?: (() => void) | undefined;
}

/**
 * The newer of the list's row and the detail. A finished capture does not move the state version,
 * so the detail must win when the versions are equal.
 */
function freshest(row: ArticleListItem, detail: ArticleListItem | undefined): ArticleListItem {
  if (detail === undefined) return row;
  const byState = compareBigIntStrings(detail.stateVersion, row.stateVersion);
  const byContent = compareBigIntStrings(detail.contentRevision, row.contentRevision);
  return byState > 0 || (byState === 0 && byContent >= 0) ? detail : row;
}

interface DetailContentProps {
  data: ArticleDetailDto;
  imagesAllowed: boolean;
  snapshot: BookmarkSnapshot | null;
}

function DetailContent({ data, imagesAllowed, snapshot }: DetailContentProps) {
  const { t } = useTranslation('article');
  const [translated, setTranslated] = useState(false);
  if (snapshot !== null) return <SavedCopy snapshot={snapshot} />;

  const { translation } = data;
  const translatable =
    translation !== null && (translation.title !== null || translation.excerpt !== null);
  const lang = data.lang ?? undefined;

  return (
    <div className="flex flex-col gap-3">
      {translatable ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setTranslated((shown) => !shown)}>
            {translated ? t('detail.showOriginal') : t('detail.showTranslation')}
          </Button>
        </div>
      ) : null}
      {translatable && translated ? (
        <div lang="en" className="flex flex-col gap-2">
          {translation.title === null ? null : (
            <h4 className="text-lg font-semibold">{translation.title}</h4>
          )}
          {translation.excerpt === null ? null : <Paragraphs text={translation.excerpt} />}
        </div>
      ) : data.excerptHtml !== null ? (
        <div lang={lang}>
          <SafeHtml html={data.excerptHtml} imagesAllowed={imagesAllowed} />
        </div>
      ) : data.bodyLead !== null ? (
        <Paragraphs text={data.bodyLead} lang={lang} />
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('detail.noPreview')}</p>
      )}
    </div>
  );
}

function DetailView({ item: row, sourceFeedId, saved = false, onWhyThis }: ArticleDetailProps) {
  const { t } = useTranslation('article');
  const api = useApi();
  const accountId = useAccountId();
  const tracker = useReturnTracker();

  const detail = useQuery({
    queryKey: articleKeys.detail(accountId, row.id, { sourceFeedId, saved }),
    queryFn: ({ signal }) =>
      api.call(
        routes.articleGet,
        {
          params: { id: row.id },
          query: {
            ...(sourceFeedId === undefined ? {} : { sourceFeedId }),
            ...(saved ? { view: 'saved' as const } : {}),
          },
        },
        { signal },
      ),
  });
  const { data, refetch } = detail;

  const observed = useMemo(() => (data === undefined ? [] : [data]), [data]);
  useObserveItems(observed);
  const shown = useReaderItem(freshest(row, data));

  // The saved copy in the Bookmarks view, and then the fence of every action (spec 08 §5.2).
  const snapshot = saved ? (data?.bookmarkSnapshot ?? null) : null;
  const fence =
    snapshot === null ? undefined : { id: snapshot.id, contentRevision: snapshot.contentRevision };
  const actions = useArticleActions(shown, fence);
  // Until the saved copy is known, the fence of an action would be a guess.
  const ready = !saved || data !== undefined;

  const capturePending = shown.bookmarkedAt !== null && shown.bookmarkCapture?.status === 'pending';
  useEffect(() => {
    if (!capturePending) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refetch();
    }, CAPTURE_POLL_MS);
    return () => clearInterval(timer);
  }, [capturePending, refetch]);

  const original = httpUrl(shown.url);
  const readOriginal = () => {
    if (original === null) return;
    window.open(original.href, '_blank', 'noopener,noreferrer');
    actions.open();
    tracker.track(shown);
  };

  const imageSource = snapshot ?? (ready ? shown : null);
  const imageFeedId =
    imageSource === null || imageSource.effectiveImagesAllowed
      ? null
      : imageSource.mediaPolicyFeedId;

  return (
    <div className="flex flex-col gap-4">
      {shown.author === null || shown.author.trim() === '' ? null : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('detail.by', { author: shown.author })}
        </p>
      )}
      <QueryState query={detail}>
        {(loaded) => (
          <DetailContent
            data={loaded}
            imagesAllowed={shown.effectiveImagesAllowed}
            snapshot={snapshot}
          />
        )}
      </QueryState>
      {shown.bookmarkedAt === null || shown.bookmarkCapture === null ? null : (
        <CapturePanel capture={shown.bookmarkCapture} onRetry={actions.retryCapture} />
      )}
      {imageFeedId === null ? null : <ImagePolicyPanel feedId={imageFeedId} />}
      {ready ? (
        <>
          {original === null ? null : (
            <div>
              <Button variant="secondary" onClick={readOriginal}>
                <ExternalIcon className="size-4" />
                {t('detail.readOriginal')}
              </Button>
            </div>
          )}
          <DetailActions item={shown} actions={actions} onWhyThis={onWhyThis} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The expanded article (spec 09 §3.2): its body from `GET /articles/:id`, "Read original", the
 * capture status of a bookmark and the action bar. Rendered below a `ReaderActionsProvider`.
 */
export function ArticleDetail(props: ArticleDetailProps) {
  return <DetailView key={props.item.id} {...props} />;
}
