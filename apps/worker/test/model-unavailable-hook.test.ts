import { describe, expect, it } from 'vitest';

import { withModelUnavailableHook } from '../src/engine-router.js';

/**
 * JEV-3 (U2): `withModelUnavailableHook(store, hook)` wraps ONLY `settleReservation` of an engine
 * store: after the inner call settled it awaits `hook()` when a TypeSafe classification call
 * (enrich, match, cluster, suggest) failed with a `model_unavailable` detail. A hook error is
 * swallowed; an inner error propagates and the hook is not called. No database.
 */

type Call = { engine: string; kind: string; error?: string | undefined; [k: string]: unknown };
interface StoreLike {
  settleReservation(id: string, call: Call, usage: unknown, billing: string): Promise<void>;
  [method: string]: unknown;
}
type Wrap = (store: StoreLike, hook: () => Promise<void>) => StoreLike;

const load = async (): Promise<Wrap> => withModelUnavailableHook as unknown as Wrap;

const usage = { tokens: 1 };
const call = (overrides: Partial<Call> = {}): Call => ({
  engine: 'typesafe',
  kind: 'enrich',
  error: 'model_unavailable:http_404',
  ...overrides,
});

function fakeStore(order: string[] = [], innerError?: Error) {
  const store = {
    reserve: async () => 'reserve',
    releaseReservation: async () => undefined,
    recordCall: async () => undefined,
    settleReservation: async (id: string) => {
      order.push(`inner:${id}`);
      if (innerError !== undefined) throw innerError;
    },
  };
  return store as unknown as StoreLike & typeof store;
}

async function settle(overrides: Partial<Call>, hook?: () => Promise<void>) {
  const wrap = await load();
  const order: string[] = [];
  let fired = 0;
  const wrapped = wrap(fakeStore(order), hook ?? (async () => void (fired += 1)));
  await wrapped.settleReservation('r1', call(overrides), usage, 'known');
  return { fired, order };
}

describe('T3b: withModelUnavailableHook', () => {
  it.each(['enrich', 'match', 'cluster', 'suggest'])(
    'fires once for kind %s with model_unavailable:http_404',
    async (kind) => {
      expect((await settle({ kind })).fired).toBe(1);
    },
  );

  it.each([
    'model_unavailable',
    'model_unavailable:http_404',
    'model_unavailable:http_410',
    'typesafe:error:model_unavailable:http_404',
  ])('fires for the error detail %s', async (error) => {
    expect((await settle({ error })).fired).toBe(1);
  });

  it.each(['model_probe', 'credential_probe', 'eval', 'card_draft', 'translate'])(
    'does not fire for kind %s',
    async (kind) => {
      expect((await settle({ kind })).fired).toBe(0);
    },
  );

  it.each(['llm', 'laya', 'libretranslate'])('does not fire for engine %s', async (engine) => {
    expect((await settle({ engine })).fired).toBe(0);
  });

  it.each([
    'http_503',
    'model_mismatch:jev-1.14.0',
    'unavailable_model',
    'rate_limited',
    'auth_error',
    '',
  ])('does not fire for the error %j', async (error) => {
    expect((await settle({ error })).fired).toBe(0);
  });

  it('does not fire without an error', async () => {
    expect((await settle({ error: undefined })).fired).toBe(0);
    const wrap = await load();
    let fired = 0;
    const wrapped = wrap(fakeStore(), async () => void (fired += 1));
    const { error: _omitted, ...noError } = call();
    await wrapped.settleReservation('r1', noError as Call, usage, 'known');
    expect(fired).toBe(0);
  });

  it('a throwing hook does not make settleReservation reject', async () => {
    const wrap = await load();
    const order: string[] = [];
    const wrapped = wrap(fakeStore(order), async () => {
      order.push('hook');
      throw new Error('boom');
    });
    await expect(wrapped.settleReservation('r1', call(), usage, 'known')).resolves.toBeUndefined();
    expect(order).toEqual(['inner:r1', 'hook']);
  });

  it('a hook that rejects asynchronously is awaited and swallowed', async () => {
    const wrap = await load();
    const wrapped = wrap(fakeStore(), () => Promise.reject(new Error('later')));
    await expect(wrapped.settleReservation('r1', call(), usage, 'known')).resolves.toBeUndefined();
  });

  it('a rejecting inner settleReservation rejects and the hook is not called', async () => {
    const wrap = await load();
    let fired = 0;
    const boom = new Error('settle failed');
    const wrapped = wrap(fakeStore([], boom), async () => void (fired += 1));
    await expect(wrapped.settleReservation('r1', call(), usage, 'known')).rejects.toBe(boom);
    expect(fired).toBe(0);
  });

  it('calls the inner settle before the hook and awaits the hook', async () => {
    const wrap = await load();
    const order: string[] = [];
    const wrapped = wrap(fakeStore(order), async () => {
      order.push('hook-start');
      await Promise.resolve();
      await Promise.resolve();
      order.push('hook-end');
    });
    await wrapped.settleReservation('r7', call(), usage, 'known');
    expect(order).toEqual(['inner:r7', 'hook-start', 'hook-end']);
  });

  it('passes the arguments through to the inner settle unchanged', async () => {
    const wrap = await load();
    const seen: unknown[][] = [];
    const inner = fakeStore();
    inner.settleReservation = (async (...args: unknown[]) => void seen.push(args)) as never;
    const wrapped = wrap(inner, async () => undefined);
    const c = call();
    await wrapped.settleReservation('r9', c, usage, 'uncertain');
    expect(seen).toEqual([['r9', c, usage, 'uncertain']]);
  });

  it('every other store method is the same function as in the inner store', async () => {
    const wrap = await load();
    const inner = fakeStore();
    const wrapped = wrap(inner, async () => undefined);
    for (const name of ['reserve', 'releaseReservation', 'recordCall']) {
      expect(wrapped[name]).toBe(inner[name]);
    }
    expect(wrapped.settleReservation).not.toBe(inner.settleReservation);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(inner).sort());
  });
});
