import type {
  ArticleListItem,
  MarkReadFilter,
  RatingReason,
  UserPreferences,
} from '@bantoozi/shared';

import type { ApiError } from '../../../api/errors.js';
import type { QueueRecord } from '../../../offline/types.js';

/** Spec 09 §3.3: the API undoes an action for 10 minutes after it was acknowledged. */
export const UNDO_WINDOW_MS = 10 * 60_000;

/**
 * The per-user fields of an article that reader actions change (spec 08 §5.3). Action responses are
 * global projections, so only these fields are ever taken from them; everything else in a row (lane,
 * tier, pLike, topReason, analysis, labelSuggestions, cluster, feed, images) belongs to the view.
 */
export const READER_FIELDS = [
  'stateVersion',
  'contentRevision',
  'readAt',
  'rating',
  'reason',
  'bookmarkedAt',
  'archivedAt',
  'labelIds',
  'bookmarkCapture',
] as const satisfies readonly (keyof ArticleListItem)[];

export type ReaderState = Pick<ArticleListItem, (typeof READER_FIELDS)[number]>;

/** One user intent on one article (spec 08 §5.3). */
export type ReaderAction =
  | { type: 'read'; trigger?: 'expand' }
  | { type: 'unread' }
  | { type: 'unhide' }
  | {
      type: 'rate';
      rating: 1 | -1 | null;
      /** Only with rating -1. */
      reason?: RatingReason;
      /** SHIFT + rate: also archive. */
      hide?: boolean;
      analysisRequestId?: string;
      selection?: 'calibration';
    }
  | { type: 'promptAnswer'; liked: boolean; analysisRequestId?: string }
  /** Spec 09 §1: always the feed the reader is looking at (`item.feed.id`). */
  | { type: 'bookmark'; mediaPolicyFeedId?: string }
  | { type: 'unbookmark' }
  | { type: 'addLabel'; labelId: string }
  | { type: 'removeLabel'; labelId: string }
  | { type: 'retryCapture'; captureGeneration: string }
  | { type: 'open' }
  | { type: 'dwell'; ms: number };

/** Server-undoable action types (spec 08 §5.4); open, dwell and retryCapture are not. */
export const UNDOABLE_ACTIONS = [
  'read',
  'unread',
  'unhide',
  'rate',
  'promptAnswer',
  'bookmark',
  'unbookmark',
  'addLabel',
  'removeLabel',
] as const satisfies readonly ReaderAction['type'][];

/**
 * The actions that may wait on the device for a connection (spec 09 §1); every other one needs it
 * and fails at once without it.
 */
export const OFFLINE_ACTIONS = [
  'read',
  'unread',
  'rate',
  'bookmark',
  'unbookmark',
  'addLabel',
  'removeLabel',
] as const satisfies readonly ReaderAction['type'][];

/** The `code` of the error of an action refused because the browser has no connection. */
export const OFFLINE_ERROR_CODE = 'OFFLINE';

/** The fence a request carries; `snapshotId` only in the saved-bookmark view. */
export interface Fence {
  stateVersion: string;
  contentRevision: string;
  snapshotId?: string;
}

/**
 * - `held`: optimistic, not sendable until `release` (the dislike reason bar, spec 09 §3.3);
 * - `queued`: waiting for an earlier action on the same article;
 * - `sending`: its request is in flight (body and key are frozen from the first send on);
 * - `waiting`: kept on the device because the server could not be reached; the change stays shown
 *   until a replay sends it (spec 09 §1);
 * - `done` / `stale` / `failed` / `cancelled`: settled.
 */
export type ActionStatus =
  'held' | 'queued' | 'sending' | 'waiting' | 'done' | 'stale' | 'failed' | 'cancelled';

export interface ExampleSuggestion {
  cardId: string;
  side: 'yes' | 'no';
}

export type ActionResult =
  | {
      status: 'done';
      item: ArticleListItem;
      mutationId: string;
      /** Rating responses only; always null for replayed actions (spec 09 §3.3). */
      exampleSuggestion: ExampleSuggestion | null;
      /** Dwell responses only (spec 09 §3.6). */
      prompt: boolean;
      /** Set when the server refused the request id as obsolete and the rating was resent without it. */
      droppedAnalysisRequestId: string | null;
    }
  /** 409 STALE_STATE: the server's reader state was adopted and this action rolled back. */
  | { status: 'stale'; item: ArticleListItem | null }
  /** Rolled back after the final attempt. */
  | { status: 'failed'; error: ApiError }
  | { status: 'cancelled' };

export interface ActionHandle {
  /** Client id; also the action's Idempotency-Key once sent. */
  readonly id: string;
  readonly articleId: string;
  readonly action: ReaderAction;
  readonly status: ActionStatus;
  /** The server receipt, once acknowledged. */
  readonly mutationId: string | null;
  readonly createdAt: number;
  readonly replayed: boolean;
  readonly result: Promise<ActionResult>;
}

export interface DispatchOptions {
  /** Apply the optimistic change now but send only on `release` (reason bar). */
  hold?: boolean;
  /** Saved-bookmark view: fence against the snapshot (spec 08 §5.2). */
  snapshot?: { id: string; contentRevision: string };
  /** Offline replay: never surface an example suggestion (spec 09 §3.3). */
  replayed?: boolean;
}

/**
 * At most 500 items for `markRead` and 200 for `rateBulk` (spec 08 §5.3); `bulk()` rejects larger
 * inputs with a RangeError and sends nothing. `rateBulk` never sends `analysisRequestId`: rating the
 * visible items is a rating convenience, not a selected analysis (spec 09 §3.3). After a mark-read
 * (either form), the given rows the store knew as unread take `readAt` and `stateVersion + 1`; the
 * server leaves rows that were already read untouched. A bulk that changed nothing (`count` 0) is
 * not listed in `recent()`.
 */
export type BulkInput =
  | { kind: 'markRead'; items: readonly ArticleListItem[] }
  /** Mark all read: `items` are the loaded unread rows the filter covers (optimistic only). */
  | {
      kind: 'markReadFilter';
      filter: MarkReadFilter;
      datasetVersion: string;
      items: readonly ArticleListItem[];
    }
  | { kind: 'rateBulk'; items: readonly ArticleListItem[]; rating: 1 | -1 | null };

export type BulkResult =
  | { status: 'done'; mutationId: string; count: number }
  | { status: 'stale'; items: ArticleListItem[]; reason: string | null }
  | { status: 'failed'; error: ApiError };

export type UndoResult =
  | { status: 'undone'; items: ArticleListItem[] }
  /** Cancelled before it was sent: nothing reached the server. */
  | { status: 'cancelled' }
  /** 409 STALE_STATE: newer changes were kept; their state was adopted. */
  | { status: 'conflict'; items: ArticleListItem[] }
  /** 409 CONFLICT `{reason}` (not_undoable, already_undone, expired) or 404 (`unknown`). */
  | { status: 'refused'; reason: 'not_undoable' | 'already_undone' | 'expired' | 'unknown' }
  | { status: 'failed'; error: ApiError };

export interface RecentAction {
  /** Action or bulk id. */
  id: string;
  kind: ReaderAction['type'] | BulkInput['kind'];
  articleIds: readonly string[];
  /** Acknowledgement time (epoch ms); undo is offered until +10 minutes. */
  at: number;
  mutationId: string;
  /** What a rating, single or bulk, set the articles to. */
  rating?: 1 | -1 | null;
  /** How many articles a bulk action changed, as the server counted them. */
  count?: number;
}

/** Responses the transport returns; it throws `ApiError` on failure (src/api/errors.ts). */
export interface ActionResponse {
  item: ArticleListItem;
  mutationId: string;
  exampleSuggestion?: ExampleSuggestion | null;
  prompt?: boolean;
}

export interface ReaderTransport {
  send(
    articleId: string,
    action: ReaderAction,
    fence: Fence,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ActionResponse>;
  markRead(
    body:
      | { targets: { id: string; stateVersion: string; contentRevision: string }[] }
      | { filter: MarkReadFilter; datasetVersion: string },
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ count: number; mutationId: string }>;
  rateBulk(
    body: {
      targets: {
        id: string;
        stateVersion: string;
        contentRevision: string;
        analysisRequestId?: string;
      }[];
      rating: 1 | -1 | null;
    },
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ count: number; mutationId: string; items: ArticleListItem[] }>;
  undo(
    mutationId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ count: number; mutationId: string; items: ArticleListItem[] }>;
}

/** A change to a kept record. */
export type RecordPatch = Partial<Pick<QueueRecord, 'key' | 'action' | 'fence' | 'after' | 'sent'>>;

/** How a kept record ended, as the account's other tabs are told (spec 09 §1). */
export type SettledNote =
  | { id: string; outcome: 'done'; item: ArticleListItem; mutationId: string }
  | { id: string; outcome: 'stale'; item: ArticleListItem | null }
  | { id: string; outcome: 'failed'; status: number | null; code: string }
  | { id: string; outcome: 'cancelled' };

/**
 * What the store needs of the device's queue store (spec 09 §1): where the changes of an account
 * are kept until they are sent, and which tab sends them.
 */
export interface ActionQueue {
  readonly accountId: string;
  /** Whether the account chose offline reading; only then are changes kept on the device. */
  enabled(): boolean;
  /** Whether the browser says it has a connection. */
  online(): boolean;
  /** Keeps the record; false when it could not be kept. */
  save(record: QueueRecord): Promise<boolean>;
  /** Changes a kept record; false when it is no longer there. */
  change(id: string, patch: RecordPatch): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Tells the account's other tabs how a record ended. */
  announce(note: SettledNote): void;
  /** Hears the account's other tabs; returns the function that stops listening. */
  hear(listener: (note: SettledNote) => void): () => void;
  /** Runs `work` while this tab is the one that sends kept records. */
  hold<T>(work: () => Promise<T>): Promise<T>;
}

export interface ReaderActionsOptions {
  transport: ReaderTransport;
  /** Current preferences; `markReadOnRate` shapes the optimistic rating. */
  preferences: () => Pick<UserPreferences, 'markReadOnRate'>;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
  /** Idempotency keys and action ids; defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /**
   * Transient failures (network, 429, 5xx) of actions, bulk requests and undo requests are retried
   * this many times with backoff, under the same key and body. Default 2.
   */
  maxRetries?: number;
  /**
   * Backoff before retry `n` (1-based). Default 500 ms × 2^(n−1). A `retryAfterMs` on the error
   * replaces it for that attempt; one above 30 s is not waited out, and the request fails at once.
   */
  backoffMs?: (attempt: number) => number;
  /** Called once per settled action (toasts, count invalidation). */
  onSettled?: (handle: ActionHandle, result: ActionResult) => void;
  /**
   * Where changes wait for a connection. Without it every action is sent at once, whatever the
   * connection, and nothing is kept on the device.
   */
  queue?: ActionQueue;
}

/**
 * The store's side of offline reading (spec 09 §1): the changes kept on the device because the
 * server could not be reached, and what a replay does with them.
 */
export interface OfflineControl {
  /**
   * The changes kept on the device and not yet sent (status `waiting`, and those queued behind
   * them), earliest first; of one article when given. The same array until something changes.
   */
  waiting(articleId?: string): readonly ActionHandle[];
  /** A point in time for `adopt`: records written after it are not taken for gone. */
  mark(): number;
  /**
   * Makes the store agree with the queue store: shows the records it has no change for as
   * `waiting` changes, and settles the changes whose record is gone, written before `mark`, as
   * cancelled (another tab sent or discarded them).
   */
  adopt(records: readonly QueueRecord[], mark?: number): void;
  /** Drops the unsent kept changes made at or before `cutoff` (epoch ms); returns how many. */
  expire(cutoff: number): number;
  /** Sends the waiting changes, article by article, each in the order it was made; resolves when none can go on. */
  drain(): Promise<void>;
}

/**
 * The reader's single write path (spec 09 §1, §3.3; spec 08 §5.3–5.4): optimistic overlay, one queue
 * per article with fences chained from the latest acknowledged state, rollback of only the failed
 * action, holds for the reason bar, and undo through server receipts.
 */
export interface ReaderActions {
  /** Feed server data (list/detail query results) into the known per-article state. */
  observe(items: readonly ArticleListItem[]): void;
  /**
   * The item as the reader should see it: the newest known server state (by `stateVersion`, then
   * `contentRevision`) with the optimistic changes of unsettled actions applied in order. Returns
   * the same object when nothing changes, so React memoization holds: repeated calls with the same
   * item object return the same result object until `getVersion()` changes.
   */
  view<T extends ArticleListItem>(item: T): T;
  dispatch(item: ArticleListItem, action: ReaderAction, options?: DispatchOptions): ActionHandle;
  /** Finalize a held action (e.g. the chosen reason, SHIFT-hide) and queue it for sending. */
  release(actionId: string, patch?: { reason?: RatingReason; hide?: boolean }): void;
  /**
   * Drop a held or not-yet-sent action and its optimistic change; false once it was sent. A change
   * kept on the device that waits for a replay and was never sent is dropped too, with its record;
   * one that was sent and then kept (the server may have it) is not.
   */
  cancel(actionId: string): boolean;
  /**
   * Re-queue a `failed` action with its original body and key and return its new handle (same id);
   * a handle kept from before stays `failed`. Null for any other status.
   */
  retry(actionId: string): ActionHandle | null;
  /**
   * Held or queued, or kept on the device and never sent: cancelled locally (`cancelled`, no
   * request). In flight, or kept after it was sent: waits for the ack (for the latter, the one a
   * replay gets), then undoes. An unknown id, or an action that settled without a receipt
   * (`failed`, `stale`), is `refused` 'unknown' with no request; an acknowledged no-op (its
   * `stateVersion` did not change) is `refused` 'not_undoable' with no request.
   */
  undo(actionId: string): Promise<UndoResult>;
  /**
   * A bulk takes its place in the queue of every article it covers: it is sent once every earlier
   * action on them has settled (a held one holds it until released or cancelled), fenced at their
   * acknowledged states, and later actions on them wait for it. A reset while it waits resolves it
   * as `failed` (an `aborted` error) without a request.
   */
  bulk(input: BulkInput): Promise<BulkResult>;
  /**
   * Acknowledged undoable actions and bulk actions (both mark-read forms, rate-bulk) of the last
   * 10 minutes, newest first, without server no-ops. Expiry is lazy: an entry past 10 minutes is
   * dropped when read, without a notification.
   */
  recent(): readonly RecentAction[];
  get(actionId: string): ActionHandle | undefined;
  readonly offline: OfflineControl;
  /**
   * What the store still holds: settled actions leave once their undo window (10 minutes) is over,
   * or at the next dispatch, bulk or observation when they cannot be undone.
   */
  retained(): { actions: number; recents: number };
  subscribe(listener: () => void): () => void;
  /** Increments on every change of displayed state or recent actions. */
  getVersion(): number;
  /**
   * Account reset: abort in-flight requests, ignore their answers, forget everything. The `result`
   * of every unsettled action resolves as `cancelled`, without `onSettled`.
   */
  reset(): void;
}

/** FeedIt: rating an item again in the same direction un-rates it (spec 09 §3.3). */
export function nextRating(current: 1 | -1 | null, pressed: 1 | -1): 1 | -1 | null {
  return current === pressed ? null : pressed;
}
