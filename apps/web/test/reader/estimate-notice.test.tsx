import type { EstimatesStatus, LearningStatus } from '@bantoozi/shared';
import { onlineManager } from '@tanstack/react-query';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useReaderActions } from '../../src/features/reader/actions/provider.js';
import { useEstimateNoticeState } from '../../src/features/learning/use-estimate-notice.js';
import {
  actionResponse,
  renderReader,
  restoreVisibility,
  setVisibility,
} from '../article/harness.js';
import {
  LEARNING_ESTIMATES,
  learningEstimatesRoute,
  makeEstimates,
  makeLearning,
} from '../learning/fixtures.js';
import { acked } from './actions/fake-transport.js';
import { holdExits } from './exit-hold.js';
import { countsQueries, createReaderHarness, item, listQueries, rowTitles } from './support.js';
import { VERGE, likeOf, openMore, writeRoutes } from './surfaces.js';

/*
 * The effect notice (visible-learning 4.5, PRG-3): after the reader's own rating the page asks
 * GET /me/learning/estimates every 5 s (at most 60 s after the last rating); when a refresh that followed
 * ratings finishes ("lastRun" with a new "at" and fromRatings true) a bar above the list says how
 * many unread articles moved, and the list reloads only when Show is pressed.
 */

const { open } = createReaderHarness();

type Opened = Awaited<ReturnType<typeof open>>;
type App = Opened['app'];
type Run = NonNullable<EstimatesStatus['lastRun']>;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const lists = (app: App) => app.calls('GET /articles').length;
const polls = (app: App) => app.calls(LEARNING_ESTIMATES).length;

const run = (at: string, movedUp: number, movedDown: number, fromRatings = true): Run => ({
  at,
  movedUp,
  movedDown,
  fromRatings,
});
const L0 = run('2026-10-23T08:00:00.000Z', 4, 5);
const L1 = run('2026-10-23T09:00:00.000Z', 12, 30);
const L2 = run('2026-10-23T10:00:00.000Z', 3, 0);

const SENTENCE_L1 = 'Updated from your ratings: 12 unread articles moved up, 30 down';
const SENTENCE_L2 = 'Updated from your ratings: 3 unread articles moved up';
const SHOW = 'Show articles in their new order';
const DISMISS = 'Dismiss the update notice';

/** What GET /me/learning/estimates answers next; a test changes it between polls. */
let status: LearningStatus;
const withRun = (lastRun: Run | null) => {
  status = makeLearning({}, [], { estimates: makeEstimates({ lastRun }) });
};
/** The first model: no estimate model at all. */
const noModel = () => {
  status = makeLearning();
};

let scrolled = 0;
let scrollTo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrolled = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrolled });
  scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  withRun(L0);
});

afterEach(() => {
  restoreVisibility();
  scrollTo.mockRestore();
  vi.useRealTimers();
});

const THREE = [item(1), item(2), item(3)];

interface OpenOptions {
  path?: string;
  routes?: Parameters<typeof open>[0]['routes'];
}

/** The reader on a feed view (all lanes) with three unread rows; fake timers; row exits held. */
async function openReader({ path = '/read/feed/7', routes = {} }: OpenOptions = {}) {
  vi.useFakeTimers();
  const exits = holdExits();
  const opened = await open({
    path,
    subscriptions: [VERGE],
    items: THREE,
    routes: {
      [LEARNING_ESTIMATES]: learningEstimatesRoute(() => status),
      ...writeRoutes().routes,
      ...routes,
    },
  });
  await screen.findByRole('article', { name: 'Article 1' });
  return { ...opened, exits };
}

/** Lets exactly one more GET /me/learning/estimates happen (and be handled). */
async function nextPoll(app: App) {
  const before = polls(app);
  for (let waited = 0; waited < 12_000 && polls(app) === before; waited += 500) {
    await advance(500);
  }
  expect(polls(app)).toBeGreaterThan(before);
  await advance(50);
}

/** The refresh after a rating: the poll sees `before`, then the new version refreshing, then `run`. */
async function runLands(app: App, next: Run, before: Run | null = L0) {
  withRun(before);
  await nextPoll(app);
  withRun(null);
  await nextPoll(app);
  withRun(next);
  await nextPoll(app);
}

const sentence = (text: string) => screen.queryByText(text);
const notice = () => screen.queryByRole('button', { name: SHOW });
const show = (app: App) => app.user.click(screen.getByRole('button', { name: SHOW }));

describe('when the notice appears', () => {
  it('shows once, after the refresh of the new model version finished, and loads no list by itself', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));

    withRun(L0);
    await nextPoll(app);
    expect(notice()).toBeNull();
    withRun(null);
    await nextPoll(app);
    expect(notice()).toBeNull();
    expect(sentence(SENTENCE_L1)).toBeNull();
    const listed = lists(app);
    withRun(L1);
    await nextPoll(app);

    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
    expect(screen.getByRole('button', { name: SHOW })).toHaveTextContent('Show');
    expect(lists(app)).toBe(listed);

    await advance(70_000);

    expect(screen.getAllByText(SENTENCE_L1)).toHaveLength(1);
    expect(lists(app)).toBe(listed);
  });

  it('shows nothing for a run that did not follow ratings (a sweep), although armed', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));

    await runLands(app, run(L1.at, 12, 30, false));
    await advance(10_000);

    expect(notice()).toBeNull();
    expect(sentence(SENTENCE_L1)).toBeNull();
  });

  it('shows nothing for the first model: no model, then a refresh, then a run that is not from ratings', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));

    noModel();
    await nextPoll(app);
    withRun(null);
    await nextPoll(app);
    withRun(run(L1.at, 12, 30, false));
    await nextPoll(app);
    await advance(10_000);

    expect(notice()).toBeNull();
    expect(sentence(SENTENCE_L1)).toBeNull();
  });

  it.each([
    { up: 0, down: 0, text: null },
    { up: 1, down: 0, text: 'Updated from your ratings: 1 unread article moved up' },
    { up: 0, down: 3, text: 'Updated from your ratings: 3 unread articles moved down' },
    { up: 12, down: 30, text: SENTENCE_L1 },
    { up: 1, down: 1, text: 'Updated from your ratings: 1 unread article moved up, 1 down' },
  ])('says it for $up up and $down down', async ({ up, down, text }) => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));

    await runLands(app, run(L1.at, up, down));
    await advance(1_000);

    if (text === null) {
      expect(notice()).toBeNull();
      expect(screen.queryByText(/Updated from your ratings/)).toBeNull();
    } else {
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByRole('button', { name: SHOW })).toBeVisible();
    }
  });

  it('is not shown for a run this tab did not cause, and does not poll for it', async () => {
    const { app } = await openReader();
    const asked = polls(app);

    withRun(L1);
    await advance(180_000);

    expect(notice()).toBeNull();
    expect(screen.queryByText(/Updated from your ratings/)).toBeNull();
    expect(polls(app)).toBe(asked);
  });

  it('does not ask for the status before the reader rates, and does after', async () => {
    const { app } = await openReader();
    const asked = polls(app);

    await advance(120_000);
    expect(polls(app)).toBe(asked);

    await app.user.click(likeOf('Article 1'));
    await advance(30_000);
    // Every 5 s: one refetch after the rating (the chip's) cannot account for this many.
    expect(polls(app)).toBeGreaterThanOrEqual(asked + 4);
  });

  it('replaces the numbers when a second run lands while the first notice is shown', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();

    await app.user.click(likeOf('Article 3'));
    await runLands(app, L2, L1);

    expect(await screen.findByText(SENTENCE_L2)).toBeVisible();
    expect(sentence(SENTENCE_L1)).toBeNull();
    expect(screen.getAllByRole('button', { name: SHOW })).toHaveLength(1);
  });
});

describe('what arms the notice', () => {
  it('a like arms it; so does a dislike', async () => {
    const { app } = await openReader();
    const asked = polls(app);
    await app.user.click(
      within(screen.getByRole('article', { name: 'Article 2' })).getByRole('button', {
        name: 'Dislike',
      }),
    );
    await app.user.click(
      within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
        name: 'Off-topic',
      }),
    );

    await runLands(app, L1);

    expect(polls(app)).toBeGreaterThan(asked);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
  });

  it('the bulk "Rate these N visible articles" arms it', async () => {
    const { app } = await openReader();
    const asked = polls(app);
    await openMore(app, 'Verge');
    await app.user.click(
      await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Rate these 3 visible articles?' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));
    await vi.waitFor(() => expect(app.calls('POST /articles/rate-bulk')).toHaveLength(1));

    await runLands(app, L1);

    expect(polls(app)).toBeGreaterThan(asked);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
  });

  it('a prompt answer alone arms polling and shows the notice when its run lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Host() {
      const actions = useReaderActions();
      const { notice } = useEstimateNoticeState();
      return (
        <>
          <button onClick={() => actions.dispatch(item(1), { type: 'promptAnswer', liked: true })}>
            Answer prompt
          </button>
          {notice === null ? null : (
            <p>
              Prompt updated: {notice.up} up, {notice.down} down
            </p>
          )}
        </>
      );
    }
    const app = renderReader(<Host />, {
      routes: {
        [LEARNING_ESTIMATES]: learningEstimatesRoute(() => status),
        'POST /articles/:id/prompt-answer': () => actionResponse(acked(item(1), { rating: 1 })),
      },
    });
    await advance(10_000);
    expect(app.calls('GET', '/me/learning/estimates')).toHaveLength(0);
    await app.user.click(screen.getByRole('button', { name: 'Answer prompt' }));
    await advance(5_000);
    expect(app.calls('POST', '/articles/1/prompt-answer')).toHaveLength(1);
    expect(app.calls('GET', '/me/learning/estimates').length).toBeGreaterThan(0);
    withRun(null);
    await advance(5_000);
    withRun(L1);
    await advance(5_000);
    expect(await screen.findByText('Prompt updated: 12 up, 30 down')).toBeVisible();
  });
});

describe('polling bounds', () => {
  it('stops 60 s after the last rating when nothing advanced', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    const armed = polls(app);

    await advance(30_000);
    expect(polls(app)).toBeGreaterThan(armed);

    await advance(40_000);
    const settled = polls(app);
    expect(settled - armed).toBeLessThanOrEqual(14);

    await advance(120_000);
    expect(polls(app)).toBe(settled);
    expect(notice()).toBeNull();
  });

  it('a later rating starts the polling again', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await advance(100_000);
    const settled = polls(app);

    await app.user.click(likeOf('Article 2'));
    await advance(20_000);

    expect(polls(app)).toBeGreaterThanOrEqual(settled + 3);
  });

  it('stops after the notice', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
    const settled = polls(app);

    await advance(120_000);

    expect(polls(app)).toBe(settled);
  });

  it('does not poll while the tab is hidden', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await nextPoll(app);
    setVisibility('hidden');
    const settled = polls(app);

    await advance(40_000);

    expect(polls(app)).toBe(settled);
  });

  it('does not poll while the browser is offline', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await nextPoll(app);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    // Keep TanStack online: the hook itself must explicitly stop its interval.
    onlineManager.setOnline(true);
    const settled = polls(app);

    await advance(40_000);

    expect(polls(app)).toBe(settled);
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await nextPoll(app);
  });
});

describe('Show and Dismiss', () => {
  it('does not touch the list while the reader is scrolled down; Show loads page one once', async () => {
    const { app } = await openReader();
    // The router restores the scroll position once while the reader opens.
    scrollTo.mockClear();
    scrolled = 400;
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
    await advance(20_000);
    const listed = lists(app);
    const titles = rowTitles();
    const counted = countsQueries(app).length;

    expect(lists(app)).toBe(listed);
    expect(rowTitles()).toEqual(titles);
    expect(scrollTo).not.toHaveBeenCalled();

    await show(app);

    await vi.waitFor(() => expect(lists(app)).toBe(listed + 1));
    expect(listQueries(app).at(-1)).not.toHaveProperty('cursor');
    await vi.waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(counted));
    await vi.waitFor(() => expect(notice()).toBeNull());
    expect(sentence(SENTENCE_L1)).toBeNull();
    expect(scrollTo).toHaveBeenCalled();
    await advance(10_000);
    expect(lists(app)).toBe(listed + 1);
  });

  it('does not touch the list while an article is open; Show loads it and the article stays open', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await app.user.click(screen.getByRole('button', { name: 'Article 2' }));
    await runLands(app, L1);
    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
    await advance(20_000);
    const listed = lists(app);
    const titles = rowTitles();
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    expect(lists(app)).toBe(listed);
    expect(rowTitles()).toEqual(titles);

    await show(app);

    await vi.waitFor(() => expect(lists(app)).toBe(listed + 1));
    expect(listQueries(app).at(-1)).not.toHaveProperty('cursor');
    await vi.waitFor(() => expect(notice()).toBeNull());
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('never announces the same run again after Show, but does announce a later run after another rating', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);
    await show(app);
    await vi.waitFor(() => expect(notice()).toBeNull());

    withRun(L1);
    await advance(120_000);
    expect(notice()).toBeNull();
    expect(sentence(SENTENCE_L1)).toBeNull();

    await app.user.click(likeOf('Article 3'));
    await runLands(app, L2, L1);

    expect(await screen.findByText(SENTENCE_L2)).toBeVisible();
  });

  it('Dismiss removes the notice, asks for no list, and the same run does not come back', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);
    const text = await screen.findByText(SENTENCE_L1);
    const bar = text.closest('[role="status"]');
    expect(bar).not.toBeNull();
    expect(bar).not.toContainElement(screen.getByRole('button', { name: DISMISS }));
    await advance(5_000);
    const listed = lists(app);

    await app.user.click(screen.getByRole('button', { name: DISMISS }));

    expect(sentence(SENTENCE_L1)).toBeNull();
    expect(notice()).toBeNull();
    await advance(120_000);
    expect(lists(app)).toBe(listed);
    expect(sentence(SENTENCE_L1)).toBeNull();

    await app.user.click(likeOf('Article 3'));
    await runLands(app, L1, L1);
    await advance(10_000);
    expect(sentence(SENTENCE_L1)).toBeNull();

    await app.user.click(likeOf('Article 2'));
    await runLands(app, L2, L1);
    expect(await screen.findByText(SENTENCE_L2)).toBeVisible();
  });
});

describe('where the notice is shown', () => {
  it.each([
    { name: 'the New lane', path: '/read/new' },
    { name: 'a feed view showing all lanes', path: '/read/feed/7' },
  ])('is shown in $name', async ({ path }) => {
    const { app } = await openReader({ path });
    await app.user.click(likeOf('Article 1'));

    await runLands(app, L1);

    expect(await screen.findByText(SENTENCE_L1)).toBeVisible();
    expect(screen.getByRole('button', { name: SHOW })).toBeVisible();
  });

  it.each([
    { name: 'For you', path: '/read/for_you' },
    { name: 'Maybe', path: '/read/maybe' },
    { name: 'Everything else', path: '/read/everything' },
  ])('is not shown in $name even when armed and the run advanced', async ({ path }) => {
    const { app } = await openReader({ path });
    await app.user.click(likeOf('Article 1'));

    await runLands(app, L1);
    await advance(10_000);

    expect(sentence(SENTENCE_L1)).toBeNull();
    expect(notice()).toBeNull();
    expect(screen.queryByRole('button', { name: DISMISS })).toBeNull();
  });
});

describe('the notice as a live region', () => {
  it('puts the sentence in a polite status element; Show and Dismiss are buttons outside it', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await runLands(app, L1);

    const text = await screen.findByText(SENTENCE_L1);
    const bar = text.closest('[role="status"]');
    expect(bar).not.toBeNull();
    const showButton = screen.getByRole('button', { name: SHOW });
    const dismissButton = screen.getByRole('button', { name: DISMISS });
    expect(showButton).toHaveTextContent('Show');
    expect(bar).not.toContainElement(showButton);
    expect(bar).not.toContainElement(dismissButton);
    expect(bar).not.toHaveTextContent('Show');
  });
});

describe('in Slovak', () => {
  const SK = 'Aktualizované podľa vašich hodnotení:';
  it.each([
    { up: 1, text: `${SK} 1 neprečítaný článok sa posunul vyššie, 2 nižšie` },
    { up: 3, text: `${SK} 3 neprečítané články sa posunuli vyššie, 2 nižšie` },
    { up: 5, text: `${SK} 5 neprečítaných článkov sa posunulo vyššie, 2 nižšie` },
  ])('says $up up with the right plural form', async ({ up, text }) => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await act(() => app.i18n.changeLanguage('sk'));

    await runLands(app, run(L1.at, up, 2));

    expect(await screen.findByText(text)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Zobraziť články v novom poradí' }),
    ).toHaveTextContent('Zobraziť');
    expect(screen.getByRole('button', { name: 'Zavrieť oznámenie o aktualizácii' })).toBeVisible();
  });

  it('says the up-only and down-only forms', async () => {
    const { app } = await openReader();
    await app.user.click(likeOf('Article 1'));
    await act(() => app.i18n.changeLanguage('sk'));

    await runLands(app, run(L1.at, 0, 3));

    expect(await screen.findByText(`${SK} 3 neprečítané články sa posunuli nižšie`)).toBeVisible();
  });
});
