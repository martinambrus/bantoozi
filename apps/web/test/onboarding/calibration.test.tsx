import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UUID_V4, failure } from '../api/fake-fetch.js';
import { restoreVisibility, setVisibility } from '../article/harness.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import {
  article,
  articles,
  counts,
  expectUsableControls,
  feed,
  listResponse,
  requestId,
  setStatus,
  wizardServer,
  withAnalysis,
  type WizardOptions,
} from './support.js';

const { open } = createHarness();

afterEach(() => {
  restoreVisibility();
});

const ANALYZE = 'POST /subscriptions/:feedId/analyze';
const INFERENCE = 'POST /subscriptions/:feedId/inference';
const RATING = 'POST /articles/:id/rating';
const ROUND = 'Rate a few articles';

type Opened = Awaited<ReturnType<typeof openStep>>;

const alpha = () => feed('1', 'Alpha');
const beta = () => feed('2', 'Beta', { inferenceMode: 'training', inferenceVersion: '4' });
const betaArticle = (n: number) =>
  article(String(n), `Article ${n}`, {
    feed: { id: '2', title: 'Beta', iconUrl: null },
    analysis: { mode: 'training', status: 'not_requested', requestId: null },
  });

async function openStep(options: WizardOptions = {}) {
  const { server, state } = wizardServer({
    subscriptions: [alpha()],
    articles: { '1': articles(1, 12) },
    feedCounts: { '1': counts({ new: 12, scored: 0, total: 12 }) },
    ...options,
  });
  const app = await open({ path: '/onboarding?step=calibrate', server });
  await screen.findByRole('heading', { level: 1, name: 'Choose articles to teach Bantoozi' });
  return { app, state };
}

const box = (title: string) => screen.findByRole('checkbox', { name: title });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const polls = ({ app }: Opened) => ({
  lists: app.calls('GET /articles').length,
  counts: app.calls('GET /articles/counts').length,
});

async function choose({ app }: Opened, ...numbers: number[]) {
  for (const number of numbers) await app.user.click(await box(`Article ${number}`));
}

async function submit(opened: Opened, ...numbers: number[]) {
  await choose(opened, ...numbers);
  await opened.app.user.click(
    await screen.findByRole('button', { name: /^(Start training and analyze|Analyze selected)/ }),
  );
}

describe('choosing the articles to analyze (spec 09 §4 step 4)', () => {
  it('lists the titles the feed already has, selectable, and submits nothing', async () => {
    const { app } = await openStep();

    expect(await box('Article 1')).not.toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(12);
    const [list] = app.calls('GET /articles');
    expect(Object.fromEntries(list!.query)).toEqual({
      lane: 'all',
      feedId: '1',
      status: 'all',
      minTier: '1',
      sort: 'date',
      limit: '50',
    });
    expect(screen.getByRole('button', { name: 'Select articles to analyze' })).toBeDisabled();
    expect(app.calls(ANALYZE)).toHaveLength(0);
    expect(app.calls(INFERENCE)).toHaveLength(0);
    expect(app.calls('GET /articles/calibration')).toHaveLength(0);
  });

  it('says that nothing is analyzed until the person asks', async () => {
    await openStep();

    expect(await screen.findByText(/Nothing is analyzed until you press the button/)).toBeVisible();
  });

  it('shows the titles of another feed when it is chosen, and submits nothing', async () => {
    const { app } = await openStep({
      subscriptions: [alpha(), beta()],
      articles: { '1': articles(1, 3), '2': [betaArticle(21), betaArticle(22)] },
    });
    await box('Article 1');

    await app.user.selectOptions(screen.getByLabelText('Choose a feed'), 'Beta');

    expect(await box('Article 21')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Article 1' })).not.toBeInTheDocument();
    const feedIds = app.calls('GET /articles').map((request) => request.query.get('feedId'));
    expect([...new Set(feedIds)]).toEqual(['1', '2']);
    expect(app.calls(ANALYZE)).toHaveLength(0);
  });

  it('forgets what was chosen in another feed', async () => {
    const { app } = await openStep({
      subscriptions: [alpha(), beta()],
      articles: { '1': articles(1, 3), '2': [betaArticle(21)] },
    });
    await app.user.click(await box('Article 1'));
    expect(screen.getByText('1 of 20 selected')).toBeVisible();

    await app.user.selectOptions(screen.getByLabelText('Choose a feed'), 'Beta');
    await box('Article 21');

    expect(screen.getByText('0 of 20 selected')).toBeVisible();
    await app.user.selectOptions(screen.getByLabelText('Choose a feed'), 'Alpha');
    expect(await box('Article 1')).not.toBeChecked();
  });

  it('offers only the articles that have not been requested yet', async () => {
    await openStep({
      subscriptions: [feed('1', 'Alpha', { inferenceMode: 'training' })],
      articles: {
        '1': [
          article('1', 'Fresh'),
          withAnalysis(article('2', 'Waiting'), 'training', 'pending', requestId(2)),
          withAnalysis(article('3', 'Running'), 'training', 'running', requestId(3)),
          withAnalysis(article('4', 'Done'), 'training', 'complete', requestId(4)),
          withAnalysis(article('5', 'Broken'), 'training', 'failed', requestId(5)),
          withAnalysis(article('6', 'Stopped'), 'training', 'cancelled', requestId(6)),
        ],
      },
    });

    expect(await box('Fresh')).toBeEnabled();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    const row = (title: string) => screen.getByText(title).closest('li')!;
    expect(row('Waiting')).toHaveTextContent('Waiting for analysis');
    expect(row('Running')).toHaveTextContent('Being analyzed');
    expect(row('Done')).toHaveTextContent('Analyzed');
    expect(row('Broken')).toHaveTextContent('Analysis failed');
    expect(row('Stopped')).toHaveTextContent('Analysis cancelled');
  });

  it('says so when the feed has no articles yet', async () => {
    await openStep({ articles: { '1': [] } });

    expect(await screen.findByText('No articles from this feed yet')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
  });

  it('shows a failed list in words and asks again when told to', async () => {
    let failing = true;
    const { app } = await openStep({
      routes: {
        'GET /articles': () => (failing ? failure(500, 'INTERNAL') : listResponse(articles(1, 2))),
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    failing = false;
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await box('Article 1')).toBeVisible();
  });

  it('switches the feed to training without analyzing anything', async () => {
    const { app } = await openStep();

    await app.user.click(await screen.findByRole('button', { name: 'Switch to training' }));

    expect(
      await screen.findByText('Classification is now: Training: selected articles.'),
    ).toBeVisible();
    expect(app.calls(INFERENCE).map((request) => bodyOf(request))).toStrictEqual([
      { mode: 'training', expectedVersion: '1' },
    ]);
    expect(app.calls(ANALYZE)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Enable automatic classification' })).toBeVisible();

    await app.user.click(await box('Article 1'));

    expect(screen.getByRole('button', { name: 'Analyze selected 1 article' })).toBeEnabled();
  });
});

describe('analyzing the chosen articles', () => {
  it('lists the exact titles and then starts training and analyzes them, for a feed that is off', async () => {
    const opened = await openStep();
    const { app, state } = opened;

    await choose(opened, 3, 1);

    const panel = screen.getByRole('region', { name: 'Articles to analyze' });
    expect(
      within(within(panel).getByRole('list', { name: 'Selected articles' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Article 3', 'Article 1']);
    const send = screen.getByRole('button', { name: 'Start training and analyze these 2' });
    expect(app.calls(ANALYZE)).toHaveLength(0);

    await app.user.click(send);

    await waitFor(() => expect(app.calls(ANALYZE)).toHaveLength(1));
    const [request] = app.calls(ANALYZE);
    expect(request?.pathname).toBe('/api/v1/subscriptions/1/analyze');
    expect(bodyOf(request!)).toStrictEqual({
      articles: [
        { id: '3', contentRevision: '1' },
        { id: '1', contentRevision: '1' },
      ],
      expectedInferenceVersion: '1',
      startTraining: true,
    });
    expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(state.subscriptions[0]?.inferenceMode).toBe('training');
    expect(
      await screen.findByRole('button', { name: 'Enable automatic classification' }),
    ).toBeVisible();
    expect(app.calls(INFERENCE)).toHaveLength(0);
  });

  it('sends no startTraining for a feed that is in training already', async () => {
    const opened = await openStep({
      subscriptions: [beta()],
      articles: { '2': [betaArticle(21), betaArticle(22), betaArticle(23)] },
    });

    await choose(opened, 22, 23);
    await opened.app.user.click(
      screen.getByRole('button', { name: 'Analyze selected 2 articles' }),
    );

    await waitFor(() => expect(opened.app.calls(ANALYZE)).toHaveLength(1));
    expect(bodyOf(opened.app.calls(ANALYZE)[0]!)).toStrictEqual({
      articles: [
        { id: '22', contentRevision: '1' },
        { id: '23', contentRevision: '1' },
      ],
      expectedInferenceVersion: '4',
    });
  });

  it('refuses a 21st article and says so', async () => {
    const opened = await openStep({ articles: { '1': articles(1, 25) } });
    await choose(opened, ...Array.from({ length: 20 }, (_unused, index) => index + 1));
    expect(screen.getByText('20 of 20 selected')).toBeVisible();

    await opened.app.user.click(await box('Article 21'));

    expect(await screen.findByText('You can select at most 20 articles at a time.')).toBeVisible();
    expect(await box('Article 21')).not.toBeChecked();
    expect(screen.getByText('20 of 20 selected')).toBeVisible();
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(20);
    expect(opened.app.calls(ANALYZE)).toHaveLength(0);

    await opened.app.user.click(await box('Article 20'));
    await opened.app.user.click(await box('Article 21'));

    expect(await box('Article 21')).toBeChecked();
    expect(screen.getByText('20 of 20 selected')).toBeVisible();
  });

  it('drops the articles the server found changed from the selection and says how many', async () => {
    const opened = await openStep({
      routes: { [ANALYZE]: () => failure(409, 'STALE_STATE', { articleIds: ['2'] }) },
    });

    await submit(opened, 1, 2);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 selected article changed and was removed from your selection.',
    );
    expect(await box('Article 2')).not.toBeChecked();
    expect(await box('Article 1')).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Start training and analyze this article' }),
    ).toBeVisible();
  });
});

describe('progress while the requests run', () => {
  async function submitted(...numbers: number[]) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = await openStep();
    await submit(opened, ...(numbers.length === 0 ? [1, 2] : numbers));
    return opened;
  }

  it('says how many of the selected articles are analyzed and how many are scored of those available', async () => {
    await submitted();

    expect(await screen.findByText('0 of 2 selected articles analyzed')).toBeVisible();
    expect(await screen.findByText('0 scored of 12 available')).toBeVisible();
  });

  it('asks for the counts of the chosen feed with every tier', async () => {
    const opened = await submitted();
    await screen.findByText('0 scored of 12 available');

    const last = opened.app.calls('GET /articles/counts').at(-1);
    expect(Object.fromEntries(last!.query)).toEqual({ feedId: '1', minTier: '1', status: 'all' });
  });

  it('asks again every 5 seconds while a selected request is pending, and stops when none is', async () => {
    const opened = await submitted();
    await screen.findByText('0 scored of 12 available');
    const first = polls(opened);

    await wait(5_000);
    expect(polls(opened)).toEqual({ lists: first.lists + 1, counts: first.counts + 1 });
    await wait(10_000);
    expect(polls(opened)).toEqual({ lists: first.lists + 3, counts: first.counts + 3 });

    setStatus(opened.state, '1', ['1'], 'running');
    await wait(5_000);
    expect(polls(opened)).toEqual({ lists: first.lists + 4, counts: first.counts + 4 });

    setStatus(opened.state, '1', ['1', '2'], 'complete');
    opened.state.feedCounts['1'] = counts({ forYou: 1, maybe: 1, new: 10, scored: 2, total: 12 });
    await wait(5_000);
    expect(await screen.findByText('2 of 2 selected articles analyzed')).toBeVisible();
    expect(await screen.findByText('2 scored of 12 available')).toBeVisible();

    const settled = polls(opened);
    await wait(60_000);
    expect(polls(opened)).toEqual(settled);
  });

  it('does not ask while the page is hidden', async () => {
    const opened = await submitted();
    await screen.findByText('0 scored of 12 available');
    const before = polls(opened);

    setVisibility('hidden');
    await wait(20_000);
    expect(polls(opened)).toEqual(before);

    setVisibility('visible');
    await wait(5_000);
    expect(polls(opened).lists).toBeGreaterThan(before.lists);
  });

  it('does not ask again when nothing has been submitted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = await openStep();
    await box('Article 1');
    const before = polls(opened);

    await wait(30_000);

    expect(polls(opened)).toEqual(before);
  });
});

describe('in Slovak', () => {
  it('words the selection, the button and the progress for a Slovak account', async () => {
    const { server } = wizardServer({
      me: makeMe({ locale: 'sk', preferences: { onboardingCompletedAt: null } }),
      subscriptions: [alpha()],
      articles: { '1': articles(1, 12) },
      feedCounts: { '1': counts({ new: 12, scored: 0, total: 12 }) },
    });
    const app = await open({ path: '/onboarding?step=calibrate', server, language: 'sk' });
    await screen.findByRole('heading', {
      level: 1,
      name: 'Vyberte články, z ktorých sa Bantoozi naučí',
    });
    expect(await screen.findByLabelText('Vyberte zdroj')).toBeVisible();

    await app.user.click(await box('Article 1'));
    await app.user.click(await box('Article 2'));
    expect(screen.getByText('Vybrané: 2 z 20')).toBeVisible();
    await app.user.click(
      screen.getByRole('button', { name: 'Spustiť trénovanie a analyzovať tieto 2 články' }),
    );

    expect(await screen.findByText('Analyzované: 0 z 2 vybraných článkov')).toBeVisible();
    expect(await screen.findByText('Vyhodnotené: 0 z 12 dostupných')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dokončiť' })).toBeVisible();
  });
});

describe('the calibration round (spec 06 §10)', () => {
  const round = (n: number, overrides: Partial<ArticleListItem> = {}) =>
    article(String(100 + n), `Round ${n}`, { lane: 'maybe', tier: 3, pLike: 0.55, ...overrides });

  it('opens when ten of the selected articles are analyzed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = await openStep({ calibration: [round(1), round(2)] });
    await submit(opened, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    expect(await screen.findByText('0 of 12 selected articles analyzed')).toBeVisible();

    setStatus(opened.state, '1', ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'complete');
    await wait(5_000);
    expect(await screen.findByText('9 of 12 selected articles analyzed')).toBeVisible();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: ROUND })).not.toBeInTheDocument();

    setStatus(opened.state, '1', ['10'], 'complete');
    await wait(5_000);

    expect(await screen.findByRole('heading', { level: 2, name: ROUND })).toBeVisible();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(1);
    expect(screen.getByText('Round 1')).toBeVisible();
    expect(screen.getByText('Round 2')).toBeVisible();
  });

  it('opens when every selected request is final, however few are complete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = await openStep({ calibration: [round(1)] });
    await submit(opened, 1, 2, 3);
    await screen.findByText('0 of 3 selected articles analyzed');
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(0);

    setStatus(opened.state, '1', ['1'], 'complete');
    setStatus(opened.state, '1', ['2'], 'failed');
    setStatus(opened.state, '1', ['3'], 'cancelled');
    await wait(5_000);

    expect(await screen.findByRole('heading', { level: 2, name: ROUND })).toBeVisible();
    expect(screen.getByText('1 of 3 selected articles analyzed')).toBeVisible();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(1);
  });

  it('opens at once when the answers were cached', async () => {
    const opened = await openStep({ calibration: [round(1)], requestStatus: 'complete' });

    await submit(opened, 1, 2);

    expect(await screen.findByRole('heading', { level: 2, name: ROUND })).toBeVisible();
    expect(screen.getByText('2 of 2 selected articles analyzed')).toBeVisible();
  });

  it('opens 60 seconds after the submission even though requests are pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const opened = await openStep({ calibration: [round(1)] });
    await submit(opened, 1, 2);
    await screen.findByText('0 of 2 selected articles analyzed');

    await wait(50_000);
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: ROUND })).not.toBeInTheDocument();

    await wait(10_000);

    expect(await screen.findByRole('heading', { level: 2, name: ROUND })).toBeVisible();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(1);
    expect(screen.getByText('0 of 2 selected articles analyzed')).toBeVisible();
  });

  it('counts the sent articles as waiting while the list still shows them as not requested', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A list read before the API has recorded the requests still shows the articles as new.
    const unchanged = articles(1, 12);
    const opened = await openStep({
      calibration: [round(1)],
      routes: { 'GET /articles': () => listResponse(unchanged) },
    });

    await submit(opened, 1, 2);
    expect(await screen.findByText('0 of 2 selected articles analyzed')).toBeVisible();
    await wait(1_000);

    expect(screen.queryByRole('heading', { name: ROUND })).not.toBeInTheDocument();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(0);
  });

  it('says there is nothing to rate yet when the round is empty', async () => {
    const opened = await openStep({ calibration: [], requestStatus: 'complete' });

    await submit(opened, 1);

    expect(await screen.findByText('No articles are ready to rate yet.')).toBeVisible();
  });

  it('rates an item as a calibration item, with its analysis request when it has one', async () => {
    const requested = round(1, {
      stateVersion: '2',
      contentRevision: '3',
      analysis: { mode: 'training', status: 'complete', requestId: requestId(101) },
    });
    const arrival = round(2, {
      analysis: { mode: 'active', status: 'not_requested', requestId: null },
    });
    const opened = await openStep({ calibration: [requested, arrival], requestStatus: 'complete' });
    await submit(opened, 1);
    const first = await screen.findByRole('listitem', { name: 'Round 1' });
    const second = screen.getByRole('listitem', { name: 'Round 2' });

    await opened.app.user.click(within(first).getByRole('button', { name: 'Like' }));
    await opened.app.user.click(within(second).getByRole('button', { name: 'Dislike' }));

    await waitFor(() => expect(opened.app.calls(RATING)).toHaveLength(2));
    const [liked, disliked] = opened.app.calls(RATING);
    expect(liked?.pathname).toBe('/api/v1/articles/101/rating');
    expect(bodyOf(liked!)).toStrictEqual({
      stateVersion: '2',
      contentRevision: '3',
      rating: 1,
      analysisRequestId: requestId(101),
      selection: 'calibration',
    });
    expect(liked?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(disliked?.pathname).toBe('/api/v1/articles/102/rating');
    expect(bodyOf(disliked!)).toStrictEqual({
      stateVersion: '0',
      contentRevision: '1',
      rating: -1,
      selection: 'calibration',
    });
    await waitFor(() =>
      expect(within(first).getByRole('button', { name: 'Like' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(within(second).getByRole('button', { name: 'Dislike' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps a rated item in the round', async () => {
    const opened = await openStep({ calibration: [round(1)], requestStatus: 'complete' });
    await submit(opened, 1);
    const row = await screen.findByRole('listitem', { name: 'Round 1' });

    await opened.app.user.click(within(row).getByRole('button', { name: 'Like' }));
    await waitFor(() => expect(opened.app.calls(RATING)).toHaveLength(1));

    expect(screen.getByRole('listitem', { name: 'Round 1' })).toBeVisible();
    expect(opened.app.calls('GET /articles/calibration')).toHaveLength(1);
  });
});

describe('skipping and finishing (spec 09 §4 step 4)', () => {
  it('skips with no article at all: one save, the New lane, no analysis and no round', async () => {
    const { app } = await openStep({ articles: { '1': [] } });

    await app.user.click(await screen.findByRole('button', { name: 'Skip for now' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    expect(app.calls('PATCH /me')).toHaveLength(1);
    expect(app.calls(ANALYZE)).toHaveLength(0);
    expect(app.calls(INFERENCE)).toHaveLength(0);
    expect(app.calls('GET /articles/calibration')).toHaveLength(0);
  });

  it('finishes while requests are still running, without waiting for them', async () => {
    const opened = await openStep({ counts: counts({ forYou: 2 }) });
    await submit(opened, 1, 2);
    await screen.findByText('0 of 2 selected articles analyzed');

    await opened.app.user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(opened.app.router.state.location.pathname).toBe('/read/for_you'));
    expect(opened.app.calls('PATCH /me')).toHaveLength(1);
    expect(opened.app.calls(ANALYZE)).toHaveLength(1);
  });
});

describe('controls (spec 09 §1)', () => {
  it('are named, 44 px high and show a focus ring, in the picker, the panel and the round', async () => {
    const opened = await openStep({
      subscriptions: [alpha(), beta()],
      articles: {
        '1': [
          ...articles(1, 3),
          withAnalysis(article('9', 'Asked'), 'training', 'complete', requestId(9)),
        ],
        '2': [betaArticle(21)],
      },
      calibration: [article('101', 'Round 1')],
      requestStatus: 'complete',
    });
    await submit(opened, 1);
    await screen.findByRole('listitem', { name: 'Round 1' });
    await choose(opened, 2);

    expect(expectUsableControls()).toBeGreaterThanOrEqual(11);
  });
});
