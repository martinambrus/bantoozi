import {
  ArticleListItemSchema,
  MAX_MARK_READ_TARGETS,
  MAX_RATE_BULK_TARGETS,
  compareBigIntStrings,
  nextRevision,
  type ArticleListItem,
  type RatingReason,
} from '@bantoozi/shared';

import { ApiError, isApiError, isRetryable } from '../../../api/errors.js';
import type { QueueRecord } from '../../../offline/types.js';
import {
  OFFLINE_ACTIONS,
  OFFLINE_ERROR_CODE,
  READER_FIELDS,
  UNDO_WINDOW_MS,
  UNDOABLE_ACTIONS,
  type ActionHandle,
  type ActionQueue,
  type ActionResponse,
  type ActionResult,
  type BulkInput,
  type BulkResult,
  type DispatchOptions,
  type Fence,
  type OfflineControl,
  type ReaderAction,
  type ReaderActions,
  type ReaderActionsOptions,
  type ReaderState,
  type RecentAction,
  type SettledNote,
  type UndoResult,
} from './types.js';

const DEFAULT_MAX_RETRIES = 2;
/** A longer Retry-After is not waited out in the background; the request fails at once. */
const MAX_RETRY_AFTER_MS = 30_000;

const UNDOABLE = new Set<ReaderAction['type']>(UNDOABLE_ACTIONS);
const OFFLINE = new Set<ReaderAction['type']>(OFFLINE_ACTIONS);
const ItemsSchema = ArticleListItemSchema.array();
const NullableItemSchema = ArticleListItemSchema.nullable();

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Refusal = Extract<UndoResult, { status: 'refused' }>['reason'];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

interface ActionEntry {
  readonly kind: 'action';
  handle: Mutable<ActionHandle>;
  readonly stamp: string;
  readonly markRead: boolean;
  readonly snapshot: DispatchOptions['snapshot'];
  /** Fixed by the first send: a retry repeats the same request. */
  fence: Fence | null;
  key: string;
  resolve: (result: ActionResult) => void;
  droppedRequestId: string | null;
  undoable: boolean;
  /** The reader state shown before this change; kept in its record. */
  before: ReaderState | null;
  /** A record of this change is kept in the queue store, or is being written. */
  stored: boolean;
  /** The change was sent and then kept on the device, so the server may have it. */
  sent: boolean;
  /** The id of the earlier kept change on the same article that this one follows. */
  after: string | null;
  /** The record holds the fence. */
  fenced: boolean;
  /** The first write of the record; true once it is on the device. */
  saving: Promise<boolean> | null;
  /** The write of the fence fixed once the earlier change settled; true while the record is there. */
  fencing: Promise<boolean> | null;
  /** When the record became durable, counted on the store's own clock (see `OfflineControl.mark`). */
  durableAt: number | null;
  /** The send in progress. */
  running: Promise<void> | null;
  /** The request is being made, so no other tab can be sending this record. */
  transmitting: boolean;
  /** How another tab says the record ended, heard before this tab sent it. */
  elsewhere: SettledNote | null;
  /** When it settled, for the store to let go of it. */
  settledAt: number | null;
}

interface BulkOverlay {
  readonly kind: 'bulk';
  readonly apply: (state: ReaderState) => ReaderState;
  /** Called when it may have reached the head of one of its articles' queues. */
  readonly onHead: () => void;
  /** Called when a change in front of it waits for a replay, which may be far off. */
  readonly refuse: () => void;
}

interface Slot {
  known: ReaderState;
  /** The unsettled changes shown on top of `known`, in the order they were made. */
  entries: (ActionEntry | BulkOverlay)[];
  /** Changes whenever what `view` returns for this article can change. */
  rev: number;
}

interface BulkProbe {
  readonly id: string;
  readonly slot: Slot;
  readonly known: ReaderState;
}

function pickReader(source: ReaderState): ReaderState {
  return Object.fromEntries(READER_FIELDS.map((field) => [field, source[field]])) as ReaderState;
}

function isNewer(a: ReaderState, b: ReaderState): boolean {
  const byVersion = compareBigIntStrings(a.stateVersion, b.stateVersion);
  return (
    byVersion > 0 ||
    (byVersion === 0 && compareBigIntStrings(a.contentRevision, b.contentRevision) > 0)
  );
}

function applyAction(
  state: ReaderState,
  action: ReaderAction,
  stamp: string,
  markRead: boolean,
): ReaderState {
  switch (action.type) {
    case 'read':
    case 'open':
      return state.readAt === null ? { ...state, readAt: stamp } : state;
    case 'unread':
      return { ...state, readAt: null, archivedAt: null };
    case 'unhide':
      return { ...state, archivedAt: null };
    case 'rate':
      return {
        ...state,
        rating: action.rating,
        reason: action.rating === -1 ? (action.reason ?? null) : null,
        readAt: action.rating !== null && markRead ? (state.readAt ?? stamp) : state.readAt,
        archivedAt: action.hide === true ? (state.archivedAt ?? stamp) : state.archivedAt,
      };
    case 'promptAnswer':
      return { ...state, rating: action.liked ? 1 : -1, reason: null };
    case 'bookmark':
      return { ...state, bookmarkedAt: state.bookmarkedAt ?? stamp };
    case 'unbookmark':
      return { ...state, bookmarkedAt: null };
    case 'addLabel':
      return state.labelIds.includes(action.labelId)
        ? state
        : { ...state, labelIds: [...state.labelIds, action.labelId] };
    case 'removeLabel':
      return { ...state, labelIds: state.labelIds.filter((id) => id !== action.labelId) };
    case 'retryCapture':
      return state.bookmarkCapture === null
        ? state
        : { ...state, bookmarkCapture: { ...state.bookmarkCapture, status: 'pending' } };
    case 'dwell':
      return state;
  }
}

function fenceFor(known: ReaderState, snapshot: DispatchOptions['snapshot']): Fence {
  return snapshot === undefined
    ? { stateVersion: known.stateVersion, contentRevision: known.contentRevision }
    : {
        stateVersion: known.stateVersion,
        contentRevision: snapshot.contentRevision,
        snapshotId: snapshot.id,
      };
}

function analysisRequestIdOf(action: ReaderAction): string | undefined {
  return action.type === 'rate' || action.type === 'promptAnswer'
    ? action.analysisRequestId
    : undefined;
}

function withoutRequestId(action: ReaderAction): ReaderAction {
  if (action.type !== 'rate' && action.type !== 'promptAnswer') return action;
  const { analysisRequestId: _dropped, ...rest } = action;
  return rest;
}

function toApiError(error: unknown): ApiError {
  return isApiError(error)
    ? error
    : new ApiError({
        kind: 'network',
        status: null,
        code: 'NETWORK',
        message: 'The request failed.',
        cause: error,
      });
}

/** `eligible`: the change would have waited on the device had the account chosen offline reading. */
function offlineRefusal(eligible: boolean): ApiError {
  return new ApiError({
    kind: 'network',
    status: null,
    code: OFFLINE_ERROR_CODE,
    message: 'The change needs a connection.',
    details: { eligible },
  });
}

function unsentFailure(): ApiError {
  return new ApiError({
    kind: 'network',
    status: null,
    code: 'NETWORK',
    message: 'The change could not be sent.',
  });
}

const isStale = (error: ApiError): boolean =>
  error.kind === 'http' && error.status === 409 && error.code === 'STALE_STATE';

const isUnauthorized = (error: ApiError): boolean => error.kind === 'http' && error.status === 401;

const isConflict = (error: ApiError, reason: string): boolean =>
  error.kind === 'http' &&
  error.status === 409 &&
  error.code === 'CONFLICT' &&
  error.reason === reason;

function refusalOf(error: ApiError): Refusal | undefined {
  if (error.kind === 'http' && error.status === 404) return 'unknown';
  return (['not_undoable', 'already_undone', 'expired'] as const).find((reason) =>
    isConflict(error, reason),
  );
}

function detailItem(error: ApiError): ArticleListItem | null {
  const parsed = NullableItemSchema.safeParse(error.details?.['item']);
  return parsed.success ? parsed.data : null;
}

function detailItems(error: ApiError): ArticleListItem[] {
  const parsed = ItemsSchema.safeParse(error.details?.['items']);
  return parsed.success ? parsed.data : [];
}

/** The records in the order they were made, each after the record it follows. */
function inOrder(records: readonly QueueRecord[]): QueueRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const sorted = [...records].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ordered: QueueRecord[] = [];
  const placed = new Set<string>();
  const place = (record: QueueRecord): void => {
    if (placed.has(record.id)) return;
    placed.add(record.id);
    const predecessor = record.after === null ? undefined : byId.get(record.after);
    if (predecessor !== undefined) place(predecessor);
    ordered.push(record);
  };
  sorted.forEach(place);
  return ordered;
}

export function createReaderActions(options: ReaderActionsOptions): ReaderActions {
  const { transport, preferences, onSettled } = options;
  const queue: ActionQueue | null = options.queue ?? null;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? ((attempt: number) => 500 * 2 ** (attempt - 1));

  const slots = new Map<string, Slot>();
  const actions = new Map<string, ActionEntry>();
  const listeners = new Set<() => void>();
  const inflight = new Set<AbortController>();
  const sleepers = new Set<() => void>();
  /** Bulk actions waiting for their turn; a reset lets them go. */
  const waiting = new Set<() => void>();
  const views = new WeakMap<
    ArticleListItem,
    { slot: Slot; rev: number; result: ArticleListItem }
  >();
  const waitingChanges: {
    version: number;
    all: readonly ActionHandle[];
    byArticle: Map<string, readonly ActionHandle[]>;
  } = { version: -1, all: [], byArticle: new Map() };
  let recents: RecentAction[] = [];
  let version = 0;
  let generation = 0;
  let durable = 0;
  /** Every write to the queue store goes through here, so that they happen in the order asked. */
  let disk: Promise<unknown> = Promise.resolve();
  let stopHearing: (() => void) | null = null;

  const online = (): boolean => queue === null || queue.online();
  const canWaitOnceChosen = (action: ReaderAction): boolean =>
    OFFLINE.has(action.type) && queue?.enabled() !== true;

  function port(): ActionQueue {
    if (queue === null) throw new Error('No queue store was given');
    return queue;
  }

  function write<T>(job: () => Promise<T>): Promise<T> {
    const next = disk.then(job, job);
    disk = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function bump(): void {
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function learn(id: string, state: ReaderState): boolean {
    const slot = slots.get(id);
    if (slot === undefined) {
      slots.set(id, { known: pickReader(state), entries: [], rev: 0 });
      return true;
    }
    if (!isNewer(state, slot.known)) return false;
    slot.known = pickReader(state);
    slot.rev += 1;
    return true;
  }

  function slotOf(id: string): Slot {
    const slot = slots.get(id);
    if (slot === undefined) throw new Error(`No reader state is known for article ${id}`);
    return slot;
  }

  function adopt(rows: readonly ArticleListItem[]): void {
    for (const row of rows) learn(row.id, row);
  }

  function shown(state: ReaderState, entry: ActionEntry | BulkOverlay): ReaderState {
    return entry.kind === 'bulk'
      ? entry.apply(state)
      : applyAction(state, entry.handle.action, entry.stamp, entry.markRead);
  }

  function view<T extends ArticleListItem>(item: T): T {
    const slot = slots.get(item.id);
    if (slot === undefined) return item;
    const knownIsNewer = isNewer(slot.known, item);
    if (!knownIsNewer && slot.entries.length === 0) return item;
    const cached = views.get(item);
    if (cached !== undefined && cached.slot === slot && cached.rev === slot.rev) {
      return cached.result as T;
    }
    const state = slot.entries.reduce(shown, knownIsNewer ? slot.known : pickReader(item));
    const result = { ...item, ...state };
    views.set(item, { slot, rev: slot.rev, result });
    return result;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  function waitBefore(error: unknown, retry: number): number | null {
    if (!isApiError(error) || error.retryAfterMs === null) return backoffMs(retry);
    return error.retryAfterMs > MAX_RETRY_AFTER_MS ? null : error.retryAfterMs;
  }

  async function attempt<T>(epoch: number, call: () => Promise<T>): Promise<T> {
    for (let retry = 1; ; retry += 1) {
      try {
        return await call();
      } catch (error) {
        if (epoch !== generation || retry > maxRetries || !isRetryable(error) || !online()) {
          throw error;
        }
        const wait = waitBefore(error, retry);
        if (wait === null) throw error;
        await sleep(wait);
        if (epoch !== generation) throw error;
      }
    }
  }

  async function request<T>(
    epoch: number,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<Outcome<T>> {
    const controller = new AbortController();
    inflight.add(controller);
    try {
      return { ok: true, value: await attempt(epoch, () => call(controller.signal)) };
    } catch (error) {
      return { ok: false, error: toApiError(error) };
    } finally {
      inflight.delete(controller);
    }
  }

  function addRecent(entry: RecentAction): void {
    recents = [...recents, entry];
  }

  function noteOf(entry: ActionEntry, result: ActionResult): SettledNote {
    const { id } = entry.handle;
    switch (result.status) {
      case 'done':
        return { id, outcome: 'done', item: result.item, mutationId: result.mutationId };
      case 'stale':
        return { id, outcome: 'stale', item: result.item };
      case 'failed':
        return { id, outcome: 'failed', status: result.error.status, code: result.error.code };
      case 'cancelled':
        return { id, outcome: 'cancelled' };
    }
  }

  function recordOf(entry: ActionEntry, before: ReaderState): QueueRecord {
    const { handle } = entry;
    return {
      schema: 1,
      id: handle.id,
      key: entry.key,
      accountId: port().accountId,
      articleId: handle.articleId,
      action: handle.action,
      fence: entry.fence,
      after: entry.after,
      before,
      createdAt: handle.createdAt,
      stamp: entry.stamp,
      markRead: entry.markRead,
      ...(entry.snapshot === undefined ? {} : { snapshot: entry.snapshot }),
      state: 'pending',
      attempts: 0,
      nextAttemptAt: handle.createdAt,
    };
  }

  function hear(): void {
    if (queue === null || stopHearing !== null) return;
    stopHearing = queue.hear(onNote);
  }

  /**
   * Keeps the change on the device when the account chose offline reading and the change may wait
   * for a connection (spec 09 §1): the record exists before the first request of the change, and
   * carries the fence of the state acted on, or the change it follows.
   */
  function persist(slot: Slot, entry: ActionEntry): void {
    if (queue === null || !OFFLINE.has(entry.handle.action.type) || !queue.enabled()) return;
    const index = slot.entries.indexOf(entry);
    const earlier = slot.entries.slice(0, index);
    const predecessor = earlier.findLast((other) => other.kind === 'action' && other.stored);
    entry.after = predecessor?.kind === 'action' ? predecessor.handle.id : null;
    if (index === 0) entry.fence ??= fenceFor(slot.known, entry.snapshot);
    entry.fenced = entry.fence !== null;
    entry.fencing = null;
    entry.elsewhere = null;
    entry.before = earlier.reduce(shown, slot.known);
    entry.stored = true;
    hear();
    const record = recordOf(entry, entry.before);
    entry.saving = write(() => queue.save(record)).then((saved) => {
      if (saved) {
        durable += 1;
        entry.durableAt = durable;
      }
      return saved;
    });
  }

  /**
   * Fixes the fence of a kept change that followed another one, from the state the server
   * acknowledged for that one, and writes it to the record. False when the record is gone.
   */
  function fixFence(slot: Slot, entry: ActionEntry): Promise<boolean> {
    if (entry.fenced) return Promise.resolve(true);
    entry.fencing ??= (async () => {
      const fence = (entry.fence ??= fenceFor(slot.known, entry.snapshot));
      const kept = await write(() => port().change(entry.handle.id, { fence }));
      if (kept) entry.fenced = true;
      return kept;
    })();
    return entry.fencing;
  }

  /** Removes the record of a settled change and tells the account's other tabs how it ended. */
  function retire(entry: ActionEntry, result: ActionResult): void {
    if (!entry.stored) return;
    entry.stored = false;
    const note = noteOf(entry, result);
    void write(async () => {
      await port().remove(entry.handle.id);
      port().announce(note);
    });
  }

  function settle(slot: Slot, entry: ActionEntry, result: ActionResult): void {
    slot.entries = slot.entries.filter((candidate) => candidate !== entry);
    slot.rev += 1;
    entry.handle.status = result.status;
    entry.settledAt = now();
    const next = slot.entries[0];
    if (next?.kind === 'action' && next.stored && next.handle.status !== 'held') {
      void fixFence(slot, next);
    }
    retire(entry, result);
    pump(slot);
    bump();
    entry.resolve(result);
    onSettled?.(entry.handle, result);
  }

  /** The change did not go through and neither does anything made on top of it. */
  function drop(
    slot: Slot,
    entry: ActionEntry,
    result: Extract<ActionResult, { status: 'stale' | 'failed' }>,
  ): void {
    if (entry.stored && entry.handle.replayed) {
      const later = slot.entries.slice(slot.entries.indexOf(entry) + 1).reverse();
      for (const other of later) {
        if (other.kind === 'action' && other.stored) {
          settle(slot, other, { status: 'cancelled' });
        }
      }
    }
    settle(slot, entry, result);
  }

  /** The record is gone: another tab sent it, or it was discarded. */
  function settleElsewhere(
    slot: Slot,
    entry: ActionEntry,
    note: SettledNote | null = entry.elsewhere,
  ): void {
    entry.stored = false;
    entry.handle.replayed = true;
    switch (note?.outcome) {
      case undefined:
      case 'cancelled':
        settle(slot, entry, { status: 'cancelled' });
        return;
      case 'done':
        learn(entry.handle.articleId, note.item);
        entry.handle.mutationId = note.mutationId;
        settle(slot, entry, {
          status: 'done',
          item: note.item,
          mutationId: note.mutationId,
          exampleSuggestion: null,
          prompt: false,
          droppedAnalysisRequestId: null,
        });
        return;
      case 'stale':
        if (note.item !== null) learn(entry.handle.articleId, note.item);
        settle(slot, entry, { status: 'stale', item: note.item });
        return;
      case 'failed':
        settle(slot, entry, {
          status: 'failed',
          error: new ApiError({
            kind: 'http',
            status: note.status,
            code: note.code,
            message: 'Another tab could not save the change.',
          }),
        });
        return;
    }
  }

  function onNote(note: SettledNote): void {
    const entry = actions.get(note.id);
    if (entry === undefined || !entry.stored) return;
    const slot = slots.get(entry.handle.articleId);
    if (slot === undefined) return;
    const { status } = entry.handle;
    if (status === 'waiting' || status === 'queued') settleElsewhere(slot, entry, note);
    else if (status === 'sending' && !entry.transmitting) entry.elsewhere = note;
  }

  function acknowledge(
    slot: Slot,
    entry: ActionEntry,
    fence: Fence,
    response: ActionResponse,
  ): void {
    const { handle } = entry;
    learn(handle.articleId, response.item);
    handle.mutationId = response.mutationId;
    const changed = compareBigIntStrings(response.item.stateVersion, fence.stateVersion) > 0;
    entry.undoable = changed && UNDOABLE.has(handle.action.type);
    if (entry.undoable) {
      addRecent({
        id: handle.id,
        kind: handle.action.type,
        articleIds: [handle.articleId],
        at: now(),
        mutationId: response.mutationId,
        ...(handle.action.type === 'rate' ? { rating: handle.action.rating } : {}),
      });
    }
    settle(slot, entry, {
      status: 'done',
      item: response.item,
      mutationId: response.mutationId,
      exampleSuggestion: handle.replayed ? null : (response.exampleSuggestion ?? null),
      prompt: handle.replayed ? false : (response.prompt ?? false),
      droppedAnalysisRequestId: entry.droppedRequestId,
    });
  }

  /** The server could not be reached: the change stays on the device, and shown, for a replay. */
  function park(slot: Slot, entry: ActionEntry): void {
    entry.handle.status = 'waiting';
    entry.handle.replayed = true;
    slot.rev += 1;
    const later = slot.entries.slice(slot.entries.indexOf(entry) + 1);
    for (const other of later) {
      if (other.kind === 'bulk') other.refuse();
      else if (!other.stored && other.handle.status === 'queued') {
        settle(slot, other, { status: 'failed', error: unsentFailure() });
      }
    }
    bump();
  }

  async function exchange(slot: Slot, entry: ActionEntry, epoch: number): Promise<void> {
    const { handle } = entry;
    if (entry.stored) {
      const present = await (entry.fenced
        ? write(() => port().change(handle.id, {}))
        : fixFence(slot, entry));
      if (epoch !== generation) return;
      if (!present || entry.elsewhere !== null) {
        settleElsewhere(slot, entry);
        return;
      }
      if (!online()) {
        park(slot, entry);
        return;
      }
    }

    const fence = (entry.fence ??= fenceFor(slot.known, entry.snapshot));
    const send = () =>
      request(epoch, (signal) =>
        transport.send(handle.articleId, handle.action, fence, entry.key, signal),
      );

    entry.transmitting = true;
    let outcome = await send();
    if (!outcome.ok && epoch === generation && isConflict(outcome.error, 'obsolete_request')) {
      const requestId = analysisRequestIdOf(handle.action);
      if (requestId !== undefined) {
        entry.droppedRequestId = requestId;
        handle.action = withoutRequestId(handle.action);
        entry.key = newId();
        const kept =
          !entry.stored ||
          (await write(() => port().change(handle.id, { key: entry.key, action: handle.action })));
        if (epoch !== generation) return;
        if (!kept) {
          entry.transmitting = false;
          settleElsewhere(slot, entry);
          return;
        }
        outcome = await send();
      }
    }
    entry.transmitting = false;
    if (epoch !== generation) return;

    if (outcome.ok) {
      acknowledge(slot, entry, fence, outcome.value);
    } else if (isStale(outcome.error)) {
      const item = detailItem(outcome.error);
      if (item !== null) learn(handle.articleId, item);
      drop(slot, entry, { status: 'stale', item });
    } else if (entry.stored && (isRetryable(outcome.error) || isUnauthorized(outcome.error))) {
      entry.sent = true;
      void write(() => port().change(handle.id, { sent: true }));
      park(slot, entry);
    } else {
      drop(slot, entry, { status: 'failed', error: outcome.error });
    }
  }

  async function run(slot: Slot, entry: ActionEntry): Promise<void> {
    const epoch = generation;
    const { handle } = entry;
    handle.status = 'sending';
    if (entry.stored && (await entry.saving) !== true) entry.stored = false;
    if (epoch !== generation) return;

    if (!online()) {
      if (entry.stored) park(slot, entry);
      else {
        settle(slot, entry, {
          status: 'failed',
          error: offlineRefusal(canWaitOnceChosen(handle.action)),
        });
      }
      return;
    }
    if (!entry.stored) {
      await exchange(slot, entry, epoch);
      return;
    }
    await port().hold(() => exchange(slot, entry, epoch));
  }

  function start(slot: Slot, entry: ActionEntry): void {
    const wasWaiting = entry.handle.status === 'waiting';
    const running = run(slot, entry).finally(() => {
      if (entry.running === running) entry.running = null;
    });
    entry.running = running;
    if (wasWaiting) bump();
  }

  // Bulk actions take their place in the queue of every article they cover.
  function pump(slot: Slot): void {
    const head = slot.entries[0];
    if (head?.kind === 'bulk') head.onHead();
    else if (head?.handle.status === 'queued') start(slot, head);
  }

  /** A change that cannot be kept on the device fails at once when it cannot be sent either. */
  function refuseUnsendable(slot: Slot, entry: ActionEntry): boolean {
    if (queue === null || entry.stored) return false;
    if (!online()) {
      settle(slot, entry, {
        status: 'failed',
        error: offlineRefusal(canWaitOnceChosen(entry.handle.action)),
      });
      return true;
    }
    const blocked = slot.entries.some(
      (other) => other.kind === 'action' && other.handle.status === 'waiting',
    );
    if (!blocked) return false;
    settle(slot, entry, { status: 'failed', error: unsentFailure() });
    return true;
  }

  /** Lets go of what can no longer be undone and of what cannot be undone at all. */
  function sweep(): void {
    const cutoff = now() - UNDO_WINDOW_MS;
    for (const [id, entry] of actions) {
      if (entry.settledAt === null) continue;
      const kept = entry.handle.status === 'failed' || entry.undoable;
      if (entry.settledAt <= cutoff || !kept) actions.delete(id);
    }
    if (recents.some((recent) => recent.at <= cutoff)) {
      recents = recents.filter((recent) => recent.at > cutoff);
    }
  }

  function dispatch(
    item: ArticleListItem,
    action: ReaderAction,
    dispatchOptions: DispatchOptions = {},
  ): ActionHandle {
    sweep();
    learn(item.id, item);
    const slot = slotOf(item.id);
    const id = newId();
    const createdAt = now();
    let resolve!: (result: ActionResult) => void;
    const result = new Promise<ActionResult>((settled) => {
      resolve = settled;
    });
    const entry: ActionEntry = {
      kind: 'action',
      handle: {
        id,
        articleId: item.id,
        action,
        status: dispatchOptions.hold === true ? 'held' : 'queued',
        mutationId: null,
        createdAt,
        replayed: dispatchOptions.replayed === true,
        result,
      },
      stamp: new Date(createdAt).toISOString(),
      markRead: preferences().markReadOnRate,
      snapshot: dispatchOptions.snapshot,
      fence: null,
      key: id,
      resolve,
      droppedRequestId: null,
      undoable: false,
      before: null,
      stored: false,
      sent: false,
      after: null,
      fenced: false,
      saving: null,
      fencing: null,
      durableAt: null,
      running: null,
      transmitting: false,
      elsewhere: null,
      settledAt: null,
    };
    actions.set(id, entry);
    slot.entries.push(entry);
    slot.rev += 1;
    if (dispatchOptions.hold !== true) {
      persist(slot, entry);
      if (refuseUnsendable(slot, entry)) return entry.handle;
    }
    pump(slot);
    bump();
    return entry.handle;
  }

  function release(actionId: string, patch?: { reason?: RatingReason; hide?: boolean }): void {
    const entry = actions.get(actionId);
    if (entry === undefined || entry.handle.status !== 'held') return;
    const { action } = entry.handle;
    if (action.type === 'rate' && patch !== undefined) {
      entry.handle.action = {
        ...action,
        ...(patch.reason !== undefined && action.rating === -1 ? { reason: patch.reason } : {}),
        ...(patch.hide !== undefined ? { hide: patch.hide } : {}),
      };
    }
    entry.handle.status = 'queued';
    const slot = slotOf(entry.handle.articleId);
    slot.rev += 1;
    persist(slot, entry);
    if (refuseUnsendable(slot, entry)) return;
    pump(slot);
    bump();
  }

  /**
   * What a kept change leaves to the ones behind it when it is cancelled: they follow what it
   * followed, and the one that becomes the head acts on the state it acted on.
   */
  function handOver(slot: Slot, entry: ActionEntry): void {
    const index = slot.entries.indexOf(entry);
    const behind = slot.entries.slice(index + 1);
    for (const other of behind) {
      if (other.kind !== 'action' || !other.stored || other.after !== entry.handle.id) continue;
      other.after = entry.after;
      void write(() => port().change(other.handle.id, { after: entry.after }));
    }
    const next = behind[0];
    if (index === 0 && next?.kind === 'action' && next.stored && !next.fenced) {
      next.fence ??= entry.fence;
    }
  }

  function cancel(actionId: string): boolean {
    const entry = actions.get(actionId);
    if (entry === undefined) return false;
    const { status } = entry.handle;
    const neverSent = status === 'waiting' && !entry.sent;
    if (status !== 'held' && status !== 'queued' && !neverSent) return false;
    const slot = slotOf(entry.handle.articleId);
    if (entry.stored) handOver(slot, entry);
    settle(slot, entry, { status: 'cancelled' });
    return true;
  }

  function retry(actionId: string): ActionHandle | null {
    const entry = actions.get(actionId);
    if (entry === undefined || entry.handle.status !== 'failed') return null;
    const result = new Promise<ActionResult>((resolve) => {
      entry.resolve = resolve;
    });
    entry.handle = { ...entry.handle, status: 'queued', result };
    entry.settledAt = null;
    const slot = slotOf(entry.handle.articleId);
    slot.entries.push(entry);
    slot.rev += 1;
    persist(slot, entry);
    if (refuseUnsendable(slot, entry)) return entry.handle;
    pump(slot);
    bump();
    return entry.handle;
  }

  async function requestUndo(mutationId: string, receiptId: string): Promise<UndoResult> {
    const epoch = generation;
    const key = newId();
    const outcome = await request(epoch, (signal) => transport.undo(mutationId, key, signal));
    if (outcome.ok) {
      if (epoch === generation) {
        adopt(outcome.value.items);
        recents = recents.filter((recent) => recent.id !== receiptId);
        bump();
      }
      return { status: 'undone', items: outcome.value.items };
    }
    const { error } = outcome;
    if (epoch !== generation) return { status: 'failed', error };
    if (isStale(error)) {
      const rows = detailItems(error);
      adopt(rows);
      recents = recents.filter((recent) => recent.id !== receiptId);
      bump();
      return { status: 'conflict', items: rows };
    }
    const reason = refusalOf(error);
    if (reason === undefined) return { status: 'failed', error };
    recents = recents.filter((recent) => recent.id !== receiptId);
    bump();
    return { status: 'refused', reason };
  }

  async function undo(actionId: string): Promise<UndoResult> {
    const entry = actions.get(actionId);
    if (entry === undefined) {
      const listed = recents.find((recent) => recent.id === actionId);
      if (listed === undefined) return { status: 'refused', reason: 'unknown' };
      return requestUndo(listed.mutationId, actionId);
    }
    if (cancel(actionId)) return { status: 'cancelled' };
    const result = await entry.handle.result;
    if (result.status === 'cancelled') return { status: 'cancelled' };
    if (result.status !== 'done') return { status: 'refused', reason: 'unknown' };
    if (!entry.undoable) return { status: 'refused', reason: 'not_undoable' };
    return requestUndo(result.mutationId, actionId);
  }

  async function bulk(input: BulkInput): Promise<BulkResult> {
    const limit =
      input.kind === 'markRead'
        ? MAX_MARK_READ_TARGETS
        : input.kind === 'rateBulk'
          ? MAX_RATE_BULK_TARGETS
          : Infinity;
    if (input.items.length > limit) {
      throw new RangeError(`A ${input.kind} bulk takes at most ${limit} items`);
    }

    sweep();
    // It would wait for changes that wait for a replay, which may be a long time away.
    const blocked = input.items.some((item) =>
      slots
        .get(item.id)
        ?.entries.some((other) => other.kind === 'action' && other.handle.status === 'waiting'),
    );
    if (queue !== null && blocked) return { status: 'failed', error: offlineRefusal(false) };

    const epoch = generation;
    const id = newId();
    const stamp = new Date(now()).toISOString();
    const markRead = preferences().markReadOnRate;
    const covered: { id: string; slot: Slot }[] = [];
    let reachHead!: () => void;
    let refused = false;
    const turn = new Promise<void>((resolve) => {
      reachHead = resolve;
    });
    const overlay: BulkOverlay = {
      kind: 'bulk',
      apply: (state) =>
        input.kind === 'rateBulk'
          ? applyAction(state, { type: 'rate', rating: input.rating }, stamp, markRead)
          : applyAction(state, { type: 'read' }, stamp, markRead),
      onHead: () => {
        if (covered.every(({ slot }) => slot.entries[0] === overlay)) reachHead();
      },
      refuse: () => {
        refused = true;
        reachHead();
      },
    };
    for (const item of input.items) {
      learn(item.id, item);
      const slot = slotOf(item.id);
      slot.entries.push(overlay);
      slot.rev += 1;
      covered.push({ id: item.id, slot });
    }
    bump();

    // Sent once every earlier action on its articles has settled, so that its fences are current.
    waiting.add(reachHead);
    overlay.onHead();
    await turn;
    waiting.delete(reachHead);
    if (epoch !== generation) {
      return {
        status: 'failed',
        error: new ApiError({
          kind: 'aborted',
          status: null,
          code: 'ABORTED',
          message: 'The account was reset before the request was sent.',
        }),
      };
    }

    if (refused) {
      for (const { slot } of covered) {
        slot.entries = slot.entries.filter((candidate) => candidate !== overlay);
        slot.rev += 1;
      }
      for (const { slot } of covered) pump(slot);
      bump();
      return { status: 'failed', error: offlineRefusal(false) };
    }

    const probes: BulkProbe[] = covered.map(({ id: articleId, slot }) => ({
      id: articleId,
      slot,
      known: slot.known,
    }));
    const release = <R>(result: R): R => {
      for (const { slot } of probes) pump(slot);
      bump();
      return result;
    };

    const targets = probes.map(({ id: articleId, known }) => ({
      id: articleId,
      stateVersion: known.stateVersion,
      contentRevision: known.contentRevision,
    }));
    const outcome: Outcome<{ count: number; mutationId: string; items?: ArticleListItem[] }> =
      input.kind === 'rateBulk'
        ? await request(epoch, (signal) =>
            transport.rateBulk({ targets, rating: input.rating }, id, signal),
          )
        : await request(epoch, (signal) =>
            transport.markRead(
              input.kind === 'markRead'
                ? { targets }
                : { filter: input.filter, datasetVersion: input.datasetVersion },
              id,
              signal,
            ),
          );
    if (epoch !== generation) {
      return outcome.ok
        ? { status: 'done', mutationId: outcome.value.mutationId, count: outcome.value.count }
        : { status: 'failed', error: outcome.error };
    }

    for (const { slot } of probes) {
      slot.entries = slot.entries.filter((candidate) => candidate !== overlay);
      slot.rev += 1;
    }
    if (!outcome.ok) {
      const { error } = outcome;
      if (!isStale(error)) return release({ status: 'failed', error });
      const rows = detailItems(error);
      adopt(rows);
      return release({ status: 'stale', items: rows, reason: error.reason ?? null });
    }

    const { count, mutationId } = outcome.value;
    if (input.kind === 'rateBulk') {
      adopt(outcome.value.items ?? []);
    } else {
      for (const { id: articleId, known } of probes) {
        learn(
          articleId,
          known.readAt === null
            ? { ...known, readAt: stamp, stateVersion: nextRevision(known.stateVersion) }
            : known,
        );
      }
    }
    if (count > 0) {
      addRecent({
        id,
        kind: input.kind,
        articleIds: input.items.map((item) => item.id),
        at: now(),
        mutationId,
        count,
        ...(input.kind === 'rateBulk' ? { rating: input.rating } : {}),
      });
    }
    return release({ status: 'done', mutationId, count });
  }

  function recent(): readonly RecentAction[] {
    const cutoff = now() - UNDO_WINDOW_MS;
    if (recents.some((entry) => entry.at <= cutoff)) {
      recents = recents.filter((entry) => entry.at > cutoff);
    }
    return [...recents].reverse();
  }

  function restoreEntry(record: QueueRecord): void {
    learn(record.articleId, record.before);
    const slot = slotOf(record.articleId);
    let resolve!: (result: ActionResult) => void;
    const result = new Promise<ActionResult>((settled) => {
      resolve = settled;
    });
    let index = slot.entries.findIndex(
      (other) => other.kind === 'bulk' || other.handle.createdAt > record.createdAt,
    );
    if (index === -1) index = slot.entries.length;
    const head = slot.entries[0];
    if (index === 0 && head?.kind === 'action' && head.handle.status === 'sending') index = 1;
    const follows = slot.entries
      .slice(0, index)
      .some((other) => other.kind === 'action' && other.stored);
    const entry: ActionEntry = {
      kind: 'action',
      handle: {
        id: record.id,
        articleId: record.articleId,
        action: record.action,
        status: 'waiting',
        mutationId: null,
        createdAt: record.createdAt,
        replayed: true,
        result,
      },
      stamp: record.stamp,
      markRead: record.markRead,
      snapshot: record.snapshot,
      fence: record.fence ?? (follows ? null : fenceFor(record.before, record.snapshot)),
      key: record.key,
      resolve,
      droppedRequestId: null,
      undoable: false,
      before: record.before,
      stored: true,
      sent: record.sent === true,
      after: record.after,
      fenced: record.fence !== null,
      saving: Promise.resolve(true),
      fencing: null,
      durableAt: (durable += 1),
      running: null,
      transmitting: false,
      elsewhere: null,
      settledAt: null,
    };
    actions.set(record.id, entry);
    slot.entries.splice(index, 0, entry);
    slot.rev += 1;
  }

  function collectWaiting(): ActionHandle[] {
    const handles: ActionHandle[] = [];
    for (const slot of slots.values()) {
      let blocked = false;
      for (const entry of slot.entries) {
        if (entry.kind !== 'action' || !entry.stored) continue;
        const { status } = entry.handle;
        if (status === 'waiting') {
          blocked = true;
          handles.push(entry.handle);
        } else if (blocked && status === 'queued') {
          handles.push(entry.handle);
        }
      }
    }
    return handles.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Sends the head of the article's queue, and what follows it, until one of them has to wait. */
  async function advance(slot: Slot, epoch: number): Promise<void> {
    for (;;) {
      const head = slot.entries[0];
      if (epoch !== generation || head?.kind !== 'action') return;
      if (head.handle.status === 'waiting') start(slot, head);
      const running = head.running;
      if (running === null) return;
      await running;
      if (slot.entries[0] === head && head.handle.status === 'waiting') return;
    }
  }

  const offline: OfflineControl = {
    waiting(articleId) {
      if (waitingChanges.version !== version) {
        waitingChanges.version = version;
        waitingChanges.all = collectWaiting();
        waitingChanges.byArticle = new Map();
      }
      if (articleId === undefined) return waitingChanges.all;
      let list = waitingChanges.byArticle.get(articleId);
      if (list === undefined) {
        list = waitingChanges.all.filter((handle) => handle.articleId === articleId);
        waitingChanges.byArticle.set(articleId, list);
      }
      return list;
    },
    mark: () => durable,
    adopt(records, mark = -1) {
      if (queue === null) return;
      const listed = new Set(records.map((record) => record.id));
      let changed = false;
      for (const entry of [...actions.values()]) {
        const { status } = entry.handle;
        if (!entry.stored || entry.durableAt === null || entry.durableAt > mark) continue;
        if (listed.has(entry.handle.id) || (status !== 'waiting' && status !== 'queued')) continue;
        settleElsewhere(slotOf(entry.handle.articleId), entry, null);
        changed = true;
      }
      for (const record of inOrder(records)) {
        if (record.accountId !== queue.accountId || actions.has(record.id)) continue;
        restoreEntry(record);
        hear();
        changed = true;
      }
      if (changed) bump();
    },
    expire(cutoff) {
      let count = 0;
      for (const entry of [...actions.values()]) {
        const { status } = entry.handle;
        if (!entry.stored || entry.handle.createdAt > cutoff) continue;
        if (status !== 'waiting' && status !== 'queued') continue;
        settle(slotOf(entry.handle.articleId), entry, { status: 'cancelled' });
        count += 1;
      }
      return count;
    },
    async drain() {
      const epoch = generation;
      const heads: { slot: Slot; createdAt: number }[] = [];
      for (const slot of slots.values()) {
        const head = slot.entries[0];
        if (head?.kind === 'action' && head.stored && head.handle.status === 'waiting') {
          heads.push({ slot, createdAt: head.handle.createdAt });
        }
      }
      heads.sort((a, b) => a.createdAt - b.createdAt);
      for (const { slot } of heads) await advance(slot, epoch);
    },
  };

  function reset(): void {
    generation += 1;
    for (const controller of inflight) controller.abort();
    inflight.clear();
    for (const wake of [...sleepers]) wake();
    for (const go of [...waiting]) go();
    for (const slot of slots.values()) {
      for (const entry of slot.entries) {
        if (entry.kind === 'action') {
          entry.handle.status = 'cancelled';
          entry.resolve({ status: 'cancelled' });
        }
      }
    }
    slots.clear();
    actions.clear();
    recents = [];
    stopHearing?.();
    stopHearing = null;
    bump();
  }

  return {
    observe(rows) {
      sweep();
      let changed = false;
      for (const row of rows) changed = learn(row.id, row) || changed;
      if (changed) bump();
    },
    view,
    dispatch,
    release,
    cancel,
    retry,
    undo,
    bulk,
    recent,
    get: (actionId) => actions.get(actionId)?.handle,
    offline,
    retained: () => ({ actions: actions.size, recents: recents.length }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    reset,
  };
}
