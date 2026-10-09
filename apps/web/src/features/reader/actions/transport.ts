import type { ArticleListItem } from '@bantoozi/shared';

import type { ApiClient } from '../../../api/client.js';
import type { CallOptions } from '../../../api/route.js';
import { routes } from '../../../api/routes.js';
import type { ActionResponse, Fence, ReaderAction, ReaderTransport } from './types.js';

/** The properties of `value` that are not `undefined`. */
function present<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, property]) => property !== undefined),
  ) as Partial<T>;
}

const plain = ({
  item,
  mutationId,
}: {
  item: ArticleListItem;
  mutationId: string;
}): ActionResponse => ({ item, mutationId });

async function sendAction(
  client: ApiClient,
  articleId: string,
  action: ReaderAction,
  fence: Fence,
  options: CallOptions,
): Promise<ActionResponse> {
  const params = { id: articleId };
  const fields = {
    stateVersion: fence.stateVersion,
    contentRevision: fence.contentRevision,
    ...present({ snapshotId: fence.snapshotId }),
  };

  switch (action.type) {
    case 'read':
      return plain(
        await client.call(
          routes.articleRead,
          { params, body: { ...fields, ...present({ trigger: action.trigger }) } },
          options,
        ),
      );
    case 'unread':
      return plain(await client.call(routes.articleUnread, { params, body: fields }, options));
    case 'unhide':
      return plain(await client.call(routes.articleUnhide, { params, body: fields }, options));
    case 'open':
      return plain(await client.call(routes.articleOpen, { params, body: fields }, options));
    case 'dwell': {
      const { item, mutationId, prompt } = await client.call(
        routes.articleDwell,
        { params, body: { ...fields, ms: action.ms } },
        options,
      );
      return { item, mutationId, prompt };
    }
    case 'rate': {
      const { item, mutationId, exampleSuggestion } = await client.call(
        routes.articleRate,
        {
          params,
          body: {
            ...fields,
            rating: action.rating,
            ...present({
              reason: action.reason,
              hide: action.hide,
              analysisRequestId: action.analysisRequestId,
              selection: action.selection,
            }),
          },
        },
        options,
      );
      return { item, mutationId, exampleSuggestion };
    }
    case 'promptAnswer':
      return plain(
        await client.call(
          routes.articlePromptAnswer,
          {
            params,
            body: {
              ...fields,
              liked: action.liked,
              ...present({ analysisRequestId: action.analysisRequestId }),
            },
          },
          options,
        ),
      );
    case 'bookmark':
      return plain(
        await client.call(
          routes.articleBookmark,
          {
            params,
            body: { ...fields, ...present({ mediaPolicyFeedId: action.mediaPolicyFeedId }) },
          },
          options,
        ),
      );
    case 'unbookmark':
      return plain(await client.call(routes.articleUnbookmark, { params, query: fields }, options));
    case 'retryCapture':
      return plain(
        await client.call(
          routes.articleRetryCapture,
          { params, body: { ...fields, captureGeneration: action.captureGeneration } },
          options,
        ),
      );
    case 'addLabel':
      return plain(
        await client.call(
          routes.articleLabelAdd,
          { params, body: { ...fields, labelId: action.labelId } },
          options,
        ),
      );
    case 'removeLabel':
      return plain(
        await client.call(
          routes.articleLabelRemove,
          { params: { ...params, labelId: action.labelId }, query: fields },
          options,
        ),
      );
  }
}

/** The reader store's requests as calls of the typed API client; failures are its `ApiError`s. */
export function createReaderTransport(client: ApiClient): ReaderTransport {
  return {
    send: (articleId, action, fence, idempotencyKey, signal) =>
      sendAction(client, articleId, action, fence, { idempotencyKey, signal }),
    markRead: (body, idempotencyKey, signal) =>
      client.call(routes.articleMarkRead, { body }, { idempotencyKey, signal }),
    rateBulk: (body, idempotencyKey, signal) =>
      client.call(routes.articleRateBulk, { body }, { idempotencyKey, signal }),
    undo: (mutationId, idempotencyKey, signal) =>
      client.call(routes.articleUndo, { body: { mutationId } }, { idempotencyKey, signal }),
  };
}
