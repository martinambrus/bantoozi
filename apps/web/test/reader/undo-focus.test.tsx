import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { deferred, findToast } from '../article/harness.js';
import type { ApiRouteHandler } from '../support/app.js';
import { createReaderHarness, item, rowTitles } from './support.js';
import { bookmarkOf, likeOf, openMore, receipt, undoRoute, writeRoutes } from './surfaces.js';

const { open } = createReaderHarness();

const UNDO = 'POST /articles/undo';

/** The article as the server holds it after the undo: no rating, no read mark, a newer state. */
const restored = (id: number) => item(id, { stateVersion: '6' });

const titleOf = (name: string) => screen.getByRole('button', { name });
const dislikeOf = (name: string) =>
  within(screen.getByRole('article', { name })).getByRole('button', { name: 'Dislike' });
const bar = () => screen.getByRole('group', { name: 'Reason for the dislike' });
const barGone = () =>
  waitFor(() =>
    expect(screen.queryByRole('group', { name: 'Reason for the dislike' })).not.toBeInTheDocument(),
  );

describe('the focus after the Undo of the toast of a rating', () => {
  async function rated(routes: Record<string, ApiRouteHandler> = {}) {
    const writes = writeRoutes();
    const opened = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      routes: { ...writes.routes, ...undoRoute(restored(2)), ...routes },
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await opened.app.user.click(likeOf('Article 2'));
    const toast = await findToast('Marked as liked');
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 3']), { timeout: 3000 });
    return { ...opened, toast };
  }

  it('goes to the title of the restored row when the button is pressed with the mouse', async () => {
    const { app, toast } = await rated();

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
    await waitFor(() => expect(titleOf('Article 2')).toHaveFocus());
  });

  it('goes to the title of the restored row when the button is pressed with the keyboard', async () => {
    const { app, toast } = await rated();
    act(() => within(toast).getByRole('button', { name: 'Undo' }).focus());

    await app.user.keyboard('{Enter}');

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
    await waitFor(() => expect(titleOf('Article 2')).toHaveFocus());
  });

  it('leaves the focus where the reader put it while the answer was on its way', async () => {
    const answer = deferred<Response>();
    const { app, toast } = await rated({ [UNDO]: () => answer.promise });
    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    // Not article 3, where the toast gave the focus back: the reader goes to another row.
    act(() => titleOf('Article 1').focus());

    answer.resolve(json(200, { count: 1, mutationId: receipt(900), items: [restored(2)] }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
    expect(titleOf('Article 1')).toHaveFocus();
  });
});

describe('the focus after the Undo of an entry of the Recent actions sheet', () => {
  async function recent() {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      routes: { ...writes.routes, ...undoRoute() },
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(bookmarkOf('Article 1'));
    await app.user.click(bookmarkOf('Article 2'));
    await waitFor(() => expect(writes.issued).toHaveLength(2));
    await openMore(app, 'For you');
    await app.user.click(screen.getByRole('menuitem', { name: 'Recent actions' }));
    const sheet = await screen.findByRole('dialog', { name: 'Recent actions' });
    await waitFor(() => expect(within(sheet).getAllByRole('listitem')).toHaveLength(2));
    return { app, sheet };
  }

  it('goes to the Undo button of the entry next to it', async () => {
    const { app, sheet } = await recent();
    const [newest] = within(sheet).getAllByRole('listitem');

    await app.user.click(within(newest!).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(within(sheet).getAllByRole('listitem')).toHaveLength(1));
    expect(within(sheet).getByRole('button', { name: 'Undo' })).toHaveFocus();
  });

  it('stays in the sheet when it was the last entry', async () => {
    const { app, sheet } = await recent();
    for (let left = 2; left > 0; left -= 1) {
      const [entry] = within(sheet).getAllByRole('listitem');
      await app.user.click(within(entry!).getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(within(sheet).queryAllByRole('listitem')).toHaveLength(left - 1));
    }

    expect(within(sheet).getByText('Nothing to undo')).toBeVisible();
    expect(sheet).toHaveFocus();
  });
});

describe('the focus after the reason bar is answered', () => {
  async function disliked(articles: number[], which: number) {
    const writes = writeRoutes();
    const opened = await open({
      path: '/read/for_you',
      items: articles.map((id) => item(id)),
      routes: { ...writes.routes, ...undoRoute(restored(which)) },
    });
    await screen.findByRole('article', { name: `Article ${articles.at(-1)}` });
    await opened.app.user.click(dislikeOf(`Article ${which}`));
    await waitFor(() => expect(rowTitles()).not.toContain(`Article ${which}`), { timeout: 3000 });
    return opened;
  }

  it('goes to the row that took the place of the disliked one when a reason is clicked', async () => {
    const { app } = await disliked([1, 2, 3], 2);
    await waitFor(() => expect(titleOf('Article 3')).toHaveFocus());

    await app.user.click(within(bar()).getByRole('button', { name: 'Clickbait' }));

    await barGone();
    expect(titleOf('Article 3')).toHaveFocus();
  });

  it('goes to the row before it when the disliked one was the last', async () => {
    const { app } = await disliked([1, 2, 3], 3);
    await waitFor(() => expect(titleOf('Article 2')).toHaveFocus());

    await app.user.click(within(bar()).getByRole('button', { name: 'Off-topic' }));

    await barGone();
    expect(titleOf('Article 2')).toHaveFocus();
  });

  it('goes to the main landmark when no row is left to take the place', async () => {
    const { app } = await disliked([1], 1);

    await app.user.click(within(bar()).getByRole('button', { name: 'Other' }));

    await barGone();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('leaves a key that picks the reason while the focus is on a row alone', async () => {
    await disliked([1, 2, 3], 2);
    await waitFor(() => expect(titleOf('Article 3')).toHaveFocus());

    fireEvent.keyDown(document.body, { key: '3' });

    await barGone();
    expect(titleOf('Article 3')).toHaveFocus();
  });

  it('gives the focus to the restored row when Undo of the bar is clicked', async () => {
    const { app } = await disliked([1, 2, 3], 2);

    await app.user.click(within(bar()).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
    await waitFor(() => expect(titleOf('Article 2')).toHaveFocus());
  });
});
