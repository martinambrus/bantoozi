import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REASON_BAR_MS,
  createReasonBar,
  type PendingDislike,
} from '../../src/features/article/reason-bar-store.js';
import { createReaderActions } from '../../src/features/reader/actions/store.js';
import type { ReaderActions } from '../../src/features/reader/actions/types.js';
import { FakeTransport, makeItem } from '../reader/actions/fake-transport.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function rig() {
  const transport = new FakeTransport();
  const store = createReaderActions({
    transport,
    preferences: () => ({ markReadOnRate: true }),
  });
  const bar = createReasonBar(store);
  return { transport, store, bar };
}

/** Dislikes article `id` the way the buttons do: held, and offered to the bar. */
function dislike(
  { store, bar }: { store: ReaderActions; bar: ReturnType<typeof createReasonBar> },
  id = '101',
): PendingDislike {
  const handle = store.dispatch(
    makeItem({ id, title: `Article ${id}` }),
    { type: 'rate', rating: -1 },
    { hold: true },
  );
  const pending: PendingDislike = {
    actionId: handle.id,
    articleId: id,
    title: `Article ${id}`,
    before: null,
  };
  bar.open(pending);
  return pending;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('the reason bar controller', () => {
  it('waits 5 seconds', () => {
    expect(REASON_BAR_MS).toBe(5000);
  });

  it('shows nothing before a dislike, then the dislike, and tells its listeners about each change', () => {
    const state = rig();
    const listener = vi.fn();
    state.bar.subscribe(listener);
    expect(state.bar.getSnapshot()).toBeNull();

    const pending = dislike(state);

    expect(state.bar.getSnapshot()).toEqual(pending);
    expect(state.bar.getSnapshot()).toBe(state.bar.getSnapshot());
    expect(listener).toHaveBeenCalledTimes(1);
    state.bar.undo();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(state.bar.getSnapshot()).toBeNull();
  });

  it('stops telling a listener that has unsubscribed', () => {
    const state = rig();
    const listener = vi.fn();
    const unsubscribe = state.bar.subscribe(listener);
    unsubscribe();

    dislike(state);

    expect(listener).not.toHaveBeenCalled();
  });

  it('sends the dislike without a reason after 5 seconds, once', async () => {
    const state = rig();
    const pending = dislike(state);

    await vi.advanceTimersByTimeAsync(REASON_BAR_MS - 1);
    expect(state.transport.sends).toHaveLength(0);
    expect(state.bar.getSnapshot()).toEqual(pending);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.transport.sends).toHaveLength(1);
    expect(state.transport.sends[0]!.action).toEqual({ type: 'rate', rating: -1 });
    expect(state.bar.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(1);
  });

  it('sends the reason that is picked at once and does not send again after 5 seconds', async () => {
    const state = rig();
    dislike(state);

    state.bar.pick('clickbait');
    await flush();

    expect(state.transport.sends).toHaveLength(1);
    expect(state.transport.sends[0]!.action).toEqual({
      type: 'rate',
      rating: -1,
      reason: 'clickbait',
    });
    expect(state.bar.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(1);
  });

  it('takes the dislike back with undo, sending nothing', async () => {
    const state = rig();
    const pending = dislike(state);

    state.bar.undo();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.transport.sends).toHaveLength(0);
    expect(state.store.get(pending.actionId)?.status).toBe('cancelled');
    expect(state.store.view(makeItem()).rating).toBeNull();
  });

  it('sends the open dislike without a reason when another article is disliked', async () => {
    const state = rig();
    const first = dislike(state, '101');

    const second = dislike(state, '102');
    await flush();

    expect(state.transport.sends).toHaveLength(1);
    expect(state.transport.sends[0]!.articleId).toBe('101');
    expect(state.transport.sends[0]!.action).toEqual({ type: 'rate', rating: -1 });
    expect(state.bar.getSnapshot()).toEqual(second);
    expect(state.store.get(first.actionId)?.status).toBe('sending');
    expect(state.store.get(second.actionId)?.status).toBe('held');
  });

  it('counts the 5 seconds again from the dislike that replaced another', async () => {
    const state = rig();
    dislike(state, '101');
    await vi.advanceTimersByTimeAsync(4000);
    dislike(state, '102');

    await vi.advanceTimersByTimeAsync(4999);
    expect(state.transport.sendsFor('102')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.transport.sendsFor('102')).toHaveLength(1);
  });

  it('tells which dislike is held for an article', () => {
    const state = rig();
    const pending = dislike(state, '101');

    expect(state.bar.heldFor('101')).toEqual(pending);
    expect(state.bar.heldFor('102')).toBeNull();
    state.bar.undo();
    expect(state.bar.heldFor('101')).toBeNull();
  });

  it('does nothing when a reason or undo comes with nothing open', async () => {
    const state = rig();

    state.bar.pick('seen');
    state.bar.undo();
    state.bar.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.transport.sends).toHaveLength(0);
  });

  it('does not take a second answer for the same dislike', async () => {
    const state = rig();
    dislike(state);

    state.bar.pick('seen');
    state.bar.pick('promo');
    state.bar.undo();
    await flush();

    expect(state.transport.sends).toHaveLength(1);
    expect(state.transport.sends[0]!.action).toMatchObject({ reason: 'seen' });
  });
});

describe('waiting while the bar is used', () => {
  it('stops the clock while paused and goes on with the time that was left', async () => {
    const state = rig();
    dislike(state);
    await vi.advanceTimersByTimeAsync(4000);

    state.bar.pause(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(0);
    expect(state.bar.getSnapshot()).not.toBeNull();
    state.bar.pause(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.transport.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.transport.sends).toHaveLength(1);
  });

  it('takes the time away at each pause, not only the first', async () => {
    const state = rig();
    dislike(state);
    await vi.advanceTimersByTimeAsync(1000);
    state.bar.pause(true);
    await vi.advanceTimersByTimeAsync(10_000);
    state.bar.pause(false);
    await vi.advanceTimersByTimeAsync(2000);
    state.bar.pause(true);
    await vi.advanceTimersByTimeAsync(10_000);
    state.bar.pause(false);

    await vi.advanceTimersByTimeAsync(1999);
    expect(state.transport.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.transport.sends).toHaveLength(1);
  });

  it('is not confused by a pause or a resume that is repeated', async () => {
    const state = rig();
    dislike(state);
    await vi.advanceTimersByTimeAsync(2000);

    state.bar.pause(true);
    state.bar.pause(true);
    await vi.advanceTimersByTimeAsync(5000);
    state.bar.pause(false);
    state.bar.pause(false);

    await vi.advanceTimersByTimeAsync(2999);
    expect(state.transport.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.transport.sends).toHaveLength(1);
  });

  it('holds a bar that opens while it is paused until the pause is lifted', async () => {
    const state = rig();
    state.bar.pause(true);
    dislike(state);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(0);
    state.bar.pause(false);
    await vi.advanceTimersByTimeAsync(REASON_BAR_MS);

    expect(state.transport.sends).toHaveLength(1);
  });

  it('still takes an answer while paused', async () => {
    const state = rig();
    dislike(state);
    state.bar.pause(true);

    state.bar.pick('shallow');
    await flush();

    expect(state.transport.sends).toHaveLength(1);
    expect(state.transport.sends[0]!.action).toMatchObject({ reason: 'shallow' });
  });
});

describe('closing without an answer', () => {
  it('forgets the dislike and stops the clock, and leaves the store alone', async () => {
    const state = rig();
    const pending = dislike(state);

    state.bar.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.bar.getSnapshot()).toBeNull();
    expect(state.transport.sends).toHaveLength(0);
    expect(state.store.get(pending.actionId)?.status).toBe('held');
  });

  it('closes by itself when the store has dropped the held action', async () => {
    const state = rig();
    const pending = dislike(state);

    state.store.cancel(pending.actionId);

    expect(state.bar.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(0);
  });

  it('closes by itself when the store was reset with the account', async () => {
    const state = rig();
    dislike(state);

    state.store.reset();

    expect(state.bar.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.transport.sends).toHaveLength(0);
  });

  it('lifts a pause, so that the next bar counts down', async () => {
    const state = rig();
    dislike(state);
    state.bar.pause(true);
    state.bar.close();

    dislike(state, '102');
    await vi.advanceTimersByTimeAsync(REASON_BAR_MS);

    expect(state.transport.sendsFor('102')).toHaveLength(1);
  });
});
