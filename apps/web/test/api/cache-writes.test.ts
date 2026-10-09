import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { writeQueriesData, writeQueryData } from '../../src/api/cache-writes.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('writeQueryData', () => {
  it('asks again for a query whose fetch on its way read before the change', async () => {
    const queryClient = new QueryClient();
    const key = ['list'];
    queryClient.setQueryData<string[]>(key, ['old']);
    const reads: Array<(list: string[]) => void> = [];
    const reading = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise<string[]>((resolve) => reads.push(resolve)),
    });

    writeQueryData<string[]>(queryClient, key, (list) => [...(list ?? []), 'new']);
    reads[0]!(['old']);
    await settle();

    expect(queryClient.getQueryData(key)).toEqual(['old', 'new']);
    expect(reads).toHaveLength(2);
    reads[1]!(['old', 'new', 'other']);
    await expect(reading).resolves.toEqual(['old', 'new', 'other']);
    expect(queryClient.getQueryData(key)).toEqual(['old', 'new', 'other']);
  });

  it('asks nothing when no fetch of the query is on its way', async () => {
    const queryClient = new QueryClient();
    const key = ['list'];
    queryClient.setQueryData<string[]>(key, ['old']);

    expect(writeQueryData<string[]>(queryClient, key, ['new'])).toEqual(['new']);
    await settle();

    expect(queryClient.getQueryData(key)).toEqual(['new']);
    expect(queryClient.getQueryState(key)?.fetchStatus).toBe('idle');
  });
});

describe('writeQueriesData', () => {
  it('asks again for each query under the key whose fetch is on its way, and for no other', async () => {
    const queryClient = new QueryClient();
    const asked: string[] = [];
    const fetching = (queryKey: string[]) => {
      queryClient.setQueryData<string[]>(queryKey, ['old']);
      void queryClient.fetchQuery({
        queryKey,
        queryFn: () => {
          asked.push(queryKey.join('/'));
          return new Promise<string[]>(() => {});
        },
      });
    };
    fetching(['list', 'a']);
    fetching(['other']);
    queryClient.setQueryData<string[]>(['list', 'b'], ['old']);

    writeQueriesData<string[]>(queryClient, ['list'], (list) => [...(list ?? []), 'new']);
    await settle();

    expect(queryClient.getQueryData(['list', 'a'])).toEqual(['old', 'new']);
    expect(queryClient.getQueryData(['list', 'b'])).toEqual(['old', 'new']);
    expect(asked).toEqual(['list/a', 'other', 'list/a']);
  });
});
