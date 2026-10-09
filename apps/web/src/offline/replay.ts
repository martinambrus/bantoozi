import { ArticleListItemSchema } from '@bantoozi/shared';

import type { ActionQueue, OfflineControl, SettledNote } from '../features/reader/actions/types.js';
import { saveReaderStates } from './cache.js';
import { isOfflineEnabled } from './device.js';
import { LIMITS } from './names.js';
import {
  deleteRecord,
  listRecords,
  patchRecord,
  putRecord,
  setRecordsState,
  type QueueRecord,
} from './queue.js';

/** The Web Lock that the one tab holds while it sends kept records (spec 09 §1). */
export const REPLAY_LOCK = 'bantoozi:replay';
/** Where the tabs of an account tell each other which records are settled. */
export const OFFLINE_CHANNEL = 'bantoozi:offline';
/** A window event that asks the page to replay now, as Background Sync or a test does. */
export const REPLAY_EVENT = 'bantoozi:replay';

export function requestReplay(): void {
  window.dispatchEvent(new CustomEvent(REPLAY_EVENT));
}

/** Records made at or before this moment are 24 hours old by `now` and are never sent (spec 08 §1.1). */
export function expiryCutoff(now: number): number {
  return now - LIMITS.ttlMs;
}

export type Held<T> = { held: true; value: T } | { held: false };

export interface DispatchLock {
  /** Runs `work` while this tab holds the lock, waiting for it. */
  hold<T>(work: () => Promise<T>): Promise<T>;
  /** As `hold`, but does nothing when another tab holds the lock. */
  tryHold<T>(work: () => Promise<T>): Promise<Held<T>>;
}

type Grant = 'held' | 'declined' | 'unavailable';

/**
 * The lock that makes one tab the one that sends kept records (spec 09 §1). A tab that holds it,
 * or has asked for it, lets its own other work join: a replay and the sends it causes share one
 * hold instead of waiting for each other. Without Web Locks the page is taken to be the only tab.
 */
export function createDispatchLock(locks: Pick<LockManager, 'request'> | undefined): DispatchLock {
  if (locks === undefined) {
    return {
      hold: (work) => work(),
      tryHold: async (work) => ({ held: true, value: await work() }),
    };
  }

  const manager = locks;
  let users = 0;
  let lease: Promise<Grant> | null = null;
  let letGo: (() => void) | null = null;

  function acquire(ifAvailable: boolean): Promise<Grant> {
    if (lease !== null) return lease;
    let resolve!: (grant: Grant) => void;
    const attempt = new Promise<Grant>((settled) => {
      resolve = settled;
    });
    lease = attempt;
    const forget = () => {
      if (lease === attempt) lease = null;
    };
    const onLock = (lock: Lock | null): Promise<void> | undefined => {
      if (lock === null) {
        forget();
        resolve('declined');
        return undefined;
      }
      return new Promise<void>((release) => {
        letGo = release;
        resolve('held');
      });
    };
    try {
      manager.request(REPLAY_LOCK, ifAvailable ? { ifAvailable: true } : {}, onLock).catch(() => {
        forget();
        resolve('unavailable');
      });
    } catch {
      forget();
      resolve('unavailable');
    }
    return attempt;
  }

  async function holding<T>(ifAvailable: boolean, work: () => Promise<T>): Promise<Held<T>> {
    users += 1;
    try {
      for (;;) {
        const grant = await acquire(ifAvailable);
        if (grant === 'held' || grant === 'unavailable') break;
        if (ifAvailable) return { held: false };
      }
      return { held: true, value: await work() };
    } finally {
      users -= 1;
      if (users === 0) {
        const release = letGo;
        lease = null;
        letGo = null;
        release?.();
      }
    }
  }

  return {
    async hold(work) {
      const result = await holding(false, work);
      return result.held ? result.value : work();
    },
    tryHold: (work) => holding(true, work),
  };
}

function noteFrom(data: unknown, accountId: string): SettledNote | null {
  if (typeof data !== 'object' || data === null) return null;
  const { accountId: owner, note } = data as { accountId?: unknown; note?: unknown };
  if (owner !== accountId || typeof note !== 'object' || note === null) return null;
  const fields = note as Record<string, unknown>;
  const id = fields['id'];
  if (typeof id !== 'string') return null;
  switch (fields['outcome']) {
    case 'done': {
      const item = ArticleListItemSchema.safeParse(fields['item']);
      const mutationId = fields['mutationId'];
      return item.success && typeof mutationId === 'string'
        ? { id, outcome: 'done', item: item.data, mutationId }
        : null;
    }
    case 'stale': {
      const item = ArticleListItemSchema.nullable().safeParse(fields['item']);
      return item.success ? { id, outcome: 'stale', item: item.data } : null;
    }
    case 'failed': {
      const { status, code } = fields;
      return (typeof status === 'number' || status === null) && typeof code === 'string'
        ? { id, outcome: 'failed', status, code }
        : null;
    }
    case 'cancelled':
      return { id, outcome: 'cancelled' };
    default:
      return null;
  }
}

export interface ReplayQueue extends ActionQueue {
  /** The account's records, the earliest made first. */
  list(): Promise<QueueRecord[]>;
  /** Puts every record of the account in `state`. */
  setState(state: QueueRecord['state']): Promise<void>;
  tryHold<T>(work: () => Promise<T>): Promise<Held<T>>;
  /** Stops listening to the other tabs; hearing them again starts it again. */
  close(): void;
}

export interface ActionQueueOptions {
  accountId: string;
  /** Defaults to `navigator.locks`. */
  locks?: Pick<LockManager, 'request'> | undefined;
  /** Defaults to `navigator.onLine`. */
  online?: (() => boolean) | undefined;
}

/** The queue store of one account on this device, and the tab's place among the tabs that use it. */
export function createActionQueue(options: ActionQueueOptions): ReplayQueue {
  const { accountId } = options;
  const lock = createDispatchLock(
    options.locks ??
      (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined),
  );
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const listeners = new Set<(note: SettledNote) => void>();
  let channel: BroadcastChannel | null = null;

  function open(): BroadcastChannel | null {
    if (channel !== null) return channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    channel = new BroadcastChannel(OFFLINE_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const note = noteFrom(event.data, accountId);
      if (note !== null) for (const listener of [...listeners]) listener(note);
    };
    return channel;
  }

  return {
    accountId,
    enabled: () => isOfflineEnabled(accountId),
    online,
    save: (record) => putRecord(record),
    change: (id, patch) => patchRecord(accountId, id, patch),
    remove: (id) => deleteRecord(accountId, id),
    saveStates: (states) => saveReaderStates(accountId, states),
    announce(note) {
      channel?.postMessage({ accountId, note });
    },
    hear(listener) {
      open();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hold: lock.hold,
    tryHold: lock.tryHold,
    list: () => listRecords(accountId),
    async setState(state) {
      await setRecordsState(accountId, state);
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}

/**
 * How the account the server answers for compares with the one the records belong to: the same
 * (`same`), another (`other`), none because the session ended (`unauthorized`), or the check could
 * not be made (`unreachable`).
 */
export type AccountCheck = 'same' | 'other' | 'unauthorized' | 'unreachable';

export interface ReplayerOptions {
  queue: ReplayQueue;
  target: OfflineControl;
  /** Asks the server, fresh, who is signed in (`GET /me`). */
  verify: () => Promise<AccountCheck>;
  /** Called once per replay that dropped changes for being 24 hours old. */
  onExpired: (count: number) => void;
  /** Changes when the page lets go of the account: a replay that began before is not carried on. */
  epoch?: () => number;
  now?: () => number;
}

export interface Replayer {
  /** Shows the account's kept changes in the store; needs no connection. */
  restore(): Promise<void>;
  /**
   * One replay (spec 09 §1). A replay that is already running makes this call return at once.
   * Without a connection nothing is sent; while the store shows kept changes it only makes them
   * agree with the records that remain.
   */
  run(): Promise<void>;
}

/**
 * The foreground replay of the changes an account kept on the device: nothing while offline, nothing
 * unless the server confirms the account the changes belong to, nothing from a tab that is not the
 * sending one, and nothing older than 24 hours.
 */
export function createReplayer(options: ReplayerOptions): Replayer {
  const { queue, target, verify, onExpired } = options;
  const now = options.now ?? (() => Date.now());
  const epoch = options.epoch ?? (() => 0);
  let running = false;

  async function restore(): Promise<void> {
    const began = epoch();
    const mark = target.mark();
    const records = await queue.list();
    if (epoch() === began) target.adopt(records, mark);
  }

  async function replay(): Promise<void> {
    const began = epoch();
    const mark = target.mark();
    const records = await queue.list();
    if (epoch() !== began) return;
    if (records.length === 0 || !queue.online()) {
      target.adopt(records, mark);
      return;
    }
    const account = await verify();
    if (account === 'unauthorized') {
      await queue.setState('frozen');
      return;
    }
    if (account !== 'same' || epoch() !== began) return;
    await queue.setState('pending');
    if (epoch() !== began) return;
    target.adopt(records, mark);
    const expired = target.expire(expiryCutoff(now()));
    if (expired > 0) onExpired(expired);
    await target.drain();
  }

  async function run(): Promise<void> {
    if (running) return;
    if (!queue.online()) {
      // Nothing is sent without a connection, but changes shown here may have been discarded since.
      if (target.waiting().length > 0) await restore();
      return;
    }
    running = true;
    try {
      await queue.tryHold(replay);
    } finally {
      running = false;
    }
  }

  return { restore, run };
}
