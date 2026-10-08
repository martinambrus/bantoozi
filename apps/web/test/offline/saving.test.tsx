import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setOfflineEnabled } from '../../src/offline/cache.js';
import { json } from '../api/fake-fetch.js';
import { makeDetail } from '../article/harness.js';
import { item, page } from '../reader/support.js';
import {
  FOR_YOU,
  connection,
  createSavedHarness,
  storedDetail,
  storedItem,
  storedView,
  viewReaches,
} from './saved-support.js';
import { A, fullDetail, freshIndexedDb } from './support.js';

const idb = freshIndexedDb();
const harness = createSavedHarness();

const FIRST_ASOF = '2026-10-08T07:00:00.000Z';
const SECOND_ASOF = '2026-10-08T07:30:00.000Z';

describe('saving the list that was loaded', () => {
  it('keeps the rows of the view without repeats, with the dataset of the first page', async () => {
    await setOfflineEnabled(A, true);
    const { app } = await harness.open(connection(), {
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(2), item(3)], { asOf: SECOND_ASOF, datasetVersion: 'd2' }))
          : json(
              200,
              page([item(1), item(2)], {
                nextCursor: 'c1',
                asOf: FIRST_ASOF,
                datasetVersion: 'd1',
              }),
            ),
    });
    await viewReaches(idb.factory, ['1', '2']);

    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('article', { name: 'Article 3' });

    await viewReaches(idb.factory, ['1', '2', '3']);
    const view = await storedView(idb.factory, FOR_YOU);
    expect(view).toMatchObject({ asOf: FIRST_ASOF, datasetVersion: 'd1' });
    expect((await storedItem(idb.factory, '3'))?.item).toMatchObject({
      id: '3',
      title: 'Article 3',
    });
  });

  it('keeps the first 200 rows of a longer list, in order', async () => {
    await setOfflineEnabled(A, true);
    const rows = Array.from({ length: 205 }, (_unused, index) => item(index + 1));

    await harness.open(connection(), { path: '/read/for_you', items: rows });

    await screen.findByRole('article', { name: 'Article 205' });
    const expected = rows.slice(0, 200).map((row) => row.id);
    await viewReaches(idb.factory, expected);
    expect(await storedItem(idb.factory, '200')).toBeDefined();
    expect(await storedItem(idb.factory, '201')).toBeUndefined();
  });

  it('keeps a view under its own key, not under the key of another', async () => {
    await setOfflineEnabled(A, true);
    const { app } = await harness.open(connection(), {
      path: '/read/for_you',
      list: (request) =>
        json(200, page(request.query.get('lane') === 'new' ? [item(8), item(9)] : [item(1)])),
    });
    await viewReaches(idb.factory, ['1']);

    await act(async () => {
      await app.router.navigate({ to: '/read/$lane', params: { lane: 'new' } });
    });

    await screen.findByRole('article', { name: 'Article 8' });
    await viewReaches(idb.factory, ['8', '9'], JSON.stringify(['new', null, null, null]));
    expect((await storedView(idb.factory, FOR_YOU))?.itemIds).toEqual(['1']);
  });
});

describe('saving an article that was opened', () => {
  const full = makeDetail(item(1), {
    excerptHtml: '<p>The excerpt of the article.</p>',
    bodyLead: 'The lead of the article.',
    explain: fullDetail().explain,
    translation: { title: 'Preklad', excerpt: 'Úryvok', engine: 'libretranslate', quality: 'ok' },
    clusterMembers: [{ id: '13', title: 'A member', feedTitle: 'Other Feed', url: null }],
  });

  it('keeps its texts and nothing of the ranking', async () => {
    await setOfflineEnabled(A, true);
    const { app } = await harness.open(connection(), {
      path: '/read/for_you',
      items: [item(1)],
      routes: { 'GET /articles/:id': () => json(200, full) },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Article 1' }));
    await screen.findByText('The excerpt of the article.');

    await vi.waitFor(async () => expect(await storedDetail(idb.factory, '1')).toBeDefined(), {
      timeout: 5000,
    });
    const { detail } = (await storedDetail(idb.factory, '1'))!;
    expect(detail).toMatchObject({
      id: '1',
      excerptHtml: '<p>The excerpt of the article.</p>',
      bodyLead: 'The lead of the article.',
      translation: { title: 'Preklad', excerpt: 'Úryvok' },
    });
    expect(detail).not.toHaveProperty('explain');
    expect(detail).not.toHaveProperty('clusterMembers');
  });
});

describe('the choice to read offline', () => {
  it('writes nothing before the account chose it, and keeps what is loaded after', async () => {
    const opened = vi.spyOn(idb.factory, 'open');
    const { app } = await harness.open(connection(), {
      path: '/read/for_you',
      items: [item(1), item(2)],
    });
    await app.user.click(await screen.findByRole('button', { name: 'Article 1' }));
    await screen.findByText('The excerpt of the article.');

    expect(opened).not.toHaveBeenCalled();
    expect(await idb.factory.databases()).toEqual([]);

    await setOfflineEnabled(A, true);
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await app.user.click(screen.getByRole('button', { name: 'Article 2' }));

    await viewReaches(idb.factory, ['1', '2']);
    await vi.waitFor(async () => expect(await storedDetail(idb.factory, '2')).toBeDefined(), {
      timeout: 5000,
    });
  });
});
