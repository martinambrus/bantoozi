import type { ArticleListItem } from '@bantoozi/shared';

import { ApiError } from '../../../src/api/errors.js';
import type {
  ActionResponse,
  Fence,
  ReaderAction,
  ReaderTransport,
} from '../../../src/features/reader/actions/types.js';

export type TransportMethod = 'send' | 'markRead' | 'rateBulk' | 'undo';

type MarkReadBody = Parameters<ReaderTransport['markRead']>[0];
type RateBulkBody = Parameters<ReaderTransport['rateBulk']>[0];
export type MarkReadResponse = Awaited<ReturnType<ReaderTransport['markRead']>>;
export type BulkItemsResponse = Awaited<ReturnType<ReaderTransport['rateBulk']>>;

/**
 * One request the store made. `action`, `fence` and `body` are deep copies taken when the request
 * was made, so later mutation of the store's own objects cannot rewrite history. The promise the
 * store awaits stays pending until the test calls `resolve` or `reject`.
 */
export interface RecordedCall<TResponse = unknown> {
  /** Position among all calls of this transport, from 0. */
  readonly index: number;
  readonly method: TransportMethod;
  /** `send` only. */
  readonly articleId: string | null;
  /** `send` only. */
  readonly action: ReaderAction | null;
  /** `send` only. */
  readonly fence: Fence | null;
  readonly key: string;
  /** `send`: `{action, fence}`; `markRead` and `rateBulk`: the request body; `undo`: `{mutationId}`. */
  readonly body: unknown;
  readonly signal: AbortSignal;
  resolve(response: TResponse): void;
  reject(error: unknown): void;
}

export interface SendCall extends RecordedCall<ActionResponse> {
  readonly method: 'send';
  readonly articleId: string;
  readonly action: ReaderAction;
  readonly fence: Fence;
  readonly body: { action: ReaderAction; fence: Fence };
}

export interface MarkReadCall extends RecordedCall<MarkReadResponse> {
  readonly method: 'markRead';
  readonly body: MarkReadBody;
}

export interface RateBulkCall extends RecordedCall<BulkItemsResponse> {
  readonly method: 'rateBulk';
  readonly body: RateBulkBody;
}

export interface UndoCall extends RecordedCall<BulkItemsResponse> {
  readonly method: 'undo';
  readonly body: { mutationId: string };
}

const isSend = (call: RecordedCall): call is SendCall => call.method === 'send';
const isMarkRead = (call: RecordedCall): call is MarkReadCall => call.method === 'markRead';
const isRateBulk = (call: RecordedCall): call is RateBulkCall => call.method === 'rateBulk';
const isUndo = (call: RecordedCall): call is UndoCall => call.method === 'undo';

export class FakeTransport implements ReaderTransport {
  readonly calls: RecordedCall[] = [];

  get sends(): SendCall[] {
    return this.calls.filter(isSend);
  }

  get markReads(): MarkReadCall[] {
    return this.calls.filter(isMarkRead);
  }

  get rateBulks(): RateBulkCall[] {
    return this.calls.filter(isRateBulk);
  }

  get undos(): UndoCall[] {
    return this.calls.filter(isUndo);
  }

  sendsFor(articleId: string): SendCall[] {
    return this.sends.filter((call) => call.articleId === articleId);
  }

  send(
    articleId: string,
    action: ReaderAction,
    fence: Fence,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ActionResponse> {
    const body = structuredClone({ action, fence });
    return this.record<ActionResponse>({
      method: 'send',
      articleId,
      action: body.action,
      fence: body.fence,
      key: idempotencyKey,
      body,
      signal,
    });
  }

  markRead(
    body: MarkReadBody,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MarkReadResponse> {
    return this.record<MarkReadResponse>({
      method: 'markRead',
      articleId: null,
      action: null,
      fence: null,
      key: idempotencyKey,
      body: structuredClone(body),
      signal,
    });
  }

  rateBulk(
    body: RateBulkBody,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<BulkItemsResponse> {
    return this.record<BulkItemsResponse>({
      method: 'rateBulk',
      articleId: null,
      action: null,
      fence: null,
      key: idempotencyKey,
      body: structuredClone(body),
      signal,
    });
  }

  undo(
    mutationId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<BulkItemsResponse> {
    return this.record<BulkItemsResponse>({
      method: 'undo',
      articleId: null,
      action: null,
      fence: null,
      key: idempotencyKey,
      body: { mutationId },
      signal,
    });
  }

  private record<TResponse>(
    fields: Omit<RecordedCall<TResponse>, 'index' | 'resolve' | 'reject'>,
  ): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      this.calls.push({ ...fields, index: this.calls.length, resolve, reject });
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * A valid list item: unread, unrated, unbookmarked, at state version 4 of content revision 2.
 * Fixtures are deeply frozen, so a store that mutates an item it was given fails loudly.
 */
export function makeItem(overrides: Partial<ArticleListItem> = {}): ArticleListItem {
  return deepFreeze({
    id: '101',
    title: 'Solid-state batteries reach the pilot line',
    url: 'https://example.test/articles/101',
    feed: { id: '7', title: 'Example Weekly', iconUrl: null },
    author: null,
    publishedAt: '2026-05-31T08:00:00.000Z',
    firstSeenAt: '2026-05-31T08:05:00.000Z',
    excerpt: 'A short excerpt.',
    imageUrl: null,
    lang: 'en',
    lane: 'for_you',
    tier: 4,
    pLike: 0.82,
    topReason: { kind: 'card', cardId: '31', title: 'EV battery tech', p: 0.82 },
    labelIds: [],
    labelSuggestions: [],
    rating: null,
    reason: null,
    readAt: null,
    bookmarkedAt: null,
    archivedAt: null,
    stateVersion: '4',
    contentRevision: '2',
    translationAvailable: false,
    analysis: { mode: 'off', status: 'not_requested', requestId: null },
    mediaPolicyFeedId: null,
    effectiveImagesAllowed: false,
    bookmarkCapture: null,
    cluster: null,
    ...overrides,
  });
}

/** The item a successful write returns: the state version moves up by one and `patch` is applied. */
export function acked(
  item: ArticleListItem,
  patch: Partial<ArticleListItem> = {},
): ArticleListItem {
  return deepFreeze({ ...item, stateVersion: String(BigInt(item.stateVersion) + 1n), ...patch });
}

/** An error the API answered with (spec 08 §1 envelope). */
export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
  retryAfterMs?: number,
): ApiError {
  return new ApiError({
    kind: 'http',
    status,
    code,
    message: `${status} ${code}`,
    details,
    retryAfterMs,
  });
}

export function networkError(): ApiError {
  return new ApiError({ kind: 'network', status: null, code: 'NETWORK', message: 'offline' });
}

export function invalidResponseError(): ApiError {
  return new ApiError({
    kind: 'invalid_response',
    status: 200,
    code: 'INVALID_RESPONSE',
    message: 'unexpected body',
  });
}

export function abortedError(): ApiError {
  return new ApiError({ kind: 'aborted', status: null, code: 'ABORTED', message: 'aborted' });
}
