import type { ArticleListItem } from '@bantoozi/shared';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import {
  useReaderActions,
  useSettledActions,
} from '../../../src/features/reader/actions/provider.js';
import type { ActionResult } from '../../../src/features/reader/actions/types.js';
import { actionResponse, makeItem, renderReader } from '../../article/harness.js';
import { failure } from '../../api/fake-fetch.js';
import { acked } from './fake-transport.js';

type Seen = [type: string, result: ActionResult];

function Listener({ item, seen }: { item: ArticleListItem; seen: Seen[] }) {
  const store = useReaderActions();
  const [tag, setTag] = useState('first');
  useSettledActions((handle, result) => {
    seen.push([`${tag}:${handle.action.type}`, result]);
  });
  return (
    <>
      <button onClick={() => store.dispatch(item, { type: 'dwell', ms: 7000 })}>Dwell</button>
      <button onClick={() => store.dispatch(item, { type: 'bookmark' })}>Bookmark</button>
      <button onClick={() => setTag('second')}>Retag</button>
    </>
  );
}

function Toggle({ item, seen }: { item: ArticleListItem; seen: Seen[] }) {
  const store = useReaderActions();
  const [listening, setListening] = useState(true);
  return (
    <>
      {listening ? <Listener item={item} seen={seen} /> : null}
      <button onClick={() => setListening(false)}>Stop listening</button>
      <button onClick={() => store.dispatch(item, { type: 'read' })}>Read</button>
    </>
  );
}

describe('useSettledActions', () => {
  it('hands each settled action and its result to the listener', async () => {
    const item = makeItem();
    const seen: Seen[] = [];
    const app = renderReader(<Listener item={item} seen={seen} />, {
      routes: {
        'POST /articles/:id/dwell': () => actionResponse(acked(item), { prompt: true }),
        'POST /articles/:id/bookmark': () => failure(400, 'VALIDATION_FAILED'),
      },
    });

    await app.user.click(screen.getByRole('button', { name: 'Dwell' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]![0]).toBe('first:dwell');
    expect(seen[0]![1]).toMatchObject({ status: 'done', prompt: true });

    await app.user.click(screen.getByRole('button', { name: 'Retag' }));
    await app.user.click(screen.getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]![0]).toBe('second:bookmark');
    expect(seen[1]![1].status).toBe('failed');
  });

  it('stops calling a listener whose component is gone', async () => {
    const item = makeItem();
    const seen: Seen[] = [];
    const app = renderReader(<Toggle item={item} seen={seen} />, {
      routes: { 'POST /articles/:id/read': () => actionResponse(acked(item)) },
    });

    await app.user.click(screen.getByRole('button', { name: 'Stop listening' }));
    await app.user.click(screen.getByRole('button', { name: 'Read' }));
    await waitFor(() => expect(app.calls('POST', `/articles/${item.id}/read`)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual([]);
  });
});
