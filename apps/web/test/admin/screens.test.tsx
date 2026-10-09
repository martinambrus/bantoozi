import type { AdminOverview } from '@bantoozi/shared';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { gate } from '../interests/support.js';
import { bodyOf, renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';
import {
  T1,
  T2,
  adminMe,
  adminRoutes,
  breaker,
  makeFeed,
  makeInvite,
  makeInviteDto,
  makeOverview,
  makeUsage,
  makeUser,
  makeWaitlistEntry,
  page,
  unhandledGuard,
} from './support.js';

const guard = unhandledGuard();
const REQUESTED = '2026-10-08T09:10:00.000Z';
const ENGINE = 'Jev (typesafe)';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(path: string, routes: Record<string, ApiRouteHandler> = {}) {
  return guard(await renderApp({ path, server: { me: adminMe(), routes: adminRoutes(routes) } }));
}

/** `open`, also giving the fake API, so that a test can end the sign-in. */
async function openWithServer(path: string, routes: Record<string, ApiRouteHandler> = {}) {
  const server: FakeServer = { me: adminMe(), routes: adminRoutes(routes) };
  return { app: guard(await renderApp({ path, server })), server };
}

const inGroup = (name: string) => within(screen.getByRole('group', { name }));
const inRow = (name: RegExp) => within(screen.getByRole('row', { name }));
const bodyRows = (table: HTMLElement) =>
  Array.from(table.querySelectorAll('tbody tr'), (row) =>
    Array.from(row.children, (cell) => cell.textContent ?? ''),
  );
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

type Breakers = AdminOverview['engine']['breakers'];

function overviewWith(breakers: Partial<Breakers>): Response {
  const base = makeOverview();
  return json(
    200,
    makeOverview({
      engine: { ...base.engine, breakers: { ...base.engine.breakers, ...breakers } },
    }),
  );
}

describe('overview (spec 09 §8)', () => {
  it('shows the tiles for users, feeds, articles, spend, LLM calls and tier-2 translations', async () => {
    await open('/admin');
    await screen.findByRole('group', { name: 'Users' });

    expect(inGroup('Users').getByText('120')).toBeVisible();
    expect(inGroup('Users').getByText('Active in the last 7 days: 34')).toBeVisible();
    for (const line of ['Active: 100', 'Quarantined: 3', 'Dead: 2', 'Paused: 1']) {
      expect(inGroup('Feeds').getByText(line)).toBeVisible();
    }
    expect(inGroup('Articles today').getByText('57')).toBeVisible();
    expect(inGroup('Spend today').getByText('$1.20 of $5.00')).toBeVisible();
    expect(inGroup('LLM calls today').getByText('12 of 200')).toBeVisible();
    expect(inGroup('Tier-2 translations today').getByText('40 of 300')).toBeVisible();
  });

  it('lists the queue depths and the translations of the last 24 hours', async () => {
    await open('/admin');

    const queues = await screen.findByRole('table', { name: 'Job queues' });
    expect(
      within(queues)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Queue', 'Waiting', 'Retrying', 'Running', 'Failed']);
    expect(bodyRows(queues)).toEqual([
      ['article.extract', '4', '1', '2', '0'],
      ['feed.fetch', '0', '0', '1', '5'],
    ]);
    const translations = screen.getByRole('table', { name: 'Translations in the last 24 hours' });
    expect(bodyRows(translations)).toEqual([
      ['LibreTranslate', 'OK', '80'],
      ['Ollama', 'Weak', '3'],
    ]);
  });

  it('says when there are no queues and no translations to report', async () => {
    await open('/admin', {
      'GET /admin/overview': () =>
        json(
          200,
          makeOverview({
            queues: [],
            translations: { last24h: [], tier2CallsToday: 0, tier2DailyCap: 300 },
          }),
        ),
    });

    expect(await screen.findByText('No queues report any jobs.')).toBeVisible();
    expect(screen.getByText('No translations were stored in the last 24 hours.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each([
    ['closed', 'Closed', 'Calls to the provider are going through.'],
    ['open', 'Open', 'Calls are paused because the provider keeps failing.'],
    ['half_open', 'Half open', 'One test call is allowed to see whether the provider recovered.'],
    [
      'auth',
      'Authentication error',
      'The provider rejected the key. Calls stay paused until the breaker is reset.',
    ],
  ] as const)('says in words that a breaker is %s', async (state, word, explanation) => {
    await open('/admin', {
      'GET /admin/overview': () =>
        overviewWith({ typesafe: breaker({ state, openUntil: state === 'open' ? T2 : null }) }),
    });
    const jev = await screen.findByRole('group', { name: ENGINE });

    expect(within(jev).getByText(word)).toBeVisible();
    expect(within(jev).getByText(explanation)).toBeVisible();
    expect(jev.querySelector('time') !== null).toBe(state === 'open');
    expect(inGroup('LLM fallback').getByText('Closed')).toBeVisible();
  });

  it('resets a breaker after a confirmation, shows when it was asked for and refetches until the worker applied it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = breaker({ state: 'open', openUntil: T2 });
    let reads = 0;
    const app = await open('/admin', {
      'GET /admin/overview': () => {
        reads += 1;
        return overviewWith({ typesafe: current });
      },
      'POST /admin/engine/reset-breaker': () => {
        current = { ...current, resetRequestedAt: REQUESTED };
        return json(200, { engine: 'typesafe', resetRequestedAt: REQUESTED });
      },
    });
    await screen.findByRole('group', { name: ENGINE });
    expect(inGroup(ENGINE).getByText('Open')).toBeVisible();
    expect(inGroup(ENGINE).queryByText('Last reset requested:')).toBeNull();

    await app.user.click(inGroup(ENGINE).getByRole('button', { name: 'Reset breaker' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Reset the breaker for Jev (typesafe)?',
    });
    expect(
      within(dialog).getByText(/The worker applies the reset within about 10 seconds/),
    ).toBeVisible();
    expect(app.calls('POST /admin/engine/reset-breaker')).toHaveLength(0);
    await app.user.click(within(dialog).getByRole('button', { name: 'Reset breaker' }));

    expect(
      await inGroup(ENGINE).findByText('Waiting for the worker to apply the reset…'),
    ).toBeVisible();
    const [request] = app.calls('POST /admin/engine/reset-breaker');
    expect(bodyOf(request!)).toEqual({ engine: 'typesafe' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await inGroup(ENGINE).findByText('Last reset requested:')).toBeVisible();
    expect(reads).toBe(2);
    expect(
      screen.getByRole('group', { name: ENGINE }).querySelector(`time[datetime="${REQUESTED}"]`),
    ).not.toBeNull();

    const before = reads;
    await wait(4_000);
    expect(reads - before).toBe(2);
    expect(inGroup(ENGINE).getByText('Open')).toBeVisible();

    current = breaker({ state: 'closed', resetRequestedAt: REQUESTED });
    await wait(2_000);
    expect(await inGroup(ENGINE).findByText('Closed')).toBeVisible();
    expect(inGroup(ENGINE).queryByText('Waiting for the worker to apply the reset…')).toBeNull();
    const settled = reads;
    await wait(10_000);
    expect(reads).toBe(settled);
  });

  it('stops waiting for the worker after a while and says that it has not applied the reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    let current = breaker({ state: 'auth' });
    const app = await open('/admin', {
      'GET /admin/overview': () => {
        reads += 1;
        return overviewWith({ typesafe: current });
      },
      'POST /admin/engine/reset-breaker': () => {
        current = { ...current, resetRequestedAt: REQUESTED };
        return json(200, { engine: 'typesafe', resetRequestedAt: REQUESTED });
      },
    });
    await screen.findByRole('group', { name: ENGINE });
    await app.user.click(inGroup(ENGINE).getByRole('button', { name: 'Reset breaker' }));
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset breaker' }),
    );
    await inGroup(ENGINE).findByText('Waiting for the worker to apply the reset…');

    await wait(40_000);

    expect(
      await inGroup(ENGINE).findByText(
        'The worker has not applied the reset yet. Check that a worker is running.',
      ),
    ).toBeVisible();
    const settled = reads;
    await wait(20_000);
    expect(reads).toBe(settled);
  });

  it('explains a breaker whose stored state is invalid (409)', async () => {
    const app = await open('/admin', {
      'POST /admin/engine/reset-breaker': () =>
        failure(409, 'CONFLICT', { reason: 'circuit_invalid' }),
    });
    await screen.findByRole('group', { name: ENGINE });

    await app.user.click(inGroup(ENGINE).getByRole('button', { name: 'Reset breaker' }));
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset breaker' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The stored breaker state is invalid, so it cannot be reset from here.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('queues the reprocessing of skipped translations', async () => {
    const app = await open('/admin', {
      'POST /admin/translations/reprocess': () => json(202, { queued: true }),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Reprocess translations' }));

    expect(
      await screen.findByText('Reprocessing of the skipped translations is queued.'),
    ).toBeVisible();
    const [request] = app.calls('POST /admin/translations/reprocess');
    expect(bodyOf(request!)).toEqual({});
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
  });

  it('confirms nothing when the reprocessing is queued once the sign-in has ended', async () => {
    const answer = gate();
    const { app, server } = await openWithServer('/admin', {
      'POST /admin/translations/reprocess': async () => {
        await answer.opened;
        return json(202, { queued: true });
      },
    });
    await app.user.click(await screen.findByRole('button', { name: 'Reprocess translations' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/translations/reprocess')).toHaveLength(1));

    server.me = null;
    await act(() => app.session.resetAccountState());
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('Reprocessing of the skipped translations is queued.')).toBeNull();
  });
});

describe('usage (spec 09 §8)', () => {
  const usageForDays: ApiRouteHandler = (request) =>
    json(200, makeUsage({ days: Number(request.query.get('days')) }));

  it('draws the daily cost as a bar chart that a screen reader can follow', async () => {
    await open('/admin/usage');

    const chart = await screen.findByRole('img', { name: 'Daily cost, last 30 days' });
    const summary =
      'Spend from 2026-10-01 to 2026-10-04: $6.50 in total, highest on 2026-10-03 at $3.00.';
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(chart).toHaveAccessibleDescription(summary);
    expect(screen.getByText(summary)).toBeVisible();
    const bars = Array.from(chart.querySelectorAll('rect'));
    expect(bars.map((bar) => bar.querySelector('title')?.textContent)).toEqual([
      '2026-10-01: $1.50',
      '2026-10-02: $0.00',
      '2026-10-03: $3.00',
      '2026-10-04: $2.00',
    ]);
    const heights = bars.map((bar) => Number(bar.getAttribute('height')));
    expect(heights[1]).toBe(0);
    expect(heights[2]!).toBeGreaterThan(heights[3]!);
    expect(heights[3]!).toBeGreaterThan(heights[0]!);
    expect(heights[0]!).toBeGreaterThan(0);
  });

  it('describes a chart of a single day', async () => {
    await open('/admin/usage', {
      'GET /admin/usage': () =>
        json(
          200,
          makeUsage({
            daily: [
              { day: '2026-10-03', engine: 'typesafe', kind: 'enrich', calls: 3, costUsd: 3 },
            ],
          }),
        ),
    });

    expect(
      await screen.findByRole('img', { name: 'Daily cost, last 30 days' }),
    ).toHaveAccessibleDescription('Spend on 2026-10-03: $3.00.');
  });

  it('lists the top users with the cost they caused', async () => {
    await open('/admin/usage');

    const table = await screen.findByRole('table', { name: 'Top users by estimated cost' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['User', 'Direct', 'Shared', 'Total']);
    expect(bodyRows(table)).toEqual([
      ['heavy@example.com', '$2.00', '$0.50', '$2.50'],
      ['No email on record', '$0.25', '$0.00', '$0.25'],
    ]);
  });

  it('asks for the selected period and keeps it in the address', async () => {
    const app = await open('/admin/usage', { 'GET /admin/usage': usageForDays });
    await screen.findByRole('img', { name: 'Daily cost, last 30 days' });
    expect(app.calls('GET /admin/usage')[0]!.query.get('days')).toBe('30');

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'Last 7 days');

    expect(await screen.findByRole('img', { name: 'Daily cost, last 7 days' })).toBeVisible();
    expect(app.calls('GET /admin/usage').at(-1)!.query.get('days')).toBe('7');
    expect(app.router.state.location.search).toEqual({ days: 7 });

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'Last 30 days');

    expect(await screen.findByRole('img', { name: 'Daily cost, last 30 days' })).toBeVisible();
    expect(app.router.state.location.search).toEqual({});
  });

  it.each([
    ['/admin/usage?days=14', '14'],
    ['/admin/usage?days=0', '30'],
    ['/admin/usage?days=abc', '30'],
    ['/admin/usage?days=365', '30'],
    ['/admin/usage?days=45', '30'],
  ])('opens %s with a period of %s days', async (path, days) => {
    const app = await open(path, { 'GET /admin/usage': usageForDays });

    expect(await screen.findByRole('img', { name: `Daily cost, last ${days} days` })).toBeVisible();
    expect(app.calls('GET /admin/usage')[0]!.query.get('days')).toBe(days);
  });

  it('says when nothing was spent', async () => {
    await open('/admin/usage', {
      'GET /admin/usage': () => json(200, makeUsage({ daily: [], topUsers: [] })),
    });

    expect(await screen.findByText('No spend was recorded in this period.')).toBeVisible();
    expect(screen.getByText('No usage is attributed to users in this period.')).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('feeds (spec 09 §8)', () => {
  const broken = makeFeed({
    id: '42',
    url: 'https://blog.example.org/rss',
    title: 'Broken Blog',
    status: 'quarantined',
    subscriberCount: 2,
    consecutiveErrors: 5,
    quarantineCount: 2,
    quarantinedUntil: T2,
    lastErrorCode: 'FEED_HTTP_503',
    lastErrorAt: T1,
  });

  it('lists the feeds with their status and what went wrong', async () => {
    await open('/admin/feeds', { 'GET /admin/feeds': () => json(200, page([makeFeed(), broken])) });

    const table = await screen.findByRole('table', { name: 'Feeds' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Feed', 'Status', 'Subscribers', 'Errors', 'Last success', 'Next fetch', 'Actions']);
    const healthy = inRow(/Example News/);
    expect(healthy.getByText('https://news.example.com/feed.xml')).toBeVisible();
    expect(healthy.getByText('Active')).toBeVisible();
    expect(healthy.getByText('7')).toBeVisible();
    expect(healthy.getByText('None')).toBeVisible();
    const sick = inRow(/Broken Blog/);
    expect(sick.getByText('Quarantined')).toBeVisible();
    expect(sick.getByText('FEED_HTTP_503, 5 in a row')).toBeVisible();
    expect(
      screen.getByRole('row', { name: /Broken Blog/ }).querySelector(`time[datetime="${T2}"]`),
    ).not.toBeNull();
  });

  it('filters by status and searches, keeping both in the address', async () => {
    const seen: string[] = [];
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': (request) => {
        seen.push(`${request.query.get('status') ?? ''}|${request.query.get('q') ?? ''}`);
        return json(200, page([makeFeed()]));
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Quarantined');

    await vi.waitFor(() => expect(seen.at(-1)).toBe('quarantined|'));
    expect(app.router.state.location.search).toEqual({ status: 'quarantined' });

    await app.user.type(screen.getByRole('searchbox', { name: 'Search feeds' }), 'news{Enter}');

    await vi.waitFor(() => expect(seen.at(-1)).toBe('quarantined|news'));
    expect(app.router.state.location.search).toEqual({ status: 'quarantined', q: 'news' });

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'All statuses');

    await vi.waitFor(() => expect(seen.at(-1)).toBe('|news'));
    expect(app.router.state.location.search).toEqual({ q: 'news' });
  });

  it.each([
    ['/admin/feeds?status=dead&q=blog', 'dead|blog', 'Dead', 'blog'],
    ['/admin/feeds?q=2024', '|2024', 'All statuses', '2024'],
    ['/admin/feeds?status=nonsense', '|', 'All statuses', ''],
  ])('applies the filters found in %s', async (path, expected, status, text) => {
    const seen: string[] = [];
    await open(path, {
      'GET /admin/feeds': (request) => {
        seen.push(`${request.query.get('status') ?? ''}|${request.query.get('q') ?? ''}`);
        return json(200, page([makeFeed()]));
      },
    });

    await screen.findByRole('table', { name: 'Feeds' });
    expect(seen[0]).toBe(expected);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveDisplayValue(status);
    expect(screen.getByRole('searchbox', { name: 'Search feeds' })).toHaveValue(text);
  });

  it('resets a feed and shows its new state', async () => {
    const server = { feeds: [broken] };
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page(server.feeds)),
      'POST /admin/feeds/:id/reset': () => {
        const reset = {
          ...broken,
          status: 'active' as const,
          consecutiveErrors: 0,
          quarantinedUntil: null,
          lastErrorCode: null,
        };
        server.feeds = [reset];
        return json(200, { feed: reset });
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });
    expect(inRow(/Broken Blog/).getByText('Quarantined')).toBeVisible();

    await app.user.click(inRow(/Broken Blog/).getByRole('button', { name: 'Reset Broken Blog' }));

    expect(await screen.findByText('Feed reset. It will be fetched again soon.')).toBeVisible();
    const [request] = app.calls('POST /admin/feeds/:id/reset');
    expect(request!.pathname).toBe('/api/v1/admin/feeds/42/reset');
    expect(bodyOf(request!)).toEqual({});
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(await inRow(/Broken Blog/).findByText('Active')).toBeVisible();
    expect(inRow(/Broken Blog/).queryByText('Quarantined')).toBeNull();
    expect(app.calls('GET /admin/feeds')).toHaveLength(2);
  });

  it('explains a feed that was merged into another one and cannot be reset (409)', async () => {
    const server = { feeds: [broken] };
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page(server.feeds)),
      'POST /admin/feeds/:id/reset': () => {
        server.feeds = [{ ...broken, status: 'dead', mergedIntoId: '41' }];
        return failure(409, 'CONFLICT', { reason: 'merged' });
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });

    await app.user.click(inRow(/Broken Blog/).getByRole('button', { name: 'Reset Broken Blog' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This feed was merged into another feed and cannot be reset. The list was refreshed.',
    );
    expect(app.calls('GET /admin/feeds')).toHaveLength(2);
    expect(await inRow(/Broken Blog/).findByText('Merged into feed 41')).toBeVisible();
    expect(inRow(/Broken Blog/).getByRole('button', { name: 'Reset Broken Blog' })).toBeDisabled();
  });

  it('locks every Reset button while one feed is being reset', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = makeFeed({
      id: '43',
      url: 'https://other.example.com/feed.xml',
      title: 'Other Feed',
    });
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page([broken, other])),
      'POST /admin/feeds/:id/reset': async () => {
        await held;
        return json(200, { feed: { ...broken, status: 'active' as const, consecutiveErrors: 0 } });
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });
    const resetBroken = () =>
      inRow(/Broken Blog/).getByRole('button', { name: 'Reset Broken Blog' });
    const resetOther = () => inRow(/Other Feed/).getByRole('button', { name: 'Reset Other Feed' });

    await app.user.click(resetBroken());
    await vi.waitFor(() => expect(resetBroken()).toHaveAttribute('aria-busy', 'true'));

    expect(resetOther()).toBeDisabled();
    await app.user.click(resetOther());
    release();

    expect(await screen.findByText('Feed reset. It will be fetched again soon.')).toBeVisible();
    expect(app.calls('POST /admin/feeds/:id/reset')).toHaveLength(1);
    expect(app.calls('POST /admin/feeds/:id/reset')[0]!.pathname).toBe(
      '/api/v1/admin/feeds/42/reset',
    );
    await vi.waitFor(() => expect(resetBroken()).toBeEnabled());
    expect(resetBroken()).not.toHaveAttribute('aria-busy');
    expect(resetOther()).toBeEnabled();
  });

  it('edits the user-agent and the hard-feed flag, replacing the options as a whole', async () => {
    const saved = makeFeed({
      fetchOptions: { userAgent: 'BantooziBot/1.0', translateStrong: true },
    });
    const app = await open('/admin/feeds', {
      'PATCH /admin/feeds/:id': () => json(200, { feed: saved }),
    });
    await screen.findByRole('table', { name: 'Feeds' });

    await app.user.click(screen.getByRole('button', { name: 'Edit options of Example News' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fetch options for Example News' });
    expect(within(dialog).getByLabelText('User-Agent override')).toHaveValue('');
    expect(
      within(dialog).getByLabelText('Hard feed: translate with the stronger model'),
    ).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Save options' })).toBeDisabled();
    await app.user.type(within(dialog).getByLabelText('User-Agent override'), 'BantooziBot/1.0');
    await app.user.click(
      within(dialog).getByLabelText('Hard feed: translate with the stronger model'),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Save options' }));

    expect(await screen.findByText('Fetch options saved.')).toBeVisible();
    const [request] = app.calls('PATCH /admin/feeds/:id');
    expect(request!.pathname).toBe('/api/v1/admin/feeds/41');
    expect(bodyOf(request!)).toEqual({
      fetchOptions: { userAgent: 'BantooziBot/1.0', translateStrong: true },
    });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls('GET /admin/feeds')).toHaveLength(2);
  });

  it('starts from the options in place and drops what was cleared', async () => {
    const configured = makeFeed({ fetchOptions: { userAgent: 'Old/1.0', translateStrong: true } });
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page([configured])),
      'PATCH /admin/feeds/:id': () =>
        json(200, { feed: { ...configured, fetchOptions: { translateStrong: true } } }),
    });
    await screen.findByRole('table', { name: 'Feeds' });

    await app.user.click(screen.getByRole('button', { name: 'Edit options of Example News' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('User-Agent override')).toHaveValue('Old/1.0');
    expect(
      within(dialog).getByLabelText('Hard feed: translate with the stronger model'),
    ).toBeChecked();
    await app.user.clear(within(dialog).getByLabelText('User-Agent override'));
    await app.user.click(within(dialog).getByRole('button', { name: 'Save options' }));

    await screen.findByText('Fetch options saved.');
    expect(bodyOf(app.calls('PATCH /admin/feeds/:id')[0]!)).toEqual({
      fetchOptions: { translateStrong: true },
    });
  });

  it('rejects a user-agent that is not printable ASCII before any request', async () => {
    const app = await open('/admin/feeds');
    await screen.findByRole('table', { name: 'Feeds' });

    await app.user.click(screen.getByRole('button', { name: 'Edit options of Example News' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.type(within(dialog).getByLabelText('User-Agent override'), 'Bötli/1.0');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save options' }));

    expect(within(dialog).getByLabelText('User-Agent override')).toBeInvalid();
    expect(within(dialog).getByText('Use printable ASCII characters only.')).toBeVisible();
    expect(app.calls('PATCH /admin/feeds/:id')).toHaveLength(0);
  });

  it('confirms nothing when the feed is reset once the sign-in has ended', async () => {
    const answer = gate();
    const { app, server } = await openWithServer('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page([broken])),
      'POST /admin/feeds/:id/reset': async () => {
        await answer.opened;
        return json(200, { feed: { ...broken, status: 'active' as const, consecutiveErrors: 0 } });
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });
    await app.user.click(inRow(/Broken Blog/).getByRole('button', { name: 'Reset Broken Blog' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/feeds/:id/reset')).toHaveLength(1));

    server.me = null;
    await act(() => app.session.resetAccountState());
    // The list as the next sign-in of this account has loaded it by now.
    const feeds = accountKey(adminMe().id, 'admin', 'feeds');
    app.queryClient.setQueryData(feeds, { pages: [], pageParams: [] });
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('Feed reset. It will be fetched again soon.')).toBeNull();
    expect(app.queryClient.getQueryState(feeds)?.isInvalidated).toBe(false);
  });

  it('confirms nothing when the options are saved once the sign-in has ended', async () => {
    const answer = gate();
    const { app, server } = await openWithServer('/admin/feeds', {
      'PATCH /admin/feeds/:id': async () => {
        await answer.opened;
        return json(200, { feed: makeFeed({ fetchOptions: { userAgent: 'BantooziBot/1.0' } }) });
      },
    });
    await screen.findByRole('table', { name: 'Feeds' });
    await app.user.click(screen.getByRole('button', { name: 'Edit options of Example News' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.type(within(dialog).getByLabelText('User-Agent override'), 'BantooziBot/1.0');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save options' }));
    await vi.waitFor(() => expect(app.calls('PATCH /admin/feeds/:id')).toHaveLength(1));

    server.me = null;
    await act(() => app.session.resetAccountState());
    // The list as the next sign-in of this account has loaded it by now.
    const feeds = accountKey(adminMe().id, 'admin', 'feeds');
    app.queryClient.setQueryData(feeds, { pages: [], pageParams: [] });
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('Fetch options saved.')).toBeNull();
    expect(app.queryClient.getQueryState(feeds)?.isInvalidated).toBe(false);
  });
});

describe('users (spec 09 §8)', () => {
  const administrator = makeUser({
    id: '0192f7a0-0000-7000-8000-0000000000b2',
    email: 'boss@example.com',
    displayName: null,
    role: 'admin',
    plan: 'admin',
    adminBootstrap: true,
  });

  it('lists the users with role, plan and invites, and searches through the address', async () => {
    const seen: string[] = [];
    const app = await open('/admin/users', {
      'GET /admin/users': (request) => {
        seen.push(request.query.get('q') ?? '');
        return json(200, page([makeUser(), administrator]));
      },
    });

    const table = await screen.findByRole('table', { name: 'Users' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['User', 'Role', 'Plan', 'Invites left', 'Last active', 'Joined', 'Actions']);
    const reader = inRow(/reader@example\.com/);
    expect(reader.getByText('Rita Reader')).toBeVisible();
    expect(reader.getByText('User')).toBeVisible();
    expect(reader.getByText('beta')).toBeVisible();
    expect(reader.getByText('3')).toBeVisible();
    expect(inRow(/boss@example\.com/).getByText('Admin')).toBeVisible();

    await app.user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'rita{Enter}');

    await vi.waitFor(() => expect(seen.at(-1)).toBe('rita'));
    expect(app.router.state.location.search).toEqual({ q: 'rita' });
  });

  it('marks a deleted account and does not offer to edit it', async () => {
    await open('/admin/users', {
      'GET /admin/users': () => json(200, page([makeUser({ deletedAt: T1 })])),
    });

    const row = within(await screen.findByRole('row', { name: /reader@example\.com/ }));
    expect(row.getByText('Deleted')).toBeVisible();
    expect(row.getByRole('button', { name: 'Edit reader@example.com' })).toBeDisabled();
  });

  it('changes role, plan and invites, sending only what changed, and reports the sessions signed out', async () => {
    const user = makeUser();
    const app = await open('/admin/users', {
      'PATCH /admin/users/:id': () =>
        json(200, { user: { ...user, role: 'admin', invitesLeft: 8 }, sessionsRevoked: 2 }),
    });
    await screen.findByRole('table', { name: 'Users' });

    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit reader@example.com' });
    expect(within(dialog).getByRole('button', { name: 'Save user' })).toBeDisabled();
    expect(within(dialog).getByLabelText('Role')).toHaveDisplayValue('User');
    expect(within(dialog).getByLabelText('Plan')).toHaveDisplayValue('beta');
    expect(within(dialog).getByLabelText('Invites left')).toHaveValue(3);
    await app.user.selectOptions(within(dialog).getByLabelText('Role'), 'Admin');
    await app.user.clear(within(dialog).getByLabelText('Invites left'));
    await app.user.type(within(dialog).getByLabelText('Invites left'), '8');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));

    expect(await screen.findByText('User saved. 2 sessions were signed out.')).toBeVisible();
    const [request] = app.calls('PATCH /admin/users/:id');
    expect(request!.pathname).toBe(`/api/v1/admin/users/${user.id}`);
    expect(bodyOf(request!)).toEqual({ role: 'admin', invitesLeft: 8 });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls('GET /admin/users')).toHaveLength(2);
  });

  it('says so when no session had to be signed out', async () => {
    const app = await open('/admin/users', {
      'PATCH /admin/users/:id': () =>
        json(200, { user: { ...makeUser(), plan: 'admin' }, sessionsRevoked: 0 }),
    });
    await screen.findByRole('table', { name: 'Users' });

    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.selectOptions(within(dialog).getByLabelText('Plan'), 'admin');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));

    expect(await screen.findByText('User saved.')).toBeVisible();
    expect(bodyOf(app.calls('PATCH /admin/users/:id')[0]!)).toEqual({ plan: 'admin' });
  });

  it('refuses to remove the last administrator and keeps the dialog open (409 last_admin)', async () => {
    const app = await open('/admin/users', {
      'GET /admin/users': () => json(200, page([administrator])),
      'PATCH /admin/users/:id': () => failure(409, 'CONFLICT', { reason: 'last_admin' }),
    });
    await screen.findByRole('table', { name: 'Users' });

    await app.user.click(screen.getByRole('button', { name: 'Edit boss@example.com' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'Listed in ADMIN_EMAILS: a demotion lasts only until their next login.',
      ),
    ).toBeVisible();
    await app.user.selectOptions(within(dialog).getByLabelText('Role'), 'User');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This is the only active administrator, so the role cannot be removed. Make another account an administrator first.',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(within(dialog).getByLabelText('Role')).toHaveDisplayValue('User');
    expect(app.calls('GET /admin/users')).toHaveLength(1);
  });

  it('checks the number of invites before sending', async () => {
    const app = await open('/admin/users');
    await screen.findByRole('table', { name: 'Users' });

    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.clear(within(dialog).getByLabelText('Invites left'));
    await app.user.type(within(dialog).getByLabelText('Invites left'), '10001');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));

    expect(within(dialog).getByLabelText('Invites left')).toBeInvalid();
    expect(within(dialog).getByText('Enter a whole number from 0 to 10000.')).toBeVisible();
    expect(app.calls('PATCH /admin/users/:id')).toHaveLength(0);
  });

  it('confirms nothing when the user is saved once the sign-in has ended', async () => {
    const answer = gate();
    const { app, server } = await openWithServer('/admin/users', {
      'PATCH /admin/users/:id': async () => {
        await answer.opened;
        return json(200, { user: { ...makeUser(), plan: 'admin' }, sessionsRevoked: 0 });
      },
    });
    await screen.findByRole('table', { name: 'Users' });
    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.selectOptions(within(dialog).getByLabelText('Plan'), 'admin');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));
    await vi.waitFor(() => expect(app.calls('PATCH /admin/users/:id')).toHaveLength(1));

    server.me = null;
    await act(() => app.session.resetAccountState());
    // The list as the next sign-in of this account has loaded it by now.
    const users = accountKey(adminMe().id, 'admin', 'users');
    app.queryClient.setQueryData(users, { pages: [], pageParams: [] });
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('User saved.')).toBeNull();
    expect(app.queryClient.getQueryState(users)?.isInvalidated).toBe(false);
  });
});

describe('invites (spec 09 §8)', () => {
  it('lists the invites and filters them by status through the address', async () => {
    const seen: string[] = [];
    const app = await open('/admin/invites', {
      'GET /admin/invites': (request) => {
        seen.push(request.query.get('status') ?? '');
        return json(
          200,
          page([
            makeInvite(),
            makeInvite({ code: 'USEDCODE222', status: 'used', usedAt: T1, usedBy: makeUser().id }),
          ]),
        );
      },
    });

    const table = await screen.findByRole('table', { name: 'Invites' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Code', 'Email', 'Note', 'Status', 'Created', 'Expires']);
    expect(inRow(/ABCDEFGH23/).getByText('Unused')).toBeVisible();
    expect(inRow(/ABCDEFGH23/).getByText('Beta cohort')).toBeVisible();
    expect(inRow(/USEDCODE222/).getByText('Used')).toBeVisible();

    await app.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Expired');

    await vi.waitFor(() => expect(seen.at(-1)).toBe('expired'));
    expect(app.router.state.location.search).toEqual({ status: 'expired' });
  });

  it('creates an invite for an address and shows its code and link', async () => {
    const created = makeInviteDto({ email: 'friend@example.com' });
    const app = await open('/admin/invites', {
      'POST /admin/invites': () => json(201, { items: [created], emailSent: true }),
    });
    await screen.findByRole('table', { name: 'Invites' });
    expect(screen.getByLabelText('Number of invites')).toHaveValue(1);

    await app.user.type(screen.getByLabelText('Email (optional)'), 'friend@example.com');
    await app.user.type(screen.getByLabelText('Note (optional)'), 'Met at the conference');
    await app.user.type(screen.getByLabelText('Valid for (days, optional)'), '14');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    const result = await screen.findByRole('region', { name: 'New invites' });
    expect(within(result).getByText('1 invite created.')).toBeVisible();
    expect(within(result).getByText('ZXCVBNM234')).toBeVisible();
    expect(within(result).getByText('http://localhost:5173/join?code=ZXCVBNM234')).toBeVisible();
    expect(
      within(result).getByText('The invite was also emailed to friend@example.com.'),
    ).toBeVisible();
    const [request] = app.calls('POST /admin/invites');
    expect(bodyOf(request!)).toEqual({
      count: 1,
      email: 'friend@example.com',
      note: 'Met at the conference',
      expiresDays: 14,
    });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.calls('GET /admin/invites')).toHaveLength(2);
    expect(screen.getByLabelText('Email (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('');
  });

  it('keeps the form as it was left when the note and the days were edited while the invites were on their way', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await open('/admin/invites', {
      'POST /admin/invites': async () => {
        await held;
        return json(201, {
          items: [makeInviteDto({ email: 'friend@example.com' })],
          emailSent: true,
        });
      },
    });
    await screen.findByRole('table', { name: 'Invites' });
    await app.user.type(screen.getByLabelText('Email (optional)'), 'friend@example.com');
    await app.user.type(screen.getByLabelText('Note (optional)'), 'Met at the conference');
    await app.user.type(screen.getByLabelText('Valid for (days, optional)'), '14');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/invites')).toHaveLength(1));

    await app.user.type(screen.getByLabelText('Note (optional)'), ' and more');
    await app.user.clear(screen.getByLabelText('Valid for (days, optional)'));
    await app.user.type(screen.getByLabelText('Valid for (days, optional)'), '30');
    release();

    await screen.findByRole('region', { name: 'New invites' });
    expect(screen.getByLabelText('Number of invites')).toHaveValue(1);
    expect(screen.getByLabelText('Email (optional)')).toHaveValue('friend@example.com');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Met at the conference and more');
    expect(screen.getByLabelText('Valid for (days, optional)')).toHaveValue(30);
    expect(bodyOf(app.calls('POST /admin/invites')[0]!)).toEqual({
      count: 1,
      email: 'friend@example.com',
      note: 'Met at the conference',
      expiresDays: 14,
    });
  });

  it('keeps the form as it was left when the number and the address were edited while the invites were on their way', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await open('/admin/invites', {
      'POST /admin/invites': async () => {
        await held;
        return json(201, {
          items: [makeInviteDto({ email: 'friend@example.com' })],
          emailSent: true,
        });
      },
    });
    await screen.findByRole('table', { name: 'Invites' });
    await app.user.type(screen.getByLabelText('Email (optional)'), 'friend@example.com');
    await app.user.type(screen.getByLabelText('Note (optional)'), 'Met at the conference');
    await app.user.type(screen.getByLabelText('Valid for (days, optional)'), '14');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/invites')).toHaveLength(1));

    await app.user.clear(screen.getByLabelText('Number of invites'));
    await app.user.type(screen.getByLabelText('Number of invites'), '2');
    await app.user.clear(screen.getByLabelText('Email (optional)'));
    await app.user.type(screen.getByLabelText('Email (optional)'), 'other@example.com');
    release();

    await screen.findByRole('region', { name: 'New invites' });
    expect(screen.getByLabelText('Number of invites')).toHaveValue(2);
    expect(screen.getByLabelText('Email (optional)')).toHaveValue('other@example.com');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Met at the conference');
    expect(screen.getByLabelText('Valid for (days, optional)')).toHaveValue(14);
  });

  it('creates several invites at once and lists every code and link', async () => {
    const codes = ['AAAAAAAA22', 'BBBBBBBB33', 'CCCCCCCC44'];
    const app = await open('/admin/invites', {
      'POST /admin/invites': () =>
        json(201, {
          items: codes.map((code) =>
            makeInviteDto({ code, url: `http://localhost:5173/join?code=${code}` }),
          ),
        }),
    });
    await screen.findByRole('table', { name: 'Invites' });

    await app.user.clear(screen.getByLabelText('Number of invites'));
    await app.user.type(screen.getByLabelText('Number of invites'), '3');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    const result = await screen.findByRole('region', { name: 'New invites' });
    expect(within(result).getByText('3 invites created.')).toBeVisible();
    for (const code of codes) {
      expect(within(result).getByText(code)).toBeVisible();
      expect(within(result).getByText(`http://localhost:5173/join?code=${code}`)).toBeVisible();
    }
    expect(within(result).queryByText(/emailed/)).toBeNull();
    expect(bodyOf(app.calls('POST /admin/invites')[0]!)).toEqual({ count: 3 });
  });

  it('tells when the invitation email could not be sent, so the link is shared by hand', async () => {
    const app = await open('/admin/invites', {
      'POST /admin/invites': () =>
        json(201, { items: [makeInviteDto({ email: 'friend@example.com' })], emailSent: false }),
    });
    await screen.findByRole('table', { name: 'Invites' });

    await app.user.type(screen.getByLabelText('Email (optional)'), 'friend@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    expect(
      await screen.findByText('The email could not be sent. Share the link yourself.'),
    ).toBeVisible();
  });

  it.each([
    ['Number of invites', '0', 'Enter a whole number from 1 to 50.'],
    ['Number of invites', '51', 'Enter a whole number from 1 to 50.'],
    ['Email (optional)', 'not-an-address', 'Enter a valid email address.'],
    ['Valid for (days, optional)', '91', 'Enter a whole number from 1 to 90.'],
  ])('rejects %s = %s before any request', async (label, text, message) => {
    const app = await open('/admin/invites');
    await screen.findByRole('table', { name: 'Invites' });

    const field = screen.getByLabelText(label);
    await app.user.clear(field);
    await app.user.type(field, text);
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    expect(field).toBeInvalid();
    expect(screen.getByText(message)).toBeVisible();
    expect(app.calls('POST /admin/invites')).toHaveLength(0);
  });

  it('creates an email invite only one at a time', async () => {
    const app = await open('/admin/invites');
    await screen.findByRole('table', { name: 'Invites' });

    await app.user.clear(screen.getByLabelText('Number of invites'));
    await app.user.type(screen.getByLabelText('Number of invites'), '2');
    await app.user.type(screen.getByLabelText('Email (optional)'), 'friend@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    expect(screen.getByLabelText('Number of invites')).toBeInvalid();
    expect(
      screen.getByText('An invite for one email address is created one at a time.'),
    ).toBeVisible();
    expect(app.calls('POST /admin/invites')).toHaveLength(0);
  });

  it('shows why the server refused to create invites', async () => {
    const app = await open('/admin/invites', {
      'POST /admin/invites': () => failure(429, 'RATE_LIMITED', { retryAfter: 30 }),
    });
    await screen.findByRole('table', { name: 'Invites' });

    await app.user.click(screen.getByRole('button', { name: 'Create invites' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Wait a moment and try again.',
    );
  });
});

describe('waitlist (spec 09 §8)', () => {
  const invited = makeWaitlistEntry({
    id: '6',
    email: 'done@example.com',
    invitedAt: T1,
    inviteCode: 'DONECODE22',
  });

  it('lists the waiting people and those who were invited', async () => {
    await open('/admin/waitlist', {
      'GET /admin/waitlist': () => json(200, page([makeWaitlistEntry(), invited])),
    });

    const table = await screen.findByRole('table', { name: 'Waitlist' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Email', 'Language', 'Note', 'Joined', 'Status', 'Actions']);
    expect(inRow(/wait@example\.com/).getByText('Waiting')).toBeVisible();
    expect(
      inRow(/wait@example\.com/).getByRole('button', { name: 'Invite wait@example.com' }),
    ).toBeEnabled();
    expect(inRow(/done@example\.com/).getByText('Invited')).toBeVisible();
    expect(inRow(/done@example\.com/).getByText('DONECODE22')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Invite done@example.com' })).toBeNull();
  });

  it('invites a person and shows the invite to share', async () => {
    const server = { entries: [makeWaitlistEntry()] };
    const invite = makeInviteDto({ email: 'wait@example.com' });
    const app = await open('/admin/waitlist', {
      'GET /admin/waitlist': () => json(200, page(server.entries)),
      'POST /admin/waitlist/:id/invite': () => {
        const entry = makeWaitlistEntry({ invitedAt: T1, inviteCode: invite.code });
        server.entries = [entry];
        return json(200, { entry, invite, emailSent: true });
      },
    });
    await screen.findByRole('table', { name: 'Waitlist' });

    await app.user.click(screen.getByRole('button', { name: 'Invite wait@example.com' }));

    const result = await screen.findByRole('region', { name: 'Invite created' });
    expect(within(result).getByText('Invite for wait@example.com')).toBeVisible();
    expect(within(result).getByText('ZXCVBNM234')).toBeVisible();
    expect(within(result).getByText('http://localhost:5173/join?code=ZXCVBNM234')).toBeVisible();
    expect(
      within(result).getByText('The invite was also emailed to wait@example.com.'),
    ).toBeVisible();
    const [request] = app.calls('POST /admin/waitlist/:id/invite');
    expect(request!.pathname).toBe('/api/v1/admin/waitlist/5/invite');
    expect(bodyOf(request!)).toEqual({});
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(await inRow(/wait@example\.com/).findByText('Invited')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Invite wait@example.com' })).toBeNull();
    expect(app.calls('GET /admin/waitlist')).toHaveLength(2);
  });

  it('explains that the address already has an account (409 account_exists)', async () => {
    const app = await open('/admin/waitlist', {
      'POST /admin/waitlist/:id/invite': () =>
        failure(409, 'CONFLICT', { reason: 'account_exists' }),
    });
    await screen.findByRole('table', { name: 'Waitlist' });

    await app.user.click(screen.getByRole('button', { name: 'Invite wait@example.com' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This address already has an account, so it cannot be invited.',
    );
    expect(screen.queryByRole('region', { name: 'Invite created' })).toBeNull();
  });
});

const LISTS = [
  {
    path: '/admin/feeds',
    route: 'GET /admin/feeds',
    table: 'Feeds',
    empty: 'No feeds match these filters.',
    first: makeFeed({ id: '1', title: 'First feed' }),
    second: makeFeed({ id: '2', title: 'Second feed' }),
    names: ['First feed', 'Second feed'],
  },
  {
    path: '/admin/users',
    route: 'GET /admin/users',
    table: 'Users',
    empty: 'No users match.',
    first: makeUser({ id: '0192f7a0-0000-7000-8000-0000000000c1', email: 'first@example.com' }),
    second: makeUser({ id: '0192f7a0-0000-7000-8000-0000000000c2', email: 'second@example.com' }),
    names: ['first@example.com', 'second@example.com'],
  },
  {
    path: '/admin/invites',
    route: 'GET /admin/invites',
    table: 'Invites',
    empty: 'No invites match.',
    first: makeInvite({ code: 'FIRSTCODE22' }),
    second: makeInvite({ code: 'SECONDCODE3' }),
    names: ['FIRSTCODE22', 'SECONDCODE3'],
  },
  {
    path: '/admin/waitlist',
    route: 'GET /admin/waitlist',
    table: 'Waitlist',
    empty: 'Nobody is on the waitlist.',
    first: makeWaitlistEntry({ id: '1', email: 'first@example.com' }),
    second: makeWaitlistEntry({ id: '2', email: 'second@example.com' }),
    names: ['first@example.com', 'second@example.com'],
  },
] as const;

describe.each(LISTS)('the $table list', ({ path, route, table, empty, first, second, names }) => {
  it('pages through the rows with Load more, by cursor', async () => {
    const cursors: (string | null)[] = [];
    const app = await open(path, {
      [route]: (request) => {
        const cursor = request.query.get('cursor');
        cursors.push(cursor);
        return json(200, cursor === 'c2' ? page([second]) : page([first], 'c2'));
      },
    });
    await screen.findByRole('table', { name: table });
    expect(screen.getByText(names[0])).toBeVisible();
    expect(screen.queryByText(names[1])).toBeNull();

    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText(names[1])).toBeVisible();
    expect(screen.getByText(names[0])).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(cursors).toEqual([null, 'c2']);
  });

  it('says when it is empty', async () => {
    await open(path, { [route]: () => json(200, page([])) });

    expect(await screen.findByText(empty)).toBeVisible();
    expect(screen.queryByRole('table', { name: table })).toBeNull();
  });

  it('shows the error with a retry, and the rows once it works', async () => {
    let attempts = 0;
    const app = await open(path, {
      [route]: () => {
        attempts += 1;
        return attempts === 1 ? failure(500, 'INTERNAL') : json(200, page([first]));
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('table', { name: table })).toBeVisible();
    expect(screen.getByText(names[0])).toBeVisible();
  });

  it('shows the offline state while there is no connection and nothing has loaded', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await open(path, { [route]: () => new Promise<Response>(() => {}) });

    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

describe.each([
  ['/admin', 'GET /admin/overview', 'Reprocess translations'],
  ['/admin/usage', 'GET /admin/usage', 'Period'],
])('the %s screen', (path, route, shown) => {
  it('shows the error with a retry, and the screen once it works', async () => {
    let attempts = 0;
    const app = await open(path, {
      [route]: () => {
        attempts += 1;
        return attempts === 1
          ? failure(500, 'INTERNAL')
          : route === 'GET /admin/overview'
            ? json(200, makeOverview())
            : json(200, makeUsage());
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(shown)).toBeVisible();
  });
});
