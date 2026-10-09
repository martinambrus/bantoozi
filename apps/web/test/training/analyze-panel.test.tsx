import type {
  ArticleDetail,
  ArticleListItem,
  ArticleListResponse,
  Subscription,
} from '@bantoozi/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { articleKeys } from '../../src/features/article/query-keys.js';
import { subscriptionsKey } from '../../src/features/feeds/subscriptions.js';
import { AnalyzePanel, type AnalyzePanelProps } from '../../src/features/training/analyze-panel.js';
import { useArticleSelection } from '../../src/features/training/selection.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import {
  deferred,
  makeDetail,
  renderReader,
  type ReaderHarnessOptions,
} from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { article, counts, requestId } from '../onboarding/support.js';
import { page } from '../reader/support.js';
import { USER_A_ID } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';

const ANALYZE = '/subscriptions/1/analyze';
const ROUTE = 'POST /subscriptions/:feedId/analyze';

const off = makeSubscription({ feed: { id: '1' }, inferenceMode: 'off', inferenceVersion: '1' });
const training = makeSubscription({
  feed: { id: '1' },
  inferenceMode: 'training',
  inferenceVersion: '4',
});
const active = makeSubscription({
  feed: { id: '1' },
  inferenceMode: 'active',
  inferenceVersion: '6',
});

const titles = ['Solid-state batteries & the “pilot” line', 'A <b>bold</b> claim', 'Third story'];
const picked = titles.map((title, index) =>
  article(String(index + 1), title, { contentRevision: String(7 + index * 2) }),
);

function many(count: number): ArticleListItem[] {
  return Array.from({ length: count }, (_unused, index) =>
    article(String(index + 1), `Article ${index + 1}`),
  );
}

const accepted: ApiRouteHandler = (request) =>
  json(202, {
    requests: (bodyOf(request) as { articles: { id: string }[] }).articles.map(({ id }) => ({
      id: requestId(Number(id)),
      articleId: id,
      status: 'pending',
    })),
  });

function renderPanel(props: Partial<AnalyzePanelProps> = {}, options: ReaderHarnessOptions = {}) {
  const onSubmitted = vi.fn();
  const onDrop = vi.fn();
  const view = renderReader(
    <AnalyzePanel
      subscription={off}
      items={picked}
      onSubmitted={onSubmitted}
      onDrop={onDrop}
      {...props}
    />,
    { routes: { [ROUTE]: accepted }, ...options },
  );
  return { ...view, onSubmitted, onDrop };
}

const send = (name: string | RegExp = /^(Start training and analyze|Analyze selected)/) =>
  screen.getByRole('button', { name });

const analyzed = (view: ReturnType<typeof renderPanel>) => view.calls('POST', ANALYZE);

/** Two cache entries the panel has to mark stale, with nobody watching them. */
function seed(view: ReturnType<typeof renderPanel>) {
  const subscriptions = subscriptionsKey(USER_A_ID);
  const articles = [...articleKeys.all(USER_A_ID), 'list', 'x'];
  view.queryClient.setQueryData<Subscription[]>(subscriptions, [off]);
  view.queryClient.setQueryData(articles, { items: [] });
  return {
    subscriptionsStale: () => view.queryClient.getQueryState(subscriptions)?.isInvalidated,
    articlesStale: () => view.queryClient.getQueryState(articles)?.isInvalidated,
  };
}

describe('before anything is sent', () => {
  it('lists the exact titles of the selected articles, in order, and sends nothing', () => {
    const view = renderPanel();

    const list = screen.getByRole('list', { name: 'Selected articles' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(titles);
    expect(screen.getByText('3 of 20 selected')).toBeVisible();
    expect(view.requests).toHaveLength(0);
  });

  it('is a region the page can find', () => {
    renderPanel();

    expect(screen.getByRole('region', { name: 'Articles to analyze' })).toBeVisible();
  });

  it.each<[string, number, string, Subscription]>([
    ['off', 2, 'Start training and analyze these 2', off],
    ['off', 1, 'Start training and analyze this article', off],
    ['off', 20, 'Start training and analyze these 20', off],
    ['training', 2, 'Analyze selected 2 articles', training],
    ['training', 1, 'Analyze selected 1 article', training],
    ['training', 20, 'Analyze selected 20 articles', training],
    ['active', 3, 'Analyze selected 3 articles', active],
  ])(
    'labels the button of a feed that is %s with %i articles "%s"',
    (_mode, count, label, subscription) => {
      renderPanel({ subscription, items: many(count) });

      expect(send()).toHaveAccessibleName(label);
      expect(send()).toBeEnabled();
      expect(screen.getByText(`${count} of 20 selected`)).toBeVisible();
    },
  );

  it.each<[string, Subscription]>([
    ['off', off],
    ['training', training],
  ])(
    'has nothing to send for a feed that is %s until an article is selected',
    (_mode, subscription) => {
      const view = renderPanel({ subscription, items: [] });

      expect(send('Select articles to analyze')).toBeDisabled();
      expect(screen.queryByRole('list', { name: 'Selected articles' })).not.toBeInTheDocument();
      expect(screen.getByText('0 of 20 selected')).toBeVisible();
      expect(view.requests).toHaveLength(0);
    },
  );

  it.each<[Subscription, number, string]>([
    [off, 1, 'Spustiť trénovanie a analyzovať tento článok'],
    [off, 2, 'Spustiť trénovanie a analyzovať tieto 2 články'],
    [off, 5, 'Spustiť trénovanie a analyzovať týchto 5 článkov'],
    [training, 1, 'Analyzovať 1 vybraný článok'],
    [training, 3, 'Analyzovať 3 vybrané články'],
    [training, 20, 'Analyzovať 20 vybraných článkov'],
    [training, 0, 'Vyberte články na analýzu'],
  ])('is written in Slovak, with its plural forms (%#)', (subscription, count, label) => {
    renderPanel({ subscription, items: many(count) }, { language: 'sk' });

    expect(screen.getByRole('button')).toHaveAccessibleName(label);
  });
});

describe('sending the selection', () => {
  it('names the exact revisions and starts training for a feed that is off', async () => {
    const view = renderPanel();

    await view.user.click(send('Start training and analyze these 3'));

    await waitFor(() => expect(analyzed(view)).toHaveLength(1));
    const [request] = analyzed(view);
    expect(bodyOf(request!)).toStrictEqual({
      articles: [
        { id: '1', contentRevision: '7' },
        { id: '2', contentRevision: '9' },
        { id: '3', contentRevision: '11' },
      ],
      expectedInferenceVersion: '1',
      startTraining: true,
    });
    expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
  });

  it.each([
    ['training', training, '4'],
    ['active', active, '6'],
  ])('sends no startTraining for a feed that is %s', async (_mode, subscription, version) => {
    const view = renderPanel({ subscription });

    await view.user.click(send('Analyze selected 3 articles'));

    await waitFor(() => expect(analyzed(view)).toHaveLength(1));
    expect(bodyOf(analyzed(view)[0]!)).toStrictEqual({
      articles: [
        { id: '1', contentRevision: '7' },
        { id: '2', contentRevision: '9' },
        { id: '3', contentRevision: '11' },
      ],
      expectedInferenceVersion: version,
    });
  });

  it('hands the new requests on, and marks the subscriptions and the articles stale', async () => {
    const view = renderPanel();
    const stale = seed(view);

    await view.user.click(send());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(view.onSubmitted).toHaveBeenCalledWith(
      picked.map(({ id }) => ({ id: requestId(Number(id)), articleId: id, status: 'pending' })),
      ['1', '2', '3'],
    );
    expect(stale.subscriptionsStale()).toBe(true);
    expect(stale.articlesStale()).toBe(true);
    expect(view.onDrop).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the articles that were sent, though more are selected when it is answered', async () => {
    const answer = deferred<Response>();
    const view = renderPanel({}, { routes: { [ROUTE]: () => answer.promise } });
    await view.user.click(send());
    await waitFor(() => expect(analyzed(view)).toHaveLength(1));

    view.rerender(
      <AnalyzePanel
        subscription={off}
        items={[...picked, article('4', 'Fourth story')]}
        onSubmitted={view.onSubmitted}
        onDrop={view.onDrop}
      />,
    );
    answer.resolve(
      json(202, {
        requests: picked.map(({ id }) => ({
          id: requestId(Number(id)),
          articleId: id,
          status: 'pending',
        })),
      }),
    );

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(view.onSubmitted.mock.calls[0]?.[1]).toEqual(['1', '2', '3']);
  });

  it('sends once however often the button is pressed while it is sending', async () => {
    const answer = deferred<Response>();
    const view = renderPanel({}, { routes: { [ROUTE]: () => answer.promise } });

    await view.user.dblClick(send());
    await view.user.click(send());

    await waitFor(() => expect(analyzed(view)).toHaveLength(1));
    expect(send()).toBeDisabled();
    answer.resolve(
      json(202, {
        requests: picked.map(({ id }) => ({
          id: requestId(Number(id)),
          articleId: id,
          status: 'pending',
        })),
      }),
    );

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(analyzed(view)).toHaveLength(1);
    expect(send()).toBeEnabled();
  });

  it('sends once when the button is pressed twice before the screen is redrawn', async () => {
    const answer = deferred<Response>();
    const view = renderPanel({}, { routes: { [ROUTE]: () => answer.promise } });
    const button = send();

    act(() => {
      button.click();
      button.click();
    });

    await waitFor(() => expect(analyzed(view)).toHaveLength(1));
    answer.resolve(
      json(202, {
        requests: picked.map(({ id }) => ({
          id: requestId(Number(id)),
          articleId: id,
          status: 'pending',
        })),
      }),
    );
    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(analyzed(view)).toHaveLength(1);
  });

  it('sends the same request again under the same key after a failure', async () => {
    let attempts = 0;
    const view = renderPanel(
      {},
      {
        routes: {
          [ROUTE]: (request, params) => {
            attempts += 1;
            return attempts === 1 ? failure(500, 'INTERNAL') : accepted(request, params);
          },
        },
      },
    );

    await view.user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(view.onSubmitted).not.toHaveBeenCalled();
    await view.user.click(send());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    const [first, second] = analyzed(view);
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(bodyOf(second!)).toStrictEqual(bodyOf(first!));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('when the server refuses', () => {
  it('drops the articles that changed, refreshes, and says how many', async () => {
    const view = renderPanel(
      {},
      { routes: { [ROUTE]: () => failure(409, 'STALE_STATE', { articleIds: ['2', '3'] }) } },
    );
    const stale = seed(view);

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '2 selected articles changed and were removed from your selection. Check the list, then analyze again.',
    );
    expect(view.onDrop).toHaveBeenCalledWith(['2', '3']);
    expect(view.onSubmitted).not.toHaveBeenCalled();
    expect(stale.articlesStale()).toBe(true);
  });

  it('says it in the singular for one article', async () => {
    const view = renderPanel(
      {},
      { routes: { [ROUTE]: () => failure(409, 'STALE_STATE', { articleIds: ['2'] }) } },
    );

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 selected article changed and was removed from your selection. Check the list, then analyze again.',
    );
  });

  it('works without anyone to drop the articles', async () => {
    const view = renderPanel(
      { onDrop: undefined },
      { routes: { [ROUTE]: () => failure(409, 'STALE_STATE', { articleIds: ['1'] }) } },
    );

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent('1 selected article changed');
  });

  it('refreshes the subscriptions and asks to check and send again when the version moved on', async () => {
    const view = renderPanel(
      { subscription: training },
      { routes: { [ROUTE]: () => failure(409, 'STALE_STATE', { currentVersion: '9' }) } },
    );
    const stale = seed(view);

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The classification setting of this feed changed. Check it, then analyze again.',
    );
    expect(stale.subscriptionsStale()).toBe(true);
    expect(view.onDrop).not.toHaveBeenCalled();
    expect(view.onSubmitted).not.toHaveBeenCalled();
  });

  it('refreshes the subscriptions when the feed turns out not to be in training', async () => {
    const view = renderPanel(
      { subscription: training },
      { routes: { [ROUTE]: () => failure(409, 'CONFLICT') } },
    );
    const stale = seed(view);

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That conflicts with a more recent change. Refresh and try again.',
    );
    expect(stale.subscriptionsStale()).toBe(true);
  });

  it('says that the articles are no longer available on a 404', async () => {
    const view = renderPanel({}, { routes: { [ROUTE]: () => failure(404, 'NOT_FOUND') } });
    const stale = seed(view);

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The selected articles are no longer available from this feed. Reload the list and choose again.',
    );
    expect(stale.articlesStale()).toBe(true);
    expect(view.onDrop).not.toHaveBeenCalled();
  });

  it('explains any other refusal with the shared sentences', async () => {
    const view = renderPanel({}, { routes: { [ROUTE]: () => failure(429, 'RATE_LIMITED') } });

    await view.user.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Wait a moment and try again.',
    );
  });

  it('clears the message when the selection is sent again', async () => {
    let attempts = 0;
    const view = renderPanel(
      {},
      {
        routes: {
          [ROUTE]: (request, params) => {
            attempts += 1;
            return attempts === 1 ? failure(429, 'RATE_LIMITED') : accepted(request, params);
          },
        },
      },
    );
    await view.user.click(send());
    await screen.findByRole('alert');

    await view.user.click(send());

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('after the requests are accepted', () => {
  const sibling = article('9', 'Another story');
  const state = (status: string, n: number) => ({ id: requestId(n), articleId: String(n), status });

  it('gives every cached copy of a sent article the request it was given, and no other article', async () => {
    const view = renderPanel(
      { items: picked.slice(0, 2) },
      {
        routes: {
          [ROUTE]: () => json(202, { requests: [state('pending', 1), state('complete', 2)] }),
        },
      },
    );
    const [first, second] = picked as [ArticleListItem, ArticleListItem, ArticleListItem];
    const listed = [...articleKeys.all(USER_A_ID), 'list', 'for_you'];
    const picker = [...articleKeys.all(USER_A_ID), 'training', 'list', '1'];
    const opened = articleKeys.detail(USER_A_ID, '1', {});
    const fromFeed = articleKeys.detail(USER_A_ID, '1', { sourceFeedId: '1' });
    const saved = articleKeys.detail(USER_A_ID, '2', { saved: true });
    const other = articleKeys.detail(USER_A_ID, '9', {});
    const tally = [...articleKeys.counts(USER_A_ID), { minTier: 1 }];
    const cache = view.queryClient;
    cache.setQueryData<InfiniteData<ArticleListResponse>>(listed, {
      pages: [page([first, sibling]), page([second])],
      pageParams: [undefined, 'c1'],
    });
    cache.setQueryData<ArticleListResponse>(picker, page([second, sibling]));
    cache.setQueryData<ArticleDetail>(opened, makeDetail(first));
    cache.setQueryData<ArticleDetail>(fromFeed, makeDetail(first, { excerptHtml: '<p>Feed</p>' }));
    cache.setQueryData<ArticleDetail>(saved, makeDetail(second));
    cache.setQueryData<ArticleDetail>(other, makeDetail(sibling));
    cache.setQueryData(tally, counts());

    await view.user.click(send());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    const asked = { mode: 'off', status: 'pending', requestId: requestId(1) };
    const done = { mode: 'off', status: 'complete', requestId: requestId(2) };
    const pages = cache.getQueryData<InfiniteData<ArticleListResponse>>(listed)!.pages;
    expect(pages[0]!.items.map(({ id, analysis }) => [id, analysis])).toEqual([
      ['1', asked],
      ['9', sibling.analysis],
    ]);
    expect(pages[1]!.items.map(({ analysis }) => analysis)).toEqual([done]);
    expect(
      cache.getQueryData<ArticleListResponse>(picker)!.items.map(({ analysis }) => analysis),
    ).toEqual([done, sibling.analysis]);
    expect(cache.getQueryData<ArticleDetail>(opened)!.analysis).toEqual(asked);
    expect(cache.getQueryData<ArticleDetail>(fromFeed)).toEqual({
      ...makeDetail(first, { excerptHtml: '<p>Feed</p>' }),
      analysis: asked,
    });
    expect(cache.getQueryData<ArticleDetail>(saved)!.analysis).toEqual(done);
    expect(cache.getQueryData<ArticleDetail>(other)).toEqual(makeDetail(sibling));
    expect(cache.getQueryData(tally)).toEqual(counts());
  });

  it('does that before it tells who is waiting for the answer', async () => {
    const listed = [...articleKeys.all(USER_A_ID), 'list', 'for_you'];
    const known: ArticleListResponse[] = [];
    const view = renderPanel(
      {
        items: picked.slice(0, 1),
        onSubmitted: () => {
          known.push(view.queryClient.getQueryData<ArticleListResponse>(listed)!);
        },
      },
      { routes: { [ROUTE]: () => json(202, { requests: [state('running', 1)] }) } },
    );
    view.queryClient.setQueryData<ArticleListResponse>(listed, page(picked));

    await view.user.click(send());

    await waitFor(() => expect(known).toHaveLength(1));
    expect(known[0]!.items.map(({ analysis }) => analysis.status)).toEqual([
      'running',
      'not_requested',
      'not_requested',
    ]);
  });

  it('leaves the cache as it was when the request is refused', async () => {
    const view = renderPanel(
      { items: picked.slice(0, 1) },
      { routes: { [ROUTE]: () => failure(429, 'RATE_LIMITED') } },
    );
    const listed = [...articleKeys.all(USER_A_ID), 'list', 'for_you'];
    view.queryClient.setQueryData<ArticleListResponse>(listed, page(picked));

    await view.user.click(send());

    await screen.findByRole('alert');
    expect(
      view.queryClient
        .getQueryData<ArticleListResponse>(listed)!
        .items.map(({ analysis }) => analysis.status),
    ).toEqual(['not_requested', 'not_requested', 'not_requested']);
  });
});

describe('taking a title out of the selection', () => {
  it('has a button on each title that names the article to take out', async () => {
    const onRemove = vi.fn();
    const view = renderPanel({ onRemove });
    const list = screen.getByRole('list', { name: 'Selected articles' });

    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(titles.map((title) => `Remove ${title}`));
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(titles);
    await view.user.click(within(list).getByRole('button', { name: 'Remove A <b>bold</b> claim' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('2');
    expect(view.requests).toHaveLength(0);
  });

  it('has no button when nobody can take the article out', () => {
    renderPanel();

    expect(
      within(screen.getByRole('list', { name: 'Selected articles' })).queryAllByRole('button'),
    ).toEqual([]);
  });

  it('is 44 px wide and high and shows a focus ring', () => {
    renderPanel({ onRemove: vi.fn() });

    const buttons = within(screen.getByRole('list', { name: 'Selected articles' })).getAllByRole(
      'button',
    );
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.className).toContain('min-h-11');
      expect(button.className).toContain('min-w-11');
      for (const token of FOCUS_RING.split(' ')) expect(button.className).toContain(token);
    }
  });

  it('is named in Slovak', () => {
    renderPanel({ onRemove: vi.fn() }, { language: 'sk' });

    expect(
      within(screen.getByRole('list', { name: 'Vybrané články' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(titles.map((title) => `Odobrať z výberu: ${title}`));
  });
});

/** The panel over a selection that changes, with a checkbox for each article that can be chosen. */
function Choosing({ among }: { among: readonly ArticleListItem[] }) {
  const selection = useArticleSelection();
  return (
    <>
      {among.map((candidate) => (
        <label key={candidate.id}>
          <input
            type="checkbox"
            checked={selection.has(candidate.id)}
            onChange={(event) => selection.toggle(candidate, event.target.checked)}
          />
          {`Choose ${candidate.title}`}
        </label>
      ))}
      <AnalyzePanel
        subscription={training}
        items={selection.items}
        onDrop={selection.remove}
        onRemove={(articleId) => selection.remove([articleId])}
        onSubmitted={(_requests, sentIds) => selection.remove(sentIds)}
      />
    </>
  );
}

describe('the message about a refused request', () => {
  const CHANGED = '1 selected article changed and was removed from your selection.';
  const changed = (...articleIds: string[]) => ({
    [ROUTE]: () => failure(409, 'STALE_STATE', { articleIds }),
  });

  type Chosen = ReturnType<typeof renderReader>;
  const box = (n: number) => screen.getByRole('checkbox', { name: `Choose Article ${n}` });
  const chosen = () =>
    within(screen.getByRole('list', { name: 'Selected articles' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);

  async function choose(view: Chosen, ...numbers: number[]) {
    for (const number of numbers) await view.user.click(box(number));
  }

  /** Chooses 1 to 3 of four articles and sends them to an API that answers with `routes`. */
  async function refused(routes: Record<string, ApiRouteHandler>) {
    const view = renderReader(<Choosing among={many(4)} />, { routes });
    await choose(view, 1, 2, 3);
    await view.user.click(send('Analyze selected 3 articles'));
    await screen.findByRole('alert');
    return view;
  }

  it('stays after the articles it names were dropped', async () => {
    await refused(changed('2'));

    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED);
    expect(chosen()).toEqual(['Article 1', 'Article 3']);
  });

  it.each([
    ['chooses another article', (view: Chosen) => choose(view, 4)],
    ['chooses an article that was dropped', (view: Chosen) => choose(view, 2)],
    ['takes an article off the choice', (view: Chosen) => choose(view, 1)],
    [
      'takes a title out of the panel',
      (view: Chosen) => view.user.click(screen.getByRole('button', { name: 'Remove Article 3' })),
    ],
  ])('goes when the person %s', async (_name, change) => {
    const view = await refused(changed('2'));

    await change(view);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('goes when the person chooses the article that was last, which makes the selection that was sent', async () => {
    const view = await refused(changed('3'));
    expect(chosen()).toEqual(['Article 1', 'Article 2']);

    await choose(view, 3);

    expect(chosen()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays after a refusal that dropped nothing, until the person changes the selection', async () => {
    const view = await refused({ [ROUTE]: () => failure(429, 'RATE_LIMITED') });
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
    expect(chosen()).toEqual(['Article 1', 'Article 2', 'Article 3']);

    await choose(view, 4);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('comes back with the next refusal once the person has moved on', async () => {
    const view = await refused(changed('2'));
    await choose(view, 4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await view.user.click(send('Analyze selected 3 articles'));

    expect(await screen.findByRole('alert')).toHaveTextContent(CHANGED);
  });

  it('is not ended by a selection that stays as it is', async () => {
    const view = await refused(changed('2'));

    view.rerender(<Choosing among={many(4)} />);

    expect(screen.getByRole('alert')).toHaveTextContent(CHANGED);
  });
});

describe('where the focus goes', () => {
  const region = () => screen.getByRole('region', { name: 'Articles to analyze' });
  const remove = (n: number) => screen.getByRole('button', { name: `Remove Article ${n}` });
  const box = (n: number) => screen.getByRole('checkbox', { name: `Choose Article ${n}` });
  const titleList = () => screen.queryByRole('list', { name: 'Selected articles' });
  const answered = (...numbers: number[]) =>
    json(202, {
      requests: numbers.map((n) => ({ id: requestId(n), articleId: String(n), status: 'pending' })),
    });
  const refusing = (...articleIds: string[]) => ({
    [ROUTE]: () => failure(409, 'STALE_STATE', { articleIds }),
  });

  /** The panel over four articles, `numbers` of them chosen, with an API that answers `routes`. */
  async function choosing(numbers: number[], routes: Record<string, ApiRouteHandler> = {}) {
    const view = renderReader(<Choosing among={many(4)} />, {
      routes: { [ROUTE]: accepted, ...routes },
    });
    for (const number of numbers) await view.user.click(box(number));
    return view;
  }

  it('is the button of the next title once a title is taken out', async () => {
    const view = await choosing([1, 2, 3]);

    await view.user.click(remove(2));

    expect(remove(3)).toHaveFocus();
  });

  it('is the button of the title before once the last title is taken out', async () => {
    const view = await choosing([1, 2, 3]);

    await view.user.click(remove(3));

    expect(remove(2)).toHaveFocus();
  });

  it('is the panel once its only title is taken out', async () => {
    const view = await choosing([1]);

    await view.user.click(remove(1));

    expect(region()).toHaveFocus();
  });

  it('is the panel once the articles it sent are accepted', async () => {
    const view = await choosing([1, 2]);

    await view.user.click(send('Analyze selected 2 articles'));

    await waitFor(() => expect(titleList()).toBeNull());
    expect(region()).toHaveFocus();
  });

  it('is the panel once a refusal took out every title', async () => {
    const view = await choosing([1], refusing('1'));

    await view.user.click(send('Analyze selected 1 article'));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(region()).toHaveFocus();
  });

  it('stays on the button when a refusal leaves titles to send', async () => {
    const view = await choosing([1, 2], refusing('1'));

    await view.user.click(send('Analyze selected 2 articles'));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(send('Analyze selected 1 article')).toHaveFocus();
  });

  it('stays on the button of a title chosen while the articles were sent', async () => {
    const answer = deferred<Response>();
    const view = await choosing([1, 2], { [ROUTE]: () => answer.promise });
    await view.user.click(send('Analyze selected 2 articles'));
    await view.user.click(box(3));
    act(() => {
      remove(3).focus();
    });

    answer.resolve(answered(1, 2));

    await waitFor(() => expect(titleList()).toHaveTextContent(/^Article 3/));
    expect(remove(3)).toHaveFocus();
  });

  it('is the panel when its button for an article sent goes, and one chosen meanwhile stays', async () => {
    const answer = deferred<Response>();
    const view = await choosing([1, 2], { [ROUTE]: () => answer.promise });
    await view.user.click(send('Analyze selected 2 articles'));
    await view.user.click(box(3));
    act(() => {
      remove(1).focus();
    });

    answer.resolve(answered(1, 2));

    await waitFor(() => expect(titleList()).toHaveTextContent(/^Article 3/));
    expect(region()).toHaveFocus();
  });

  it('stays where the person took it while the articles were sent', async () => {
    const answer = deferred<Response>();
    const view = await choosing([1, 2], { [ROUTE]: () => answer.promise });
    await view.user.click(send('Analyze selected 2 articles'));
    act(() => {
      box(4).focus();
    });

    answer.resolve(answered(1, 2));

    await waitFor(() => expect(titleList()).toBeNull());
    expect(box(4)).toHaveFocus();
  });
});

describe('handing the focus on', () => {
  const sentAll = () =>
    json(202, {
      requests: picked.map(({ id }) => ({
        id: requestId(Number(id)),
        articleId: id,
        status: 'pending',
      })),
    });

  it('names the articles sent, in order, before it tells who is waiting for them', async () => {
    const returnFocus = vi.fn();
    const view = renderPanel({ returnFocus });

    await view.user.click(send());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(returnFocus).toHaveBeenCalledTimes(1);
    expect(returnFocus).toHaveBeenCalledWith(['1', '2', '3']);
    expect(returnFocus.mock.invocationCallOrder[0]).toBeLessThan(
      view.onSubmitted.mock.invocationCallOrder[0]!,
    );
  });

  it('names the last title taken out', async () => {
    const returnFocus = vi.fn();
    const onRemove = vi.fn();
    const view = renderPanel({ items: picked.slice(1, 2), onRemove, returnFocus });

    await view.user.click(screen.getByRole('button', { name: 'Remove A <b>bold</b> claim' }));

    expect(returnFocus).toHaveBeenCalledTimes(1);
    expect(returnFocus).toHaveBeenCalledWith(['2']);
    expect(onRemove).toHaveBeenCalledWith('2');
  });

  it('is not asked while an article chosen meanwhile keeps the panel', async () => {
    const answer = deferred<Response>();
    const returnFocus = vi.fn();
    const view = renderPanel({ returnFocus }, { routes: { [ROUTE]: () => answer.promise } });
    await view.user.click(send());
    await waitFor(() => expect(analyzed(view)).toHaveLength(1));

    view.rerender(
      <AnalyzePanel
        subscription={off}
        items={[...picked, article('4', 'Fourth story')]}
        onSubmitted={view.onSubmitted}
        returnFocus={returnFocus}
      />,
    );
    answer.resolve(sentAll());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(returnFocus).not.toHaveBeenCalled();
  });

  it('is not asked while other titles are left', async () => {
    const returnFocus = vi.fn();
    const view = renderPanel({ onRemove: vi.fn(), returnFocus });

    await view.user.click(screen.getByRole('button', { name: 'Remove A <b>bold</b> claim' }));

    expect(returnFocus).not.toHaveBeenCalled();
  });

  it('is not asked for a focus the person took elsewhere while the articles were sent', async () => {
    const answer = deferred<Response>();
    const returnFocus = vi.fn();
    const onSubmitted = vi.fn();
    const view = renderReader(
      <>
        <button type="button">Elsewhere</button>
        <AnalyzePanel
          subscription={off}
          items={picked}
          onSubmitted={onSubmitted}
          returnFocus={returnFocus}
        />
      </>,
      { routes: { [ROUTE]: () => answer.promise } },
    );
    await view.user.click(send());
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => {
      elsewhere.focus();
    });

    answer.resolve(sentAll());

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(returnFocus).not.toHaveBeenCalled();
    expect(elsewhere).toHaveFocus();
  });

  it('is not asked once the panel is gone', async () => {
    const answer = deferred<Response>();
    const returnFocus = vi.fn();
    const view = renderPanel({ returnFocus }, { routes: { [ROUTE]: () => answer.promise } });
    await view.user.click(send());
    await waitFor(() => expect(analyzed(view)).toHaveLength(1));

    view.unmount();
    answer.resolve(sentAll());

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(returnFocus).not.toHaveBeenCalled();
  });
});

describe('an answer that comes after the panel is gone', () => {
  it('still gives the cached articles their requests, refreshes them and hands the requests on', async () => {
    const answer = deferred<Response>();
    const view = renderPanel(
      { items: picked.slice(0, 1) },
      { routes: { [ROUTE]: () => answer.promise } },
    );
    const stale = seed(view);
    const listed = [...articleKeys.all(USER_A_ID), 'list', 'for_you'];
    view.queryClient.setQueryData<ArticleListResponse>(listed, page(picked));
    await view.user.click(send());
    await waitFor(() => expect(analyzed(view)).toHaveLength(1));

    view.unmount();
    answer.resolve(
      json(202, { requests: [{ id: requestId(1), articleId: '1', status: 'pending' }] }),
    );

    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalledTimes(1));
    expect(view.onSubmitted).toHaveBeenCalledWith(
      [{ id: requestId(1), articleId: '1', status: 'pending' }],
      ['1'],
    );
    expect(
      view.queryClient
        .getQueryData<ArticleListResponse>(listed)!
        .items.map(({ analysis }) => analysis),
    ).toEqual([
      { mode: 'off', status: 'pending', requestId: requestId(1) },
      picked[1]!.analysis,
      picked[2]!.analysis,
    ]);
    expect(stale.articlesStale()).toBe(true);
    expect(stale.subscriptionsStale()).toBe(true);
  });
});
