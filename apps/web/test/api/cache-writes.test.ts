import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { writeQueryData } from '../../src/api/cache-writes.js';

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
