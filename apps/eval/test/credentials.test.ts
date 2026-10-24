import type { Database } from '@bantoozi/db';
import { describe, expect, it, vi } from 'vitest';

import { createEvalCredentialResolver } from '../src/experiments/credentials.js';

const cancelled = { code: 'ENGINE_UNAVAILABLE', details: { reason: 'cancelled' } };
function setup(execute = vi.fn(async () => ({ rows: [] }))) {
  return {
    execute,
    resolver: createEvalCredentialResolver({
      db: { execute } as unknown as Database,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { typesafe: 'test-key' },
    }),
  };
}

describe('eval credential cancellation', () => {
  it('refuses a pre-aborted signal before any read or send', async () => {
    const { resolver, execute } = setup();
    const send = vi.fn();
    await expect(resolver.useActive('typesafe', AbortSignal.abort(), send)).rejects.toMatchObject(
      cancelled,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('stops waiting when aborted and handles a late database rejection', async () => {
    let rejectRead!: (error: Error) => void;
    const execute = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectRead = reject;
        }),
    );
    const { resolver } = setup(execute);
    const controller = new AbortController();
    const send = vi.fn();
    const pending = resolver.useActive('typesafe', controller.signal, send);
    controller.abort();
    const outcome = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    rejectRead(new Error('offline'));
    await pending.catch(() => undefined);
    expect(outcome).toMatchObject(cancelled);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a read that completes as the signal aborts', async () => {
    const controller = new AbortController();
    const { resolver } = setup(
      vi.fn(async () => {
        controller.abort();
        return { rows: [] };
      }),
    );
    const send = vi.fn();
    await expect(resolver.useActive('typesafe', controller.signal, send)).rejects.toMatchObject(
      cancelled,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('serves a live signal and sanitizes database failures', async () => {
    const { resolver, execute } = setup();
    const send = vi.fn(async () => 'sent');
    await expect(resolver.useActive('typesafe', new AbortController().signal, send)).resolves.toBe(
      'sent',
    );
    execute.mockRejectedValueOnce(new Error('private database details'));
    await expect(
      resolver.useActive('typesafe', new AbortController().signal, send),
    ).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      details: { reason: 'lookup_failed' },
    });
  });
});
