import type { ArticleListItem, Subscription } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { articleKeys } from '../../src/features/article/query-keys.js';
import { subscriptionsKey } from '../../src/features/feeds/subscriptions.js';
import { AnalyzePanel, type AnalyzePanelProps } from '../../src/features/training/analyze-panel.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { deferred, renderReader, type ReaderHarnessOptions } from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { article, requestId } from '../onboarding/support.js';
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
    );
    expect(stale.subscriptionsStale()).toBe(true);
    expect(stale.articlesStale()).toBe(true);
    expect(view.onDrop).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
