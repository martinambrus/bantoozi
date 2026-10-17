import type { ArticleListItem, Subscription } from '@bantoozi/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { failure, json } from '../api/fake-fetch.js';
import { actionResponse, deferred, makeDetail } from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { makeCard } from '../interests/support.js';
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
import { acked } from './actions/fake-transport.js';

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
  overDailyCap: null,
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
  /** While it is set, the reads of the articles are answered only once it settles. */
  hold?: Promise<unknown> | undefined;
}

/** Answers after `served.hold`, if there is one. */
function afterHold(served: Served, answer: () => Response) {
  return served.hold === undefined ? answer() : served.hold.then(answer);
}

/** `POST /subscriptions/:feedId/analyze` as the API answers it: 202, and the articles are requested. */
function accepts(served: Served): ApiRouteHandler {
  return (request) => {
    const { articles, expectedInferenceVersion, startTraining } = bodyOf(request) as {
      articles: { id: string }[];
      expectedInferenceVersion: string;
      startTraining?: boolean;
    };
    const ids = articles.map(({ id }) => id);
    served.items = served.items.map((row) =>
      ids.includes(row.id) ? { ...row, analysis: asked('pending', Number(row.id)) } : row,
    );
    return json(202, {
      requests: ids.map((id) => ({ id: requestId(Number(id)), articleId: id, status: 'pending' })),
      inference: {
        mode: 'training',
        version:
          startTraining === true
            ? String(BigInt(expectedInferenceVersion) + 1n)
            : expectedInferenceVersion,
      },
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
      afterHold(served, () =>
        json(
          200,
          page(
            request.query.get('feedId') === '7' && request.query.get('lane') !== 'new'
              ? served.items
              : [elsewhere],
          ),
        ),
      ),
    routes: {
      [ANALYZE]: accepts(served),
      'GET /articles/:id': (_request, params) =>
        afterHold(served, () =>
          json(
            200,
            makeDetail(
              served.items.find((row) => row.id === params['id']) ?? item(params['id'] ?? '0'),
            ),
          ),
        ),
      ...rest.routes,
    },
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

const sendButton = (name: string | RegExp) => screen.getByRole('button', { name });

/** The button that opens the row of `title`, which is where the focus is meant to land. */
const titleOf = (title: string) => rowOf(title).querySelector('h3 button');

/** The list is read again, as it is when something else the person did makes it stale. */
async function reload(app: App) {
  await act(async () => {
    await app.queryClient.refetchQueries({ type: 'active' });
  });
}

const accepted = (...ids: number[]) =>
  json(202, {
    requests: ids.map((id) => ({ id: requestId(id), articleId: String(id), status: 'pending' })),
    inference: { mode: 'training', version: '5' },
  });

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
    'are on every row of a feed that is %s, and nothing is selected',
    async (mode) => {
      const { app } = await openFeed(ROWS, { subscriptions: [verge(mode)] });

      expect(withBox(titles(6))).toEqual(titles(6));
      expect(screen.getAllByRole('checkbox')).toHaveLength(7);
      expect(screen.getByRole('checkbox', { name: 'Select all articles' })).not.toBeChecked();
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
  it('counts the articles chosen, whatever their titles, and sends nothing', async () => {
    const tricky = ['A <b>bold</b> claim', 'Solid-state batteries & the “pilot” line'];
    const { app } = await openFeed([
      item(1, { title: tricky[0]! }),
      item(2),
      item(3, { title: tricky[1]! }),
    ]);

    await choose(app, tricky[1]!, 'Article 2', tricky[0]!);

    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(within(region).getByText('3 selected')).toBeVisible();
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
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('has no limit: 25 loaded rows can all be selected', async () => {
    const { app } = await openFeed(numbered(25));
    // Reuse the row controls: repeatedly resolving each article's accessible name across the
    // whole list makes these 25 independent clicks exceed the CI timeout under coverage.
    const checkboxes = screen.getAllByRole('checkbox', { name: /^Select Article \d+$/ });
    expect(checkboxes).toHaveLength(25);
    for (const checkbox of checkboxes) await app.user.click(checkbox);

    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    expect(screen.getByText('25 selected')).toBeVisible();
    expect(screen.queryByText(/at most/)).toBeNull();
  });
});

describe('select all', () => {
  const all = () => screen.getByRole('checkbox', { name: /^(Select|Deselect) all articles$/ });

  it('is a tri-state checkbox above the rows of a feed, and in no other view', async () => {
    const { app } = await openFeed(numbered(3));
    const box = all();
    expect(box).toHaveAccessibleName('Select all articles');
    expect(box).not.toBeChecked();
    expect(box).not.toBePartiallyChecked();
    expect(box.compareDocumentPosition(rowOf('Article 1'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await choose(app, 'Article 2');
    expect(all()).toBePartiallyChecked();
    expect(all()).toHaveAccessibleName('Select all articles');

    await go(app, '/read/$lane', { lane: 'new' });
    await screen.findByRole('article', { name: 'Elsewhere 21' });
    expect(screen.queryByRole('checkbox', { name: /all articles/ })).toBeNull();
  });

  it('deselects the articles a reload dropped too, when every row it loaded is selected', async () => {
    const { app, served } = await openFeed(numbered(3));
    await app.user.click(all());
    expect(ticked(titles(3))).toEqual(titles(3));

    served.items = numbered(2);
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 3' })).toBeNull());
    expect(all()).toHaveAccessibleName('Deselect all articles');

    await app.user.click(all());
    expect(panel()).toBeNull();
  });

  it('lets go of the selection when a reload leaves the list empty', async () => {
    const { app, served } = await openFeed(numbered(3));
    await choose(app, 'Article 2');
    expect(panel()).not.toBeNull();

    served.items = [];
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 1' })).toBeNull());
    served.items = numbered(3);
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('article', { name: 'Article 1' });

    expect(ticked(titles(3))).toEqual([]);
    expect(panel()).toBeNull();
  });

  it('selects every loaded row from none or some, and deselects all when all are selected', async () => {
    const { app } = await openFeed(numbered(3));

    await app.user.click(all());
    expect(ticked(titles(3))).toEqual(titles(3));
    expect(all()).toBeChecked();
    expect(all()).toHaveAccessibleName('Deselect all articles');

    await app.user.click(all());
    expect(ticked(titles(3))).toEqual([]);
    expect(panel()).toBeNull();

    await choose(app, 'Article 1');
    await app.user.click(all());
    expect(ticked(titles(3))).toEqual(titles(3));
    expect(screen.getByText('3 selected')).toBeVisible();
  });

  it('ticks all 25 loaded rows; Analyze sends 20 of them, then the next 5', async () => {
    const { app } = await openFeed(numbered(25));
    await app.user.click(all());
    expect(ticked(titles(25))).toHaveLength(25);
    expect(screen.getByText('25 selected')).toBeVisible();

    await app.user.click(sendButton('Analyze 20 of 25'));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const { articles } = bodyOf(app.calls(ANALYZE)[0]!) as { articles: { id: string }[] };
    expect(articles.map(({ id }) => id)).toEqual(titles(20).map((_title, i) => String(i + 1)));
    await app.user.click(
      await screen.findByRole('button', { name: 'Analyze selected 5 articles' }),
    );
    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(2));
    const second = bodyOf(app.calls(ANALYZE)[1]!) as { articles: { id: string }[] };
    expect(second.articles.map(({ id }) => id)).toEqual(['21', '22', '23', '24', '25']);
  });

  it('rates all 25 selected articles with Like', async () => {
    const { app } = await openFeed(numbered(25), {
      routes: { [RATE]: () => json(200, { ok: true }) },
    });
    await app.user.click(all());

    await app.user.click(sendButton('Like 25 selected articles'));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(25));
    await waitFor(() => expect(panel()).toBeNull());
  });
});

describe('an article the list no longer holds', () => {
  const selectAll = (app: App) =>
    app.user.click(screen.getByRole('checkbox', { name: 'Select all articles' }));

  it('leaves the selection when the next load omits it (rated elsewhere), and a bulk Dislike sends nothing for it', async () => {
    const { app, served } = await openFeed(numbered(3), {
      routes: { [RATE]: () => json(200, { ok: true }) },
    });
    await selectAll(app);
    expect(within(panel()!).getByText('3 selected')).toBeVisible();

    served.items = [item(1), item(3)];
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 2' })).toBeNull());

    await waitFor(() => expect(within(panel()!).getByText('2 selected')).toBeVisible());
    expect(ticked(['Article 1', 'Article 3'])).toEqual(['Article 1', 'Article 3']);
    await app.user.click(
      within(panel()!).getByRole('button', { name: /^Dislike 2 selected articles$/ }),
    );
    await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(app.calls(RATE).map((request) => request.pathname)).toEqual([
      '/api/v1/articles/1/rating',
      '/api/v1/articles/3/rating',
    ]);
  });

  it('drops the selected articles of a later page when a refresh returns page one only', async () => {
    const { app, served } = await openFeed(numbered(25));
    await selectAll(app);
    expect(within(panel()!).getByText('25 selected')).toBeVisible();

    served.items = numbered(20);
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 21' })).toBeNull());

    await waitFor(() => expect(within(panel()!).getByText('20 selected')).toBeVisible());
    expect(ticked(titles(20))).toEqual(titles(20));
  });
});

describe('reading the selection as it is now', () => {
  it('sends the next batch of an off feed with the version the answer reported, however the list is read', async () => {
    const sent: { count: () => number } = { count: () => 0 };
    const { app } = await openFeed(numbered(25), {
      subscriptions: [verge('off'), other],
      // The list is read again after the answer, but that read is still on its way.
      routes: {
        'GET /subscriptions': () =>
          sent.count() === 0
            ? json(200, [verge('off'), other])
            : new Promise<Response>(() => undefined),
      },
    });
    sent.count = () => app.calls(ANALYZE).length;
    await app.user.click(
      screen.getByRole('checkbox', { name: /^(Select|Deselect) all articles$/ }),
    );

    await app.user.click(sendButton(/^Start training and analyze 20 of 25$/));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    await app.user.click(
      await screen.findByRole('button', { name: 'Analyze selected 5 articles' }),
    );

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(2));
    expect(bodyOf(app.calls(ANALYZE)[1]!)).toMatchObject({ expectedInferenceVersion: '6' });
    expect(bodyOf(app.calls(ANALYZE)[1]!)).not.toHaveProperty('startTraining');
  });

  it('does not send a selected article whose analysis has started since', async () => {
    const { app, served } = await openFeed(numbered(3));
    await choose(app, 'Article 1', 'Article 2');
    expect(sendButton('Analyze selected 2 articles')).toBeEnabled();
    served.items = served.items.map((row) =>
      row.id === '1' ? { ...row, analysis: asked('pending', 1) } : row,
    );

    await reload(app);

    await app.user.click(await screen.findByRole('button', { name: 'Analyze selected 1 article' }));
    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const { articles } = bodyOf(app.calls(ANALYZE)[0]!) as { articles: { id: string }[] };
    expect(articles.map(({ id }) => id)).toEqual(['2']);
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
        { id: '1', contentRevision: '2' },
        { id: '3', contentRevision: '9' },
        { id: '4', contentRevision: '6' },
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
    expect(withBox(titles(4))).toEqual(titles(4));
    expect(ticked(titles(4))).toEqual([]);
    for (const title of ['Article 2', 'Article 4']) {
      expect(within(rowOf(title)).getByText('Not analyzed')).toBeVisible();
      expect(within(rowOf(title)).queryByText(/analysis|analyzing/i)).toBeNull();
    }
    expect(app.calls(ANALYZE)).toHaveLength(1);
  });

  it('keeps an article chosen while the others were being sent, and the panel with it', async () => {
    const { app, server } = await openFeed([item(1), item(2), item(3), item(4)]);
    const answer = deferred<void>();
    const accept = server.routes[ANALYZE]!;
    server.routes[ANALYZE] = async (request, params) => {
      await answer.promise;
      return accept(request, params);
    };
    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));
    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));

    await choose(app, 'Article 3');
    answer.resolve(undefined);

    expect(await within(rowOf('Article 1')).findByText('Queued for analysis')).toBeVisible();
    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(within(region).getByText('1 selected')).toBeVisible();
    expect(ticked(titles(4))).toEqual(['Article 3']);
    await waitFor(() => expect(sendButton('Analyze selected 1 article')).toBeEnabled());
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

  it('carries the request of a sent article with its like before the list is loaded again', async () => {
    const { app, served } = await openFeed([item(1), item(2), item(3)]);
    await choose(app, 'Article 1', 'Article 2');
    const reloaded = deferred<void>();
    served.hold = reloaded.promise;
    const loaded = listQueries(app).length;

    await app.user.click(sendButton('Analyze selected 2 articles'));

    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(loaded));
    // A rated row leaves an unread list after a moment, so what the rows say is read first.
    const shown = titles(3).map((title) => within(rowOf(title)).queryByText(/analysis|analyzed/i));
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
    expect(shown.map((badge) => badge?.textContent)).toEqual([
      'Queued for analysis',
      'Queued for analysis',
      'Not analyzed',
    ]);
    reloaded.resolve(undefined);
  });

  it('carries the request of the open article with a like from its detail before it is loaded again', async () => {
    const { app, served } = await openFeed([item(1), item(2)]);
    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    const pane = await screen.findByRole('complementary', { name: 'Article' });
    await within(pane).findByRole('button', { name: 'Read original' });
    await choose(app, 'Article 1');
    const reloaded = deferred<void>();
    served.hold = reloaded.promise;
    const loaded = listQueries(app).length;

    await app.user.click(sendButton('Analyze selected 1 article'));

    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(loaded));
    await app.user.click(within(pane).getByRole('button', { name: 'Like' }));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({
      rating: 1,
      analysisRequestId: requestId(1),
    });
    reloaded.resolve(undefined);
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
    expect(ticked(titles(3))).toEqual(['Article 1', 'Article 3']);
    await screen.findByText('Article 2 was corrected');

    server.routes[ANALYZE] = accepts(served);
    await choose(app, 'Article 2');
    await app.user.click(sendButton('Analyze selected 3 articles'));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(2));
    expect(bodyOf(app.calls(ANALYZE)[1]!)).toStrictEqual({
      articles: [
        { id: '1', contentRevision: '2' },
        { id: '2', contentRevision: '3' },
        { id: '3', contentRevision: '2' },
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
      within(screen.getByRole('region', { name: 'Articles to analyze' })).getByText('0 selected'),
    ).toBeVisible();
  });
});

describe('where the focus goes when the selection is sent', () => {
  it('is the title of the first article sent, in list order', async () => {
    const { app } = await openFeed([item(1), item(2), item(3)]);
    await choose(app, 'Article 3', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));

    await waitFor(() => expect(panel()).toBeNull());

    expect(document.activeElement).toBe(titleOf('Article 2'));
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    expect(await within(rowOf('Article 2')).findByText('Queued for analysis')).toBeVisible();
    expect(document.activeElement).toBe(titleOf('Article 2'));
  });

  it('is the title of the first article sent that the list still has', async () => {
    const answer = deferred<Response>();
    const { app, served } = await openFeed([item(1), item(2), item(3)], {
      routes: { [ANALYZE]: () => answer.promise },
    });
    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));
    served.items = [item(2), item(3)];
    await reload(app);
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 1' })).toBeNull());

    answer.resolve(accepted(1, 2));

    await waitFor(() => expect(panel()).toBeNull());
    expect(document.activeElement).toBe(titleOf('Article 2'));
  });

  it('is the list when none of the articles sent is in it any more', async () => {
    const answer = deferred<Response>();
    const { app, served } = await openFeed([item(1), item(2), item(3)], {
      routes: { [ANALYZE]: () => answer.promise },
    });
    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));
    served.items = [item(3)];
    await reload(app);
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Article 2' })).toBeNull());

    answer.resolve(accepted(1, 2));

    await waitFor(() => expect(panel()).toBeNull());
    const list = rowOf('Article 3').closest('ul');
    expect(list).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(list);
  });

  it('stays where the person took it while the articles were sent', async () => {
    const answer = deferred<Response>();
    const { app } = await openFeed([item(1), item(2), item(3)], {
      routes: { [ANALYZE]: () => answer.promise },
    });
    await choose(app, 'Article 1');
    await app.user.click(sendButton('Analyze selected 1 article'));
    const box = boxOf('Article 3');
    act(() => {
      box.focus();
    });

    answer.resolve(accepted(1));

    await waitFor(() => expect(panel()).toBeNull());
    expect(box).toHaveFocus();
  });
});

describe('taking a chosen article out', () => {
  it('is the checkbox of its row, which takes that article out and nothing else', async () => {
    const { app } = await openFeed([item(1), item(2), item(3)]);
    await choose(app, 'Article 1', 'Article 2', 'Article 3');

    await choose(app, 'Article 2');

    const region = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(ticked(titles(3))).toEqual(['Article 1', 'Article 3']);
    expect(within(region).getByText('2 selected')).toBeVisible();
    expect(sendButton('Analyze selected 2 articles')).toBeEnabled();
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('takes the panel away with the last one, also after a refusal dropped some', async () => {
    const { app } = await openFeed([item(1), item(2)], {
      routes: { [ANALYZE]: () => failure(409, 'STALE_STATE', { articleIds: ['2'] }) },
    });
    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));
    expect(await screen.findByRole('alert')).toBeVisible();

    await choose(app, 'Article 1');

    expect(panel()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the message about a refused request', () => {
  const REFUSED = '1 selected article changed and was removed from your selection.';
  const refusing = (articleIds: string[]) => ({
    [ANALYZE]: () => failure(409, 'STALE_STATE', { articleIds }),
  });

  /** Chooses 1 to 3, has `articleIds` refused as changed, and waits until the list was read again. */
  async function refused(articleIds: string[]) {
    const opened = await openFeed([item(1), item(2), item(3), item(4)], {
      routes: refusing(articleIds),
    });
    await choose(opened.app, 'Article 1', 'Article 2', 'Article 3');
    const loaded = listQueries(opened.app).length;
    await opened.app.user.click(sendButton('Analyze selected 3 articles'));
    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
    await waitFor(() => expect(listQueries(opened.app).length).toBeGreaterThan(loaded));
    await waitFor(() => expect(opened.app.queryClient.isFetching()).toBe(0));
    return opened;
  }

  it('stays after the articles it names were dropped, for as long as the selection is the same', async () => {
    await refused(['2']);

    expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
    expect(ticked(titles(4))).toEqual(['Article 1', 'Article 3']);
  });

  it('is gone when the person chooses another article', async () => {
    const { app } = await refused(['2']);

    await choose(app, 'Article 4');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(ticked(titles(4))).toEqual(['Article 1', 'Article 3', 'Article 4']);
  });

  it('is gone when the person chooses an article the refusal dropped', async () => {
    const { app } = await refused(['2']);

    await choose(app, 'Article 2');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is gone when the person chooses the last article again, which makes the selection that was sent', async () => {
    const { app } = await refused(['3']);
    expect(ticked(titles(4))).toEqual(['Article 1', 'Article 2']);

    await choose(app, 'Article 3');

    expect(ticked(titles(4))).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is gone when the person takes a chosen article off its row', async () => {
    const { app } = await refused(['2']);

    await choose(app, 'Article 1');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(ticked(titles(4))).toEqual(['Article 3']);
  });

  it('stays, with the panel, when it emptied the selection, and is gone when the person chooses one', async () => {
    const { app } = await openFeed([item(1), item(2)], { routes: refusing(['1']) });
    await choose(app, 'Article 1');
    await app.user.click(sendButton('Analyze selected 1 article'));
    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
    expect(panel()).not.toBeNull();

    await choose(app, 'Article 2');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Articles to analyze' })).getByText('1 selected'),
    ).toBeVisible();
  });

  it('about anything else than changed articles stays until the person changes the selection', async () => {
    const { app } = await openFeed([item(1), item(2), item(3)], {
      routes: { [ANALYZE]: () => failure(429, 'RATE_LIMITED') },
    });
    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(sendButton('Analyze selected 2 articles'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Wait a moment and try again.');
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    expect(screen.getByRole('alert')).toBe(alert);

    await choose(app, 'Article 3');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is shown again by the next refusal after the person moved on', async () => {
    const { app } = await refused(['2']);
    await choose(app, 'Article 4');
    expect(screen.queryByRole('alert')).toBeNull();

    await app.user.click(sendButton('Analyze selected 3 articles'));

    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
  });
});

describe('what the controls offer', () => {
  it('names every control, makes it 44 px high and gives it a focus ring', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1');

    const [selectAll, ...boxes] = screen.getAllByRole('checkbox');
    expect(selectAll).toHaveAccessibleName('Select all articles');
    expect(selectAll!.closest('label')?.className).toContain('min-h-11');
    for (const [index, box] of boxes.entries()) {
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

  it('names the buttons of the bar, makes them 44 px and gives them a focus ring', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1', 'Article 2');

    const buttons = within(panel()!).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      null,
      'Like 2 selected articles',
      'Dislike 2 selected articles',
    ]);
    for (const button of buttons) {
      expect(button.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(button.className).toContain(token);
    }
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
    expect(within(region).getByText('Vybrané: 2')).toBeVisible();
    await app.user.click(sendButton('Analyzovať 2 vybrané články'));

    expect(await within(rowOf('Article 1')).findByText('Čaká na analýzu')).toBeVisible();
    expect(within(rowOf('Article 3')).getByText('Čaká na analýzu')).toBeVisible();
    expect(within(rowOf('Article 4')).getByText('Analýza zlyhala')).toBeVisible();
    expect(within(rowOf('Article 2')).getByText('Neanalyzované')).toBeVisible();
  });
});

describe('the selection bar', () => {
  const bulk = (name: RegExp) => within(panel()!).getByRole('button', { name });

  const ratedBodies = (app: App) =>
    app.calls(RATE).map((request) => ({
      url: request.pathname,
      body: bodyOf(request) as Record<string, unknown>,
    }));

  it('shows the count and the buttons, with no titles and no buttons to take one out', async () => {
    const { app } = await openFeed([item(1), item(2)]);
    await choose(app, 'Article 1', 'Article 2');

    const region = panel()!;
    expect(within(region).getByText('2 selected')).toBeVisible();
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).queryByText('Article 1')).toBeNull();
    expect(within(region).queryAllByRole('button', { name: /^Remove / })).toEqual([]);
    expect(
      within(region)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Analyze selected 2 articles', 'Like', 'Dislike']);
    for (const button of within(region).getAllByRole('button')) {
      expect(button).toHaveAttribute('data-variant', 'primary');
    }
    expect(bulk(/^Like 2 selected articles$/)).toBeVisible();
    expect(bulk(/^Dislike 2 selected articles$/)).toBeVisible();
  });

  it('likes every selected article once, with the request of one that has it, and clears the selection', async () => {
    const { app } = await openFeed([item(1, { analysis: asked('failed', 1) }), item(2), item(3)]);
    await choose(app, 'Article 1', 'Article 2');

    await app.user.click(bulk(/^Like 2 selected articles$/));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    const sent = ratedBodies(app);
    const body = (id: string) => sent.find(({ url }) => url === `/api/v1/articles/${id}/rating`);
    expect(body('1')?.body).toMatchObject({ rating: 1, analysisRequestId: requestId(1) });
    expect(body('2')?.body).toMatchObject({ rating: 1 });
    expect(body('2')?.body).not.toHaveProperty('analysisRequestId');
    expect(panel()).toBeNull();
    expect(ticked(titles(3))).toEqual([]);
    expect(app.calls('POST /articles/rate-bulk')).toHaveLength(0);
  });

  it('offers one reason for the selected dislikes, preserves their analysis requests and clears the selection', async () => {
    const { app } = await openFeed([item(1, { analysis: asked('complete', 1) }), item(2), item(3)]);
    await choose(app, 'Article 1', 'Article 3');

    await app.user.click(bulk(/^Dislike 2 selected articles$/));

    expect(app.calls(RATE)).toHaveLength(0);
    expect(panel()).toBeNull();
    const reasons = screen.getByRole('group', { name: 'Reason for the dislike' });
    expect(
      within(reasons).getByText('Disliked 2 articles. Choose a reason for the selection.'),
    ).toBeVisible();
    await app.user.click(within(reasons).getByRole('button', { name: 'Off-topic' }));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(ratedBodies(app).map(({ url, body }) => [url, body['rating'], body['reason']])).toEqual([
      ['/api/v1/articles/1/rating', -1, 'off_topic'],
      ['/api/v1/articles/3/rating', -1, 'off_topic'],
    ]);
    expect(ratedBodies(app)[0]?.body).toHaveProperty('analysisRequestId', requestId(1));
    expect(panel()).toBeNull();
  });

  it('can undo the selected dislikes before sending any ratings', async () => {
    const { app } = await openFeed(numbered(2));
    await choose(app, ...titles(2));
    await app.user.click(bulk(/^Dislike 2 selected articles$/));
    const reasons = screen.getByRole('group', { name: 'Reason for the dislike' });
    await app.user.click(within(reasons).getByRole('button', { name: 'Undo' }));

    expect(screen.queryByRole('group', { name: 'Reason for the dislike' })).toBeNull();
    expect(app.calls(RATE)).toHaveLength(0);
    for (const title of titles(2)) {
      expect(within(rowOf(title)).getByRole('button', { name: 'Dislike' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('keeps an off-topic teaching offer when later ratings in the selection have no offer', async () => {
    const rows = numbered(2);
    const cards = deferred<Response>();
    const { app } = await openFeed(rows, {
      routes: {
        [RATE]: (_request, params) =>
          actionResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: -1 },
            ),
            {
              exampleSuggestion: params['id'] === '1' ? { cardId: '31', side: 'no' } : null,
              pattern: null,
            },
          ),
        'GET /cards': () => cards.promise,
      },
    });
    await choose(app, ...titles(2));
    await app.user.click(bulk(/^Dislike 2 selected articles$/));
    await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
    await waitFor(() => expect(app.calls('GET /cards')).toHaveLength(1));
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    await screen.findByText('Marked as disliked');

    cards.resolve(json(200, [makeCard({ id: '31', title: 'Škoda Vehicles' })]));

    expect(
      await screen.findByRole('button', { name: 'Teach Škoda Vehicles: not this' }),
    ).toBeVisible();
    expect(app.calls('POST /cards/:id/examples')).toHaveLength(0);
  });

  it('uses the shared reason for new dislikes and leaves already disliked articles alone', async () => {
    const { app } = await openFeed([
      item(1, { rating: -1, reason: 'off_topic' }),
      item(2),
      item(3),
    ]);
    await choose(app, ...titles(3));
    await app.user.click(bulk(/^Dislike 3 selected articles$/));
    await app.user.click(screen.getByRole('button', { name: 'Clickbait' }));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(ratedBodies(app).map(({ url, body }) => [url, body['reason']])).toEqual([
      ['/api/v1/articles/2/rating', 'clickbait'],
      ['/api/v1/articles/3/rating', 'clickbait'],
    ]);
  });

  it('bulk Like cancels selected pending dislikes and leaves unselected ones for their reason', async () => {
    const { app } = await openFeed([item(1), item(2, { rating: 1 }), item(3)], {
      me: makeMe({ preferences: { markReadOnRate: false } }),
    });
    await choose(app, ...titles(3));
    await app.user.click(bulk(/^Dislike 3 selected articles$/));
    expect(app.calls(RATE)).toHaveLength(0);

    await choose(app, 'Article 1', 'Article 2');
    await app.user.click(bulk(/^Like 2 selected articles$/));
    const reasons = screen.getByRole('group', { name: 'Reason for the dislike' });
    expect(within(reasons).getByText('Disliked: Article 3')).toBeVisible();
    await app.user.click(within(reasons).getByRole('button', { name: 'Off-topic' }));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(ratedBodies(app).map(({ url, body }) => [url, body['rating'], body['reason']])).toEqual([
      ['/api/v1/articles/1/rating', 1, undefined],
      ['/api/v1/articles/3/rating', -1, 'off_topic'],
    ]);
  });

  it('sets the pressed rating and never un-rates: articles that already have it are skipped', async () => {
    const { app } = await openFeed([item(1, { rating: 1 }), item(2, { rating: -1 }), item(3)]);
    await choose(app, 'Article 1', 'Article 2', 'Article 3');

    await app.user.click(bulk(/^Like 3 selected articles$/));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(ratedBodies(app).map(({ url, body }) => [url, body['rating']])).toEqual([
      ['/api/v1/articles/2/rating', 1],
      ['/api/v1/articles/3/rating', 1],
    ]);
    expect(panel()).toBeNull();
  });

  it('words the buttons in Slovak', async () => {
    const { app } = await openFeed([item(1), item(2)], { me: makeMe({ locale: 'sk' }) });
    await choose(app, 'Article 1', 'Article 2');

    const region = screen.getByRole('region', { name: 'Články na analýzu' });
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).getAllByRole('button')).toHaveLength(3);
    expect(within(region).getByRole('button', { name: /^Páči sa mi, vybrané: 2$/ })).toBeVisible();
    await app.user.click(
      within(region).getByRole('button', { name: /^Nepáči sa mi, vybrané: 2$/ }),
    );
    const reasons = screen.getByRole('group', { name: 'Dôvod nepáčenia' });
    expect(
      within(reasons).getByText('Nepáčia sa vám 2 články. Vyberte dôvod pre celý výber.'),
    ).toBeVisible();
    await app.user.click(within(reasons).getByRole('button', { name: 'Mimo témy' }));
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(ratedBodies(app).every(({ body }) => body['reason'] === 'off_topic')).toBe(true);
  });

  it('has a checkbox on every row, and Like rates an analyzed article too', async () => {
    const { app } = await openFeed([item(1), item(2, { analysis: asked('complete', 2) })]);
    expect(withBox(titles(2))).toEqual(['Article 1', 'Article 2']);
    await choose(app, 'Article 2');

    await app.user.click(bulk(/^Like 1 selected article$/));

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(ratedBodies(app)[0]).toMatchObject({
      url: '/api/v1/articles/2/rating',
      body: { rating: 1, analysisRequestId: requestId(2) },
    });
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('hides Analyze while only analyzed articles are selected, and still counts them', async () => {
    const { app } = await openFeed([
      item(1),
      item(2, { analysis: asked('complete', 2) }),
      item(3, { analysis: asked('pending', 3) }),
    ]);
    await choose(app, 'Article 2', 'Article 3');

    const region = panel()!;
    expect(within(region).getByText('2 selected')).toBeVisible();
    expect(within(region).queryByRole('button', { name: /Analyze|analyze/ })).toBeNull();
    expect(within(region).queryByText(/Select up to/)).toBeNull();
    expect(within(region).getAllByRole('button')).toHaveLength(2);

    await choose(app, 'Article 1');
    expect(sendButton('Analyze selected 1 article')).toBeEnabled();
  });

  it('sends only the analyzable articles of a mixed selection', async () => {
    const { app } = await openFeed([
      item(1),
      item(2, { analysis: asked('complete', 2) }),
      item(3, { analysis: asked('failed', 3) }),
    ]);
    await choose(app, 'Article 1', 'Article 2', 'Article 3');
    expect(within(panel()!).getByText('3 selected')).toBeVisible();

    await app.user.click(sendButton('Analyze selected 2 articles'));

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const { articles } = bodyOf(app.calls(ANALYZE)[0]!) as { articles: { id: string }[] };
    expect(articles.map(({ id }) => id)).toEqual(['1', '3']);
    await waitFor(() => expect(ticked(titles(3))).toEqual(['Article 2']));
    expect(within(panel()!).getByText('1 selected')).toBeVisible();
  });

  describe('an article rated or hidden on its own', () => {
    const selectAll = (app: App) =>
      app.user.click(screen.getByRole('checkbox', { name: 'Select all articles' }));

    it('leaves the selection, and a bulk Dislike then skips it', async () => {
      const { app } = await openFeed(numbered(3));
      await selectAll(app);
      expect(within(panel()!).getByText('3 selected')).toBeVisible();

      await app.user.click(likeOf('Article 2'));

      await waitFor(() => expect(within(panel()!).getByText('2 selected')).toBeVisible());
      expect(app.calls(RATE)).toHaveLength(1);
      await app.user.click(bulk(/^Dislike 2 selected articles$/));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await waitFor(() => expect(app.calls(RATE)).toHaveLength(3));
      expect(ratedBodies(app).map(({ url, body }) => [url, body['rating']])).toEqual([
        ['/api/v1/articles/2/rating', 1],
        ['/api/v1/articles/1/rating', -1],
        ['/api/v1/articles/3/rating', -1],
      ]);
      expect(panel()).toBeNull();
    });

    it('leaves the selection when it is hidden too', async () => {
      const { app } = await openFeed(numbered(3));
      await selectAll(app);

      fireEvent.click(likeOf('Article 2'), { shiftKey: true });

      await waitFor(() => expect(within(panel()!).getByText('2 selected')).toBeVisible());
      await app.user.click(bulk(/^Dislike 2 selected articles$/));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await waitFor(() => expect(app.calls(RATE)).toHaveLength(3));
      expect(
        ratedBodies(app)
          .filter(({ body }) => body['rating'] === -1)
          .map(({ url }) => url),
      ).toEqual(['/api/v1/articles/1/rating', '/api/v1/articles/3/rating']);
    });

    it('is unticked in a list that keeps rated rows (Show read)', async () => {
      const { app } = await openFeed(numbered(3), {
        me: makeMe({ preferences: { showRead: true } }),
      });
      await selectAll(app);

      await app.user.click(likeOf('Article 2'));

      await waitFor(() => expect(ticked(titles(3))).toEqual(['Article 1', 'Article 3']));
      expect(screen.getByRole('article', { name: 'Article 2' })).toBeVisible();
      expect(within(panel()!).getByText('2 selected')).toBeVisible();
      expect(screen.getByRole('checkbox', { name: 'Select all articles' })).toBePartiallyChecked();
    });

    it('does not touch the bulk buttons: Like rates every selected article and empties it', async () => {
      const { app } = await openFeed(numbered(3));
      await selectAll(app);

      await app.user.click(bulk(/^Like 3 selected articles$/));

      await waitFor(() => expect(app.calls(RATE)).toHaveLength(3));
      expect(ratedBodies(app).map(({ body }) => body['rating'])).toEqual([1, 1, 1]);
      expect(panel()).toBeNull();
    });
  });
});
