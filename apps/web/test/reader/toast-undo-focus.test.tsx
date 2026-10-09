import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import { deferred, findToast } from '../article/harness.js';
import type { ApiRouteHandler } from '../support/app.js';
import { createReaderHarness, item, rowTitles } from './support.js';
import { likeOf, receipt, undoRoute, writeRoutes } from './surfaces.js';

const { open } = createReaderHarness();

const UNDO = 'POST /articles/undo';

const restored = (id: number) => item(id, { stateVersion: '6' });
const titleOf = (name: string) => screen.getByRole('button', { name });

/** Article 2 is liked and has left, so the focus rests on the title of article 3; the toast offers Undo. */
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
  await waitFor(() => expect(titleOf('Article 3')).toHaveFocus());
  return { ...opened, toast };
}

describe('the focus when the toast of a rating goes', () => {
  it('rests on the row it was on while the answer of the Undo is on its way, then goes to the restored row', async () => {
    const answer = deferred<Response>();
    const { app, toast } = await rated({ [UNDO]: () => answer.promise });

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    expect(titleOf('Article 3')).toHaveFocus();
    answer.resolve(json(200, { count: 1, mutationId: receipt(900), items: [restored(2)] }));
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
    await waitFor(() => expect(titleOf('Article 2')).toHaveFocus());
  });

  it('stays on the row it was on when the Undo does not go through', async () => {
    const { app, toast } = await rated({ [UNDO]: () => failure(500, 'INTERNAL') });

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Something went wrong on our side. Try again.')).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 3']);
    expect(titleOf('Article 3')).toHaveFocus();
  });

  it('goes back to the row it was on when the toast is dismissed', async () => {
    const { app, toast } = await rated();

    await app.user.click(within(toast).getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText('Marked as liked')).not.toBeInTheDocument();
    expect(titleOf('Article 3')).toHaveFocus();
  });
});
