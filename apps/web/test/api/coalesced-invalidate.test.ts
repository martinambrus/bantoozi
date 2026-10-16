import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { invalidateCoalesced } from '../../src/api/coalesced-invalidate.js';
import { createQueryClient } from '../../src/api/query-client.js';

function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('invalidateCoalesced (D-259)', () => {
  it('runs one refetch at a time and folds a burst into one trailing refetch', async () => {
    const client = createQueryClient();
    const calls: Array<ReturnType<typeof deferred>> = [];
    const aborted: boolean[] = [];
    const observer = new QueryObserver(client, {
      queryKey: ['counts'],
      queryFn: ({ signal }) => {
        const call = deferred();
        const index = calls.length;
        calls.push(call);
        aborted.push(false);
        signal.addEventListener('abort', () => {
          aborted[index] = true;
        });
        return call.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(0);
    await observer.refetch();

    invalidateCoalesced(client, ['counts']);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) invalidateCoalesced(client, ['counts']);
    await Promise.resolve();
    // The burst neither cancels the running fetch nor starts another.
    expect(calls).toHaveLength(2);
    expect(aborted[1]).toBe(false);

    calls[1]!.resolve(1);
    await new Promise((r) => setTimeout(r, 0));
    // One trailing refetch covers every invalidation of the burst.
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(3);
    expect(client.getQueryData(['counts'])).toBe(2);
    unsubscribe();
  });
});
