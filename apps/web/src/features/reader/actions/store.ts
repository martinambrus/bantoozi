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
import {
  READER_FIELDS,
  UNDO_WINDOW_MS,
  UNDOABLE_ACTIONS,
  type ActionHandle,
  type ActionResponse,
  type ActionResult,
  type BulkInput,
  type BulkResult,
  type DispatchOptions,
  type Fence,
  type ReaderAction,
  type ReaderActions,
  type ReaderActionsOptions,
  type ReaderState,
  type RecentAction,
  type UndoResult,
} from './types.js';

const DEFAULT_MAX_RETRIES = 2;
/** A longer Retry-After is not waited out in the background; the request fails at once. */
const MAX_RETRY_AFTER_MS = 30_000;

const UNDOABLE = new Set<ReaderAction['type']>(UNDOABLE_ACTIONS);
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
}

interface BulkOverlay {
  readonly kind: 'bulk';
  readonly apply: (state: ReaderState) => ReaderState;
  /** Called when it may have reached the head of one of its articles' queues. */
  readonly onHead: () => void;
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

const isStale = (error: ApiError): boolean =>
  error.kind === 'http' && error.status === 409 && error.code === 'STALE_STATE';

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

export function createReaderActions(options: ReaderActionsOptions): ReaderActions {
  const { transport, preferences, onSettled } = options;
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
  let recents: RecentAction[] = [];
  let version = 0;
  let generation = 0;

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
        if (epoch !== generation || retry > maxRetries || !isRetryable(error)) throw error;
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

  function settle(slot: Slot, entry: ActionEntry, result: ActionResult): void {
    slot.entries = slot.entries.filter((candidate) => candidate !== entry);
    slot.rev += 1;
    entry.handle.status = result.status;
    pump(slot);
    bump();
    entry.resolve(result);
    onSettled?.(entry.handle, result);
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
      prompt: response.prompt ?? false,
      droppedAnalysisRequestId: entry.droppedRequestId,
    });
  }

  async function run(slot: Slot, entry: ActionEntry): Promise<void> {
    const epoch = generation;
    const { handle } = entry;
    handle.status = 'sending';
    const fence = (entry.fence ??= fenceFor(slot.known, entry.snapshot));
    const send = () =>
      request(epoch, (signal) =>
        transport.send(handle.articleId, handle.action, fence, entry.key, signal),
      );

    let outcome = await send();
    if (!outcome.ok && epoch === generation && isConflict(outcome.error, 'obsolete_request')) {
      const requestId = analysisRequestIdOf(handle.action);
      if (requestId !== undefined) {
        entry.droppedRequestId = requestId;
        handle.action = withoutRequestId(handle.action);
        entry.key = newId();
        outcome = await send();
      }
    }
    if (epoch !== generation) return;

    if (outcome.ok) {
      acknowledge(slot, entry, fence, outcome.value);
    } else if (isStale(outcome.error)) {
      const item = detailItem(outcome.error);
      if (item !== null) learn(handle.articleId, item);
      settle(slot, entry, { status: 'stale', item });
    } else {
      settle(slot, entry, { status: 'failed', error: outcome.error });
    }
  }

  // Bulk actions take their place in the queue of every article they cover.
  function pump(slot: Slot): void {
    const head = slot.entries[0];
    if (head?.kind === 'bulk') head.onHead();
    else if (head?.handle.status === 'queued') void run(slot, head);
  }

  function dispatch(
    item: ArticleListItem,
    action: ReaderAction,
    dispatchOptions: DispatchOptions = {},
  ): ActionHandle {
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
    };
    actions.set(id, entry);
    slot.entries.push(entry);
    slot.rev += 1;
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
    pump(slot);
    bump();
  }

  function cancel(actionId: string): boolean {
    const entry = actions.get(actionId);
    if (entry === undefined) return false;
    if (entry.handle.status !== 'held' && entry.handle.status !== 'queued') return false;
    settle(slotOf(entry.handle.articleId), entry, { status: 'cancelled' });
    return true;
  }

  function retry(actionId: string): ActionHandle | null {
    const entry = actions.get(actionId);
    if (entry === undefined || entry.handle.status !== 'failed') return null;
    const result = new Promise<ActionResult>((resolve) => {
      entry.resolve = resolve;
    });
    entry.handle = { ...entry.handle, status: 'queued', result };
    const slot = slotOf(entry.handle.articleId);
    slot.entries.push(entry);
    slot.rev += 1;
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
    if (entry.handle.status === 'held' || entry.handle.status === 'queued') {
      cancel(actionId);
      return { status: 'cancelled' };
    }
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

    const epoch = generation;
    const id = newId();
    const stamp = new Date(now()).toISOString();
    const markRead = preferences().markReadOnRate;
    const covered: { id: string; slot: Slot }[] = [];
    let reachHead!: () => void;
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
    bump();
  }

  return {
    observe(rows) {
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
