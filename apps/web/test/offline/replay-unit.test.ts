import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ActionHandle,
  OfflineControl,
  SettledNote,
} from '../../src/features/reader/actions/types.js';
import { writeOfflineEnabled } from '../../src/offline/device.js';
import { LIMITS } from '../../src/offline/names.js';
import { deleteRecord, listRecords, patchRecord, putRecord } from '../../src/offline/queue.js';
import {
  OFFLINE_CHANNEL,
  REPLAY_LOCK,
  createActionQueue,
  createDispatchLock,
  createReplayer,
  expiryCutoff,
  type AccountCheck,
  type ReplayQueue,
} from '../../src/offline/replay.js';
import type { QueueRecord } from '../../src/offline/types.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import { FakeLocks } from './fake-locks.js';
import { A, B, DAY, T0, freshIndexedDb, makeRecord } from './support.js';

freshIndexedDb();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const asLockManager = (locks: FakeLocks) => locks as unknown as Pick<LockManager, 'request'>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the 24 hour limit', () => {
  it('counts back one day from now', () => {
    expect(expiryCutoff(T0)).toBe(T0 - DAY);
    expect(expiryCutoff(T0)).toBe(T0 - LIMITS.ttlMs);
  });
});

describe('the dispatcher lock', () => {
  it('runs the work of a page that has no Web Locks, as the only tab', async () => {
    const lock = createDispatchLock(undefined);

    await expect(lock.hold(() => Promise.resolve(3))).resolves.toBe(3);
    await expect(lock.tryHold(() => Promise.resolve(4))).resolves.toEqual({ held: true, value: 4 });
  });

  it('asks for the lock by its name, and for no wait when it only tries', async () => {
    const asked: [string, unknown][] = [];
    const locks = {
      request: (name: string, options: unknown, callback: (lock: object | null) => unknown) => {
        asked.push([name, options]);
        return Promise.resolve(callback({}));
      },
    } as unknown as Pick<LockManager, 'request'>;
    const lock = createDispatchLock(locks);

    await lock.hold(() => Promise.resolve());
    await lock.tryHold(() => Promise.resolve());

    expect(REPLAY_LOCK).toBe('bantoozi:replay');
    expect(asked).toEqual([
      ['bantoozi:replay', {}],
      ['bantoozi:replay', { ifAvailable: true }],
    ]);
  });

  it('lets one tab at a time send, the others waiting their turn in the order they asked', async () => {
    const locks = new FakeLocks();
    const first = createDispatchLock(asLockManager(locks));
    const second = createDispatchLock(asLockManager(locks));
    const order: string[] = [];
    const gate = deferred();

    const one = first.hold(async () => {
      order.push('one:start');
      await gate.promise;
      order.push('one:end');
    });
    await tick();
    const two = second.hold(async () => {
      order.push('two:start');
    });
    await tick();
    expect(order).toEqual(['one:start']);

    gate.resolve();
    await Promise.all([one, two]);

    expect(order).toEqual(['one:start', 'one:end', 'two:start']);
  });

  it('skips when another tab holds the lock, and tries again after it let go', async () => {
    const locks = new FakeLocks();
    const first = createDispatchLock(asLockManager(locks));
    const second = createDispatchLock(asLockManager(locks));
    const gate = deferred();
    const one = first.hold(() => gate.promise);
    await tick();
    const work = vi.fn(() => Promise.resolve('sent'));

    await expect(second.tryHold(work)).resolves.toEqual({ held: false });
    expect(work).not.toHaveBeenCalled();

    gate.resolve();
    await one;
    await tick();
    await expect(second.tryHold(work)).resolves.toEqual({ held: true, value: 'sent' });
  });

  it('lets the work of a tab that holds the lock take part in it, without waiting for itself', async () => {
    const locks = new FakeLocks();
    const lock = createDispatchLock(asLockManager(locks));
    const order: string[] = [];

    const outcome = await lock.tryHold(async () => {
      order.push('replay:start');
      await lock.hold(async () => {
        order.push('send');
      });
      await Promise.all([
        lock.hold(async () => order.push('send:a')),
        lock.hold(async () => order.push('send:b')),
      ]);
      order.push('replay:end');
      return 'done';
    });

    expect(outcome).toEqual({ held: true, value: 'done' });
    expect(order).toEqual(['replay:start', 'send', 'send:a', 'send:b', 'replay:end']);
    expect(locks.granted).toEqual([REPLAY_LOCK]);
    await tick();
    expect(locks.holding).toBe(false);
  });

  it('lets a try join a send of its own tab that waits for the lock', async () => {
    const locks = new FakeLocks();
    const other = createDispatchLock(asLockManager(locks));
    const mine = createDispatchLock(asLockManager(locks));
    const gate = deferred();
    const holder = other.hold(() => gate.promise);
    await tick();
    const order: string[] = [];

    const send = mine.hold(async () => {
      order.push('send');
    });
    const replay = mine.tryHold(async () => {
      order.push('replay');
      return 1;
    });
    await tick();
    expect(order).toEqual([]);
    gate.resolve();
    await holder;

    await expect(replay).resolves.toEqual({ held: true, value: 1 });
    await send;
    expect(order).toEqual(['send', 'replay']);
    expect(locks.granted).toEqual([REPLAY_LOCK, REPLAY_LOCK]);
  });

  it('lets go of the lock when the work fails', async () => {
    const locks = new FakeLocks();
    const lock = createDispatchLock(asLockManager(locks));

    await expect(lock.hold(() => Promise.reject(new Error('broken')))).rejects.toThrow('broken');
    await tick();

    expect(locks.holding).toBe(false);
    await expect(lock.tryHold(() => Promise.resolve(1))).resolves.toEqual({ held: true, value: 1 });
  });

  it('works without the lock when the browser refuses to give it', async () => {
    const locks = { request: () => Promise.reject(new Error('refused')) } as unknown as Pick<
      LockManager,
      'request'
    >;
    const throwing = {
      request: () => {
        throw new Error('refused');
      },
    } as unknown as Pick<LockManager, 'request'>;

    for (const manager of [locks, throwing]) {
      const lock = createDispatchLock(manager);
      await expect(lock.hold(() => Promise.resolve(1))).resolves.toBe(1);
      await expect(lock.tryHold(() => Promise.resolve(2))).resolves.toEqual({
        held: true,
        value: 2,
      });
    }
  });
});

describe('the broadcast between tabs', () => {
  const note: SettledNote = { id: 'r1', outcome: 'cancelled' };

  it('tells the other tabs of the same account how a record ended', async () => {
    const sender = createActionQueue({ accountId: A });
    const receiver = createActionQueue({ accountId: A });
    const heard: SettledNote[] = [];
    receiver.hear((n) => heard.push(n));
    sender.hear(() => undefined);

    sender.announce(note);
    sender.announce({ id: 'r2', outcome: 'failed', status: 404, code: 'NOT_FOUND' });
    sender.announce({ id: 'r3', outcome: 'stale', item: null });
    const item = makeItem();
    sender.announce({ id: 'r4', outcome: 'done', item, mutationId: 'm1' });
    await tick();
    await tick();

    expect(heard).toEqual([
      note,
      { id: 'r2', outcome: 'failed', status: 404, code: 'NOT_FOUND' },
      { id: 'r3', outcome: 'stale', item: null },
      { id: 'r4', outcome: 'done', item, mutationId: 'm1' },
    ]);
    sender.close();
    receiver.close();
  });

  it('does not tell tabs of another account, and does not hear what it cannot read', async () => {
    const other = createActionQueue({ accountId: B });
    const mine = createActionQueue({ accountId: A });
    const heard: SettledNote[] = [];
    mine.hear((n) => heard.push(n));
    other.hear(() => undefined);
    const raw = new BroadcastChannel(OFFLINE_CHANNEL);

    other.announce(note);
    raw.postMessage('text');
    raw.postMessage(null);
    raw.postMessage({ accountId: A });
    raw.postMessage({ accountId: A, note: { outcome: 'done' } });
    raw.postMessage({
      accountId: A,
      note: { id: 'x', outcome: 'done', item: {}, mutationId: 'm' },
    });
    raw.postMessage({ accountId: A, note: { id: 'x', outcome: 'stale', item: 5 } });
    raw.postMessage({
      accountId: A,
      note: { id: 'x', outcome: 'failed', status: 'no', code: 'C' },
    });
    raw.postMessage({ accountId: A, note: { id: 'x', outcome: 'unknown' } });
    raw.postMessage({ accountId: A, note: { id: 'ok', outcome: 'cancelled' } });
    await tick();
    await tick();

    expect(heard).toEqual([{ id: 'ok', outcome: 'cancelled' }]);
    raw.close();
    mine.close();
    other.close();
  });

  it('says nothing before it listens, and nothing after it was closed', async () => {
    const quiet = createActionQueue({ accountId: A });
    const listener = createActionQueue({ accountId: A });
    const heard: SettledNote[] = [];
    listener.hear((n) => heard.push(n));

    quiet.announce(note);
    await tick();
    quiet.hear(() => undefined);
    quiet.close();
    quiet.announce(note);
    await tick();
    await tick();

    expect(heard).toEqual([]);
    listener.close();
  });

  it('stops hearing for the listener that was removed', async () => {
    const sender = createActionQueue({ accountId: A });
    const receiver = createActionQueue({ accountId: A });
    const heard: SettledNote[] = [];
    const stop = receiver.hear((n) => heard.push(n));
    sender.hear(() => undefined);
    stop();

    sender.announce(note);
    await tick();
    await tick();

    expect(heard).toEqual([]);
    sender.close();
    receiver.close();
  });
});

describe('the queue of an account', () => {
  it('is on when the account chose offline reading and the browser is online', () => {
    const queue = createActionQueue({ accountId: A });
    expect(queue.enabled()).toBe(false);
    writeOfflineEnabled(A, true);
    expect(queue.enabled()).toBe(true);
    expect(createActionQueue({ accountId: B }).enabled()).toBe(false);

    const onLine = vi.spyOn(navigator, 'onLine', 'get');
    onLine.mockReturnValue(false);
    expect(queue.online()).toBe(false);
    onLine.mockReturnValue(true);
    expect(queue.online()).toBe(true);
    expect(createActionQueue({ accountId: A, online: () => false }).online()).toBe(false);
  });

  it('keeps, changes, lists and removes the records of its account, and freezes them', async () => {
    writeOfflineEnabled(A, true);
    const queue = createActionQueue({ accountId: A });
    const first = makeRecord('r1', { createdAt: T0 });
    const second = makeRecord('r2', { createdAt: T0 - 1000 });

    expect(await queue.save(first)).toBe(true);
    expect(await queue.save(second)).toBe(true);
    expect((await queue.list()).map((record) => record.id)).toEqual(['r2', 'r1']);
    expect(await queue.change('r1', { fence: { stateVersion: '9', contentRevision: '2' } })).toBe(
      true,
    );
    expect((await queue.list()).find((record) => record.id === 'r1')?.fence).toEqual({
      stateVersion: '9',
      contentRevision: '2',
    });

    await queue.setState('frozen');
    expect((await queue.list()).map((record) => record.state)).toEqual(['frozen', 'frozen']);
    await queue.setState('pending');
    expect((await queue.list()).map((record) => record.state)).toEqual(['pending', 'pending']);

    await queue.remove('r1');
    expect(await queue.change('r1', {})).toBe(false);
    expect((await queue.list()).map((record) => record.id)).toEqual(['r2']);
  });
});

describe('changing a kept record', () => {
  async function kept(record: QueueRecord = makeRecord('r1')) {
    writeOfflineEnabled(A, true);
    expect(await putRecord(record)).toBe(true);
    return record;
  }

  it('merges the fields it is given and says the record is there', async () => {
    await kept();

    const present = await patchRecord(A, 'r1', {
      key: 'k2',
      fence: { stateVersion: '8', contentRevision: '3' },
      after: 'r0',
      action: { type: 'rate', rating: -1 },
    });

    expect(present).toBe(true);
    expect((await listRecords(A))[0]).toMatchObject({
      id: 'r1',
      key: 'k2',
      fence: { stateVersion: '8', contentRevision: '3' },
      after: 'r0',
      action: { type: 'rate', rating: -1 },
      createdAt: T0,
      state: 'pending',
    });
  });

  it('keeps the mark that a request was made, and nothing else changes', async () => {
    const record = await kept();

    expect(await patchRecord(A, 'r1', { sent: true })).toBe(true);

    expect(await listRecords(A)).toEqual([{ ...record, sent: true }]);
  });

  it('only looks when it is given nothing to change', async () => {
    const record = await kept();

    expect(await patchRecord(A, 'r1', {})).toBe(true);
    expect(await patchRecord(A, 'other', {})).toBe(false);
    expect(await listRecords(A)).toEqual([record]);
  });

  it('does not bring back a record that is gone', async () => {
    await kept();
    await deleteRecord(A, 'r1');

    expect(await patchRecord(A, 'r1', { key: 'k2' })).toBe(false);
    expect(await listRecords(A)).toEqual([]);
  });

  it('says the record is gone when nothing was ever stored or the account id is not valid', async () => {
    expect(await patchRecord(A, 'r1', { key: 'k2' })).toBe(false);
    expect(await patchRecord('not an id', 'r1', {})).toBe(false);
  });

  it('changes only the record of its own account', async () => {
    await kept();
    writeOfflineEnabled(B, true);
    await putRecord(makeRecord('r1', { accountId: B, key: 'b-key' }));

    expect(await patchRecord(B, 'r1', { key: 'b-new' })).toBe(true);

    expect((await listRecords(A))[0]?.key).toBe('r1');
    expect((await listRecords(B))[0]?.key).toBe('b-new');
  });
});

describe('the replayer', () => {
  interface Kit {
    calls: string[];
    held: boolean;
    check: AccountCheck;
    online: boolean;
    expired: number;
    records: QueueRecord[];
    epoch: number;
    verifying: Promise<void> | null;
    /** How many kept changes the target shows. */
    kept: number;
  }

  function kit(overrides: Partial<Kit> = {}) {
    const state: Kit = {
      calls: [],
      held: true,
      check: 'same',
      online: true,
      expired: 0,
      records: [makeRecord('r1')],
      epoch: 0,
      verifying: null,
      kept: 0,
      ...overrides,
    };
    const queue = {
      online: () => state.online,
      list: () => {
        state.calls.push('list');
        return Promise.resolve(state.records);
      },
      setState: (next: string) => {
        state.calls.push(`setState:${next}`);
        return Promise.resolve();
      },
      tryHold: async <T>(work: () => Promise<T>) => {
        state.calls.push('tryHold');
        return state.held ? { held: true as const, value: await work() } : { held: false as const };
      },
    } as unknown as ReplayQueue;
    const target: OfflineControl = {
      waiting: () => Array.from({ length: state.kept }, () => ({}) as ActionHandle),
      mark: () => 7,
      adopt: (records, mark) => {
        state.calls.push(`adopt:${records.length}:${mark}`);
      },
      expire: (cutoff) => {
        state.calls.push(`expire:${cutoff}`);
        return state.expired;
      },
      drain: () => {
        state.calls.push('drain');
        return Promise.resolve();
      },
    };
    const notices: number[] = [];
    const replayer = createReplayer({
      queue,
      target,
      verify: async () => {
        state.calls.push('verify');
        await state.verifying;
        return state.check;
      },
      onExpired: (count) => notices.push(count),
      epoch: () => state.epoch,
      now: () => T0,
    });
    return { state, replayer, notices };
  }

  it('shows the kept changes without any connection', async () => {
    const { state, replayer } = kit({ online: false });

    await replayer.restore();

    expect(state.calls).toEqual(['list', 'adopt:1:7']);
  });

  it('does nothing while the browser is offline', async () => {
    const { state, replayer } = kit({ online: false });

    await replayer.run();

    expect(state.calls).toEqual([]);
  });

  it.each([
    ['the records that remain', [makeRecord('r1')], 'adopt:1:7'],
    ['none when all were discarded', [], 'adopt:0:7'],
  ])(
    'reconciles with %s while offline when it shows kept changes, and sends and asks nobody',
    async (_name, records, adopted) => {
      const { state, replayer } = kit({ online: false, kept: 2, records });

      await replayer.run();

      expect(state.calls).toEqual(['list', adopted]);
    },
  );

  it('shows nothing when the page let go of the account while it was reading offline', async () => {
    const { state, replayer } = kit({ online: false, kept: 1 });

    const running = replayer.run();
    state.epoch += 1;
    await running;

    expect(state.calls).toEqual(['list']);
  });

  it('asks the server who is signed in, then sends the changes of that account after dropping the old ones', async () => {
    const { state, replayer, notices } = kit({ expired: 2 });

    await replayer.run();

    expect(state.calls).toEqual([
      'tryHold',
      'list',
      'verify',
      'setState:pending',
      'adopt:1:7',
      `expire:${T0 - DAY}`,
      'drain',
    ]);
    expect(notices).toEqual([2]);
  });

  it('says nothing when nothing expired', async () => {
    const { replayer, notices } = kit({ expired: 0 });

    await replayer.run();

    expect(notices).toEqual([]);
  });

  it('only reconciles when there is nothing to send, and asks nobody', async () => {
    const { state, replayer } = kit({ records: [] });

    await replayer.run();

    expect(state.calls).toEqual(['tryHold', 'list', 'adopt:0:7']);
  });

  it('freezes the records and sends nothing when the session has ended', async () => {
    const { state, replayer } = kit({ check: 'unauthorized' });

    await replayer.run();

    expect(state.calls).toEqual(['tryHold', 'list', 'verify', 'setState:frozen']);
  });

  it.each(['other', 'unreachable'] as const)(
    'sends nothing when the check says %s',
    async (check) => {
      const { state, replayer } = kit({ check });

      await replayer.run();

      expect(state.calls).toEqual(['tryHold', 'list', 'verify']);
    },
  );

  it('skips when another tab is sending', async () => {
    const { state, replayer } = kit({ held: false });

    await replayer.run();

    expect(state.calls).toEqual(['tryHold']);
  });

  it('runs one replay at a time', async () => {
    const wait = deferred();
    const { state, replayer } = kit({ verifying: wait.promise });

    const first = replayer.run();
    await tick();
    await replayer.run();
    await replayer.run();
    wait.resolve();
    await first;
    await replayer.run();

    expect(state.calls.filter((call) => call === 'verify')).toHaveLength(2);
    expect(state.calls.filter((call) => call === 'drain')).toHaveLength(2);
  });

  it('sends nothing when the page let go of the account while it was asking', async () => {
    const wait = deferred();
    const { state, replayer } = kit({ verifying: wait.promise });

    const running = replayer.run();
    await tick();
    state.epoch += 1;
    wait.resolve();
    await running;

    expect(state.calls).toEqual(['tryHold', 'list', 'verify']);
  });

  it('shows nothing when the page let go of the account while it was reading', async () => {
    const { state, replayer } = kit();
    const restoring = replayer.restore();
    state.epoch += 1;
    await restoring;

    expect(state.calls).toEqual(['list']);
  });
});
