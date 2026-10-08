import type { ArticleListItem, Subscription } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { failure, json } from '../api/fake-fetch.js';
import { findToast } from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { requestId } from '../onboarding/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  createReaderHarness,
  item,
  listQueries,
  page,
  rowOf,
  type ReaderOptions,
} from './support.js';
import { likeOf } from './surfaces.js';

const { open } = createReaderHarness();

const ANALYZE = 'POST /subscriptions/:feedId/analyze';
const RATE = 'POST /articles/:id/rating';

type Analysis = ArticleListItem['analysis'];
type Mode = Subscription['inferenceMode'];

/** An article someone has asked to have analyzed, with the request the API made for it. */
const asked = (status: Analysis['status'], n: number): Analysis => ({
  mode: 'training',
  status,
  requestId: requestId(n),
});

const verge = (inferenceMode: Mode = 'training') =>
  makeSubscription({
    feed: { id: '7', title: 'Verge' },
    inferenceMode,
    inferenceVersion: '5',
  });

const other = makeSubscription({ feed: { id: '8', title: 'Ars' } });

const titles = (count: number) => Array.from({ length: count }, (_unused, i) => `Article ${i + 1}`);
const numbered = (count: number) => titles(count).map((_title, i) => item(i + 1));

interface Served {
  /** What `GET /articles?feedId=7` answers; the fake API changes it as the worker would. */
  items: ArticleListItem[];
}

/** `POST /subscriptions/:feedId/analyze` as the API answers it: 202, and the articles are requested. */
function accepts(served: Served): ApiRouteHandler {
  return (request) => {
    const { articles } = bodyOf(request) as { articles: { id: string }[] };
    const ids = articles.map(({ id }) => id);
    served.items = served.items.map((row) =>
      ids.includes(row.id) ? { ...row, analysis: asked('pending', Number(row.id)) } : row,
    );
    return json(202, {
      requests: ids.map((id) => ({ id: requestId(Number(id)), articleId: id, status: 'pending' })),
    });
  };
}

const elsewhere = item(21, { title: 'Elsewhere 21' });

interface FeedOptions extends Pick<ReaderOptions, 'me' | 'routes'> {
  path?: string;
  subscriptions?: Subscription[];
}

/** The reader on feed 7 (Verge) with these articles; every other list holds "Elsewhere 21". */
async function openFeed(rows: ArticleListItem[], options: FeedOptions = {}) {
  const served: Served = { items: rows };
  const { path = '/read/feed/7', subscriptions = [verge(), other], ...rest } = options;
  const opened = await open({
    ...rest,
    path,
    subscriptions,
    items: rows,
    list: (request) =>
      json(
        200,
        page(
          request.query.get('feedId') === '7' && request.query.get('lane') !== 'new'
            ? served.items
            : [elsewhere],
        ),
      ),
    routes: { [ANALYZE]: accepts(served), ...rest.routes },
  });
  await screen.findByRole('article', { name: rows[0]?.title ?? '' });
  // The sidebar lists the feeds once the subscriptions are in, and so does the page.
  await screen.findAllByRole('link', { name: new RegExp(subscriptions[0]?.feed.title ?? '') });
  return { ...opened, served };
}

type App = Awaited<ReturnType<typeof openFeed>>['app'];

const boxOf = (title: string) => within(rowOf(title)).getByRole('checkbox');

/** The titles among `all` whose rows have a checkbox. */
const withBox = (all: readonly string[]) =>
  all.filter((title) => within(rowOf(title)).queryAllByRole('checkbox').length > 0);

/** The titles among `all` whose checkbox is ticked. */
const ticked = (all: readonly string[]) =>
  all.filter(
    (title) => within(rowOf(title)).queryAllByRole('checkbox', { checked: true }).length > 0,
  );

async function choose(app: App, ...chosen: string[]) {
  for (const title of chosen) await app.user.click(boxOf(title));
}

const panel = () => screen.queryByRole('region', { name: 'Articles to analyze' });

const namedIn = (region: HTMLElement) =>
  within(within(region).getByRole('list', { name: 'Selected articles' }))
    .getAllByRole('listitem')
    .map((entry) => entry.textContent);

const sendButton = (name: string | RegExp) => screen.getByRole('button', { name });

async function go(app: App, to: string, params: Record<string, string> = {}) {
  await act(async () => {
    await app.router.navigate({ to, params } as never);
  });
}

describe('which rows have a checkbox', () => {
  const ROWS = [
    item(1),
    item(2, { analysis: asked('pending', 2) }),
    item(3, { analysis: asked('running', 3) }),
    item(4, { analysis: asked('complete', 4) }),
    item(5, { analysis: asked('failed', 5) }),
    item(6, { analysis: asked('cancelled', 6) }),
  ];

  it.each<Mode>(['off', 'training', 'active'])(
    'are on the rows nobody is analyzing in a feed that is %s, and nothing is selected',
    async (mode) => {
      const { app } = await openFeed(ROWS, { subscriptions: [verge(mode)] });

      expect(withBox(titles(6))).toEqual(['Article 1', 'Article 5', 'Article 6']);
      expect(screen.getAllByRole('checkbox')).toHaveLength(3);
      expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
      expect(ticked(titles(6))).toEqual([]);
      expect(panel()).toBeNull();
      expect(app.calls(ANALYZE)).toHaveLength(0);
    },
  );

  it('are on the rows of a lane of a feed too', async () => {
    await openFeed([item(1), item(2)], { path: '/read/feed/7?lane=maybe' });

    expect(withBox(titles(2))).toEqual(['Article 1', 'Article 2']);
  });

  it('are named after the title', async () => {
    await openFeed([item(1, { title: 'Solid-state batteries & the “pilot” line' })]);

    expect(
      within(rowOf('Solid-state batteries & the “pilot” line')).getByRole('checkbox', {
        name: 'Select Solid-state batteries & the “pilot” line',
      }),
    ).not.toBeChecked();
  });

  it('are not on the rows of a feed the person does not follow', async () => {
    const { app } = await openFeed([item(1), item(2)], {
      path: '/read/feed/7',
      subscriptions: [other],
    });
    expect(withBox(titles(2))).toEqual([]);

    await go(app, '/read/feed/$feedId', { feedId: '8' });
    await screen.findByRole('article', { name: 'Elsewhere 21' });
    expect(withBox(['Elsewhere 21'])).toEqual(['Elsewhere 21']);
  });

  it('are in a feed and in no other view', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    expect(withBox(titles(2))).toEqual(['Article 1', 'Article 2']);

    const views = [
      ['/read/$lane', { lane: 'for_you' }],
      ['/read/$lane', { lane: 'maybe' }],
      ['/read/$lane', { lane: 'everything' }],
      ['/read/$lane', { lane: 'new' }],
      ['/read/$lane', { lane: 'bookmarks' }],
      ['/read/$lane', { lane: 'hidden' }],
      ['/read/folder/$name', { name: 'News' }],
      ['/read/label/$labelId', { labelId: '12' }],
    ] as const;
    for (const [to, params] of views) {
      await go(app, to, params);
      await screen.findByRole('article', { name: 'Elsewhere 21' });
      expect(screen.queryAllByRole('checkbox'), JSON.stringify(params)).toEqual([]);
      expect(panel()).toBeNull();
    }
  });
});

describe('choosing articles', () => {
  it('shows the exact titles in the order they were chosen and sends nothing', async () => {
    const tricky = ['A <b>bold</b> claim', 'Solid-state batteries & the “pilot” line'];
    const { app } = await openFeed([
      item(1, { title: tricky[0]! }),
      item(2),
      item(3, { title: tricky[1]! }),
    ]);

    await choose(app, tricky[1]!, 'Article 2', tricky[0]!);

    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(namedIn(region)).toEqual([tricky[1], 'Article 2', tricky[0]]);
    expect(within(region).getByText('3 of 20 selected')).toBeVisible();
    expect(ticked([tricky[0]!, 'Article 2', tricky[1]!])).toHaveLength(3);
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('puts the panel above the rows, in the list', async () => {
    const { app } = await openFeed([item(1), item(2)]);

    await choose(app, 'Article 2');

    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    const rows = rowOf('Article 1').closest('ul')!;
    expect(rows.parentElement).toContainElement(region);
    expect(region.compareDocumentPosition(rowOf('Article 1'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('takes an article out again, and the panel goes with the last one', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1', 'Article 2');

    await choose(app, 'Article 1');

    expect(namedIn(screen.getByRole('region', { name: 'Articles to analyze' }))).toEqual([
      'Article 2',
    ]);
    expect(ticked(titles(2))).toEqual(['Article 2']);
    await choose(app, 'Article 2');
    expect(panel()).toBeNull();
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('selects nothing by itself: not on arrival, not for an article that arrives later', async () => {
    const { app, served } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1');
    served.items = [item(3), item(1), item(2)];

    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await screen.findByRole('article', { name: 'Article 3' });
    expect(withBox(titles(3))).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(ticked(titles(3))).toEqual(['Article 1']);
    expect(namedIn(screen.getByRole('region', { name: 'Articles to analyze' }))).toEqual([
      'Article 1',
    ]);
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('refuses a 21st article, says so, and sends the 20', async () => {
    const { app } = await openFeed(numbered(21));
    await choose(app, ...titles(20));
    expect(screen.getByText('20 of 20 selected')).toBeVisible();

    await app.user.click(boxOf('Article 21'));

    expect(await findToast('You can select at most 20 articles at a time.')).toBeVisible();
    expect(boxOf('Article 21')).not.toBeChecked();
    expect(screen.getByText('20 of 20 selected')).toBeVisible();
    expect(app.calls(ANALYZE)).toHaveLength(0);

    await app.user.click(sendButton('Analyze selected 20 articles'));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const { articles } = bodyOf(app.calls(ANALYZE)[0]!) as { articles: { id: string }[] };
    expect(articles.map(({ id }) => id)).toEqual(titles(20).map((_title, i) => String(i + 1)));
  });
});

describe('the selection belongs to the view', () => {
  const MOVES = [
    ['another feed', '/read/feed/$feedId', { feedId: '8' }],
    ['a lane', '/read/$lane', { lane: 'new' }],
    ['a folder', '/read/folder/$name', { name: 'News' }],
    ['a label', '/read/label/$labelId', { labelId: '12' }],
  ] as const;

  it.each(MOVES)('is gone after a move to %s and back', async (_name, to, params) => {
    const { app } = await openFeed([item(1), item(2), item(3)]);
    await choose(app, 'Article 1', 'Article 2');
    expect(panel()).not.toBeNull();

    await go(app, to, params);
    await screen.findByRole('article', { name: 'Elsewhere 21' });
    expect(panel()).toBeNull();
    expect(ticked(['Elsewhere 21'])).toEqual([]);

    await go(app, '/read/feed/$feedId', { feedId: '7' });
    await screen.findByRole('article', { name: 'Article 1' });
    expect(withBox(titles(3))).toEqual(titles(3));
    expect(ticked(titles(3))).toEqual([]);
    expect(panel()).toBeNull();
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('is gone after the lane of the feed is changed from the header', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1');

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'new');
    await screen.findByRole('article', { name: 'Elsewhere 21' });
    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');

    await screen.findByRole('article', { name: 'Article 1' });
    expect(ticked(titles(2))).toEqual([]);
    expect(panel()).toBeNull();
  });
});

describe('sending the selected articles', () => {
  it.each<[Mode, string, Record<string, unknown>]>([
    ['training', 'Analyze selected 3 articles', {}],
    ['active', 'Analyze selected 3 articles', {}],
    ['off', 'Start training and analyze these 3', { startTraining: true }],
  ])('sends one request with exactly them for a feed that is %s', async (mode, label, extra) => {
    const { app } = await openFeed(
      [
        item(1),
        item(2),
        item(3, { contentRevision: '9' }),
        item(4, { contentRevision: '6', analysis: asked('failed', 4) }),
      ],
      { subscriptions: [verge(mode)] },
    );
    await choose(app, 'Article 4', 'Article 1', 'Article 3');
    expect(app.calls(ANALYZE)).toHaveLength(0);

    await app.user.click(sendButton(label));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const [request] = app.calls(ANALYZE);
    expect(request!.pathname).toBe('/api/v1/subscriptions/7/analyze');
    expect(bodyOf(request!)).toStrictEqual({
      articles: [
        { id: '4', contentRevision: '6' },
        { id: '1', contentRevision: '2' },
        { id: '3', contentRevision: '9' },
      ],
      expectedInferenceVersion: '5',
      ...extra,
    });
  });

  it('says that an off feed is switched to training by the same button', async () => {
    const { app } = await openFeed([item(1), item(2)], { subscriptions: [verge('off')] });

    await choose(app, 'Article 1');

    expect(
      within(screen.getByRole('region', { name: 'Articles to analyze' })).getByText(
        'This switches the feed to Training: only the articles you select are analyzed.',
      ),
    ).toBeVisible();
    expect(sendButton('Start training and analyze this article')).toBeEnabled();
  });

  it('clears the selection, loads the list again and says where each request stands', async () => {
    const { app } = await openFeed([item(1), item(2), item(3), item(4)]);
    await choose(app, 'Article 1', 'Article 3');
    const loaded = listQueries(app).length;

    await app.user.click(sendButton('Analyze selected 2 articles'));

    await waitFor(() => expect(panel()).toBeNull());
    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(loaded));
    expect(await within(rowOf('Article 1')).findByText('Queued for analysis')).toBeVisible();
    expect(within(rowOf('Article 3')).getByText('Queued for analysis')).toBeVisible();
    expect(withBox(titles(4))).toEqual(['Article 2', 'Article 4']);
    expect(ticked(titles(4))).toEqual([]);
    for (const title of ['Article 2', 'Article 4']) {
      expect(within(rowOf(title)).getByText('Not analyzed')).toBeVisible();
      expect(within(rowOf(title)).queryByText(/analysis|analyzing/i)).toBeNull();
    }
    expect(app.calls(ANALYZE)).toHaveLength(1);
  });

  it('carries the request of a selected article with its like, and none with a sibling’s', async () => {
    const { app } = await openFeed([item(1), item(2), item(3)]);
    await choose(app, 'Article 1');
    await app.user.click(sendButton('Analyze selected 1 article'));
    await within(rowOf('Article 1')).findByText('Queued for analysis');

    await app.user.click(likeOf('Article 1'));
    await app.user.click(likeOf('Article 3'));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    const bodies = app.calls(RATE).map((request) => ({
      url: request.pathname,
      body: bodyOf(request) as Record<string, unknown>,
    }));
    const liked = (id: string) => bodies.find(({ url }) => url === `/api/v1/articles/${id}/rating`);
    expect(liked('1')?.body).toMatchObject({ rating: 1, analysisRequestId: requestId(1) });
    expect(liked('3')?.body).toMatchObject({ rating: 1 });
    expect(liked('3')?.body).not.toHaveProperty('analysisRequestId');
  });

  it('drops the articles the API found changed, says how many, and lets the person choose again', async () => {
    const refused: ApiRouteHandler = () => failure(409, 'STALE_STATE', { articleIds: ['2'] });
    const { app, server, served } = await openFeed([item(1), item(2), item(3)], {
      routes: { [ANALYZE]: refused },
    });
    await choose(app, 'Article 1', 'Article 2', 'Article 3');
    const changed = item(2, { contentRevision: '3', excerpt: 'Article 2 was corrected' });
    served.items = [item(1), changed, item(3)];

    await app.user.click(sendButton('Analyze selected 3 articles'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 selected article changed and was removed from your selection. Check the list, then analyze again.',
    );
    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(namedIn(region)).toEqual(['Article 1', 'Article 3']);
    expect(ticked(titles(3))).toEqual(['Article 1', 'Article 3']);
    await screen.findByText('Article 2 was corrected');

    server.routes[ANALYZE] = accepts(served);
    await choose(app, 'Article 2');
    await app.user.click(sendButton('Analyze selected 3 articles'));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(2));
    expect(bodyOf(app.calls(ANALYZE)[1]!)).toStrictEqual({
      articles: [
        { id: '1', contentRevision: '2' },
        { id: '3', contentRevision: '2' },
        { id: '2', contentRevision: '3' },
      ],
      expectedInferenceVersion: '5',
    });
  });

  it('keeps saying why when every selected article changed', async () => {
    const { app } = await openFeed([item(1), item(2)], {
      routes: { [ANALYZE]: () => failure(409, 'STALE_STATE', { articleIds: ['1'] }) },
    });
    await choose(app, 'Article 1');

    await app.user.click(sendButton('Analyze selected 1 article'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 selected article changed and was removed from your selection.',
    );
    expect(ticked(titles(2))).toEqual([]);
    expect(
      within(screen.getByRole('region', { name: 'Articles to analyze' })).getByText(
        '0 of 20 selected',
      ),
    ).toBeVisible();
  });
});

describe('what the controls offer', () => {
  it('names every control, makes it 44 px high and gives it a focus ring', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1');

    for (const [index, box] of screen.getAllByRole('checkbox').entries()) {
      expect(box).toHaveAccessibleName(`Select Article ${index + 1}`);
      expect(box.closest('label')?.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(box.className).toContain(token);
    }
    const send = sendButton('Analyze selected 1 article');
    expect(send.className).toContain('min-h-11');
    for (const token of FOCUS_RING.split(' ')) expect(send.className).toContain(token);
  });

  it('can be used from the keyboard', async () => {
    const { app } = await openFeed([item(1), item(2)]);

    boxOf('Article 2').focus();
    await app.user.keyboard(' ');
    expect(ticked(titles(2))).toEqual(['Article 2']);
    await app.user.keyboard(' ');

    expect(ticked(titles(2))).toEqual([]);
    expect(panel()).toBeNull();
  });
});

describe('in Slovak', () => {
  it('words the checkboxes, the panel and the requests', async () => {
    const { app } = await openFeed(
      [item(1), item(2), item(3), item(4, { analysis: asked('failed', 4) })],
      { me: makeMe({ locale: 'sk' }) },
    );
    expect(boxOf('Article 1')).toHaveAccessibleName('Vybrať Article 1');

    await choose(app, 'Article 1', 'Article 3');

    const region = screen.getByRole('region', { name: 'Články na analýzu' });
    expect(within(region).getByText('Vybrané: 2 z 20')).toBeVisible();
    await app.user.click(sendButton('Analyzovať 2 vybrané články'));

    expect(await within(rowOf('Article 1')).findByText('Čaká na analýzu')).toBeVisible();
    expect(within(rowOf('Article 3')).getByText('Čaká na analýzu')).toBeVisible();
    expect(within(rowOf('Article 4')).getByText('Analýza zlyhala')).toBeVisible();
    expect(within(rowOf('Article 2')).getByText('Neanalyzované')).toBeVisible();
  });
});
