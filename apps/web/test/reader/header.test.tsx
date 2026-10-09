import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { MUTATION_ID, deferred, findToast, makeLabel, undoResponse } from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import {
  AS_OF,
  COUNTS,
  countsQueries,
  createReaderHarness,
  item,
  listQueries,
  page,
  rowOf,
  rowTitles,
} from './support.js';

const { open } = createReaderHarness();

const MARK_READ = 'POST /articles/mark-read';
const UNDO = 'POST /articles/undo';
const UPDATE_ME = 'PATCH /me';
const PROBE_AS_OF = '2026-05-31T10:05:00.000Z';

const headerOf = (title: string) => screen.findByRole('group', { name: title });

describe('the title and the count', () => {
  it.each([
    ['/read/for_you', 'For you', 'Unread: 3'],
    ['/read/maybe', 'Maybe', 'Unread: 4'],
    ['/read/everything', 'Everything else', 'Unread: 12'],
    ['/read/new', 'New', 'Unread: 5'],
    ['/read/bookmarks', 'Bookmarks', 'Saved: 2'],
    ['/read/hidden', 'Hidden', 'Hidden: 1'],
  ])('names %s and counts what is in it', async (path, title, count) => {
    await open({ path });

    const header = await headerOf(title);

    expect(await within(header).findByText(count)).toBeVisible();
  });

  it('counts the articles of a feed from the counts of the feed', async () => {
    const { app } = await open({
      path: '/read/feed/7',
      subscriptions: [makeSubscription({ feed: { id: '7', title: 'Verge' } })],
      routes: {
        'GET /articles/counts': (request) =>
          json(200, request.query.has('feedId') ? { ...COUNTS, total: 9 } : COUNTS),
      },
    });

    expect(await within(await headerOf('Verge')).findByText('Unread: 9')).toBeVisible();
    expect(countsQueries(app)).toEqual(
      expect.arrayContaining([{ minTier: '1' }, { feedId: '7', minTier: '1' }]),
    );
  });

  it('counts the lane of the feed that the reader chose', async () => {
    await open({
      path: '/read/folder/Tech%20News?lane=for_you',
      routes: {
        'GET /articles/counts': (request) =>
          json(200, request.query.has('folder') ? { ...COUNTS, total: 9, forYou: 2 } : COUNTS),
      },
    });

    expect(await within(await headerOf('Tech News')).findByText('Unread: 2')).toBeVisible();
  });

  it('counts the articles of a label at the tier of the reader', async () => {
    const { app } = await open({
      path: '/read/label/12',
      me: makeMe({ preferences: { defaultTier: 2 } }),
      labels: [makeLabel('12', 'Climate')],
      routes: {
        'GET /articles/counts': (request) =>
          json(200, request.query.has('labelId') ? { ...COUNTS, total: 6 } : COUNTS),
      },
    });

    expect(await within(await headerOf('Climate')).findByText('Unread: 6')).toBeVisible();
    expect(countsQueries(app)).toContainEqual({ labelId: '12', minTier: '2' });
  });
});

describe('the controls of the header', () => {
  it('has an accessible name on every control', async () => {
    await open({ path: '/read/for_you', items: [item(1)] });

    const header = await headerOf('For you');

    const controls = ['button', 'slider', 'radio', 'switch'].flatMap((role) =>
      within(header).getAllByRole(role),
    );
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const control of controls) expect(control).toHaveAccessibleName();
  });

  it.each([
    ['For you', '/read/for_you', true],
    ['Maybe', '/read/maybe', true],
    ['Everything else', '/read/everything', false],
    ['New', '/read/new', false],
    ['Bookmarks', '/read/bookmarks', false],
    ['Hidden', '/read/hidden', false],
    ['Verge', '/read/feed/7', true],
    ['Verge', '/read/feed/7?lane=maybe', true],
    ['Verge', '/read/feed/7?lane=everything', false],
    ['Verge', '/read/feed/7?lane=new', false],
  ])('%s at %s: tier slider is shown: %s', async (title, path, shown) => {
    await open({
      path,
      subscriptions: [makeSubscription({ feed: { id: '7', title: 'Verge' } })],
    });

    const header = await headerOf(title);

    expect(within(header).queryByRole('slider', { name: 'Minimum tier' }) !== null).toBe(shown);
  });
});

describe('the tier slider', () => {
  it('is labelled, runs from 1 to 5 and can take the focus', async () => {
    await open({ path: '/read/for_you', me: makeMe({ preferences: { defaultTier: 2 } }) });

    const slider = await screen.findByRole('slider', { name: 'Minimum tier' });

    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '5');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('2');
    expect(slider).toHaveAttribute('aria-valuetext', 'Tier 2 and above');
    slider.focus();
    expect(slider).toHaveFocus();
  });

  it('shows the new tier at once, saves it, and asks for the list and the counts again with it', async () => {
    const saved = deferred<Response>();
    const me = makeMe();
    const { app } = await open({
      path: '/read/for_you',
      me,
      items: [item(1)],
      routes: { [UPDATE_ME]: () => saved.promise },
    });
    const slider = await screen.findByRole('slider', { name: 'Minimum tier' });
    await screen.findByRole('article', { name: 'Article 1' });
    expect(slider).toHaveValue('1');

    fireEvent.change(slider, { target: { value: '4' } });

    expect(slider).toHaveValue('4');
    expect(slider).toHaveAttribute('aria-valuetext', 'Tier 4 and above');
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(bodyOf(app.calls(UPDATE_ME)[0]!)).toEqual({ preferences: { defaultTier: 4 } });
    expect(app.calls(UPDATE_ME)[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => {
      expect(listQueries(app).at(-1)).toEqual({
        lane: 'for_you',
        minTier: '4',
        sort: 'score',
        limit: '30',
      });
      expect(countsQueries(app).at(-1)).toEqual({ minTier: '4' });
    });

    saved.resolve(json(200, { ...me, preferences: { ...me.preferences, defaultTier: 4 } }));

    await waitFor(() => expect(app.calls('GET /subscriptions').length).toBeGreaterThanOrEqual(2));
    expect(slider).toHaveValue('4');
  });

  it('puts the slider back and says so when the tier could not be saved', async () => {
    const { app } = await open({
      path: '/read/for_you',
      routes: { [UPDATE_ME]: () => failure(400, 'VALIDATION_FAILED') },
    });
    const slider = await screen.findByRole('slider', { name: 'Minimum tier' });

    fireEvent.change(slider, { target: { value: '4' } });

    await findToast("Some of the information isn't valid. Check it and try again.");
    expect(slider).toHaveValue('1');
    await waitFor(() => expect(listQueries(app).at(-1)).toMatchObject({ minTier: '1' }));
  });

  it('sends one request at a time and the last value at the end when the slider keeps moving', async () => {
    const first = deferred<Response>();
    const me = makeMe();
    let calls = 0;
    const { app } = await open({
      path: '/read/for_you',
      me,
      routes: {
        [UPDATE_ME]: (request) => {
          calls += 1;
          if (calls === 1) return first.promise;
          const { preferences } = bodyOf(request) as { preferences: Record<string, unknown> };
          return json(200, { ...me, preferences: { ...me.preferences, ...preferences } });
        },
      },
    });
    const slider = await screen.findByRole('slider', { name: 'Minimum tier' });

    fireEvent.change(slider, { target: { value: '2' } });
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.change(slider, { target: { value: '5' } });
    expect(slider).toHaveValue('5');
    expect(app.calls(UPDATE_ME)).toHaveLength(1);

    first.resolve(json(200, { ...me, preferences: { ...me.preferences, defaultTier: 2 } }));

    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(2));
    expect(bodyOf(app.calls(UPDATE_ME)[1]!)).toEqual({ preferences: { defaultTier: 5 } });
    await waitFor(() => expect(slider).toHaveValue('5'));
  });

  it('puts the slider back to what the server holds when the request after a saved one fails', async () => {
    const first = deferred<Response>();
    const me = makeMe();
    let calls = 0;
    const { app } = await open({
      path: '/read/for_you',
      me,
      routes: {
        [UPDATE_ME]: () => {
          calls += 1;
          return calls === 1 ? first.promise : failure(400, 'VALIDATION_FAILED');
        },
      },
    });
    const slider = await screen.findByRole('slider', { name: 'Minimum tier' });

    fireEvent.change(slider, { target: { value: '2' } });
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    fireEvent.change(slider, { target: { value: '5' } });
    first.resolve(json(200, { ...me, preferences: { ...me.preferences, defaultTier: 2 } }));

    await findToast("Some of the information isn't valid. Check it and try again.");
    expect(app.calls(UPDATE_ME)).toHaveLength(2);
    expect(slider).toHaveValue('2');
    await waitFor(() => expect(listQueries(app).at(-1)).toMatchObject({ minTier: '2' }));
  });
});

describe('a setting that is still being saved', () => {
  it('does not bring the account back when the reader signed out meanwhile', async () => {
    const saved = deferred<Response>();
    const me = makeMe();
    const { app } = await open({
      path: '/read/for_you',
      me,
      routes: { [UPDATE_ME]: () => saved.promise, 'POST /auth/logout': () => noContent() },
    });
    fireEvent.change(await screen.findByRole('slider', { name: 'Minimum tier' }), {
      target: { value: '4' },
    });
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));

    await act(async () => {
      await app.session.logout();
    });
    saved.resolve(json(200, { ...me, preferences: { ...me.preferences, defaultTier: 4 } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(app.queryClient.getQueryData(meKey())).toBeNull();
  });
});

describe('the sort toggle', () => {
  it('saves the sort and asks for the list again with it', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1)] });
    const score = await screen.findByRole('radio', { name: 'Score' });
    expect(score).toBeChecked();

    await app.user.click(screen.getByRole('radio', { name: 'Date' }));

    expect(screen.getByRole('radio', { name: 'Date' })).toBeChecked();
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(bodyOf(app.calls(UPDATE_ME)[0]!)).toEqual({ preferences: { sort: 'date' } });
    await waitFor(() =>
      expect(listQueries(app).at(-1)).toEqual({
        lane: 'for_you',
        minTier: '1',
        sort: 'date',
        limit: '30',
      }),
    );
  });

  it('is only in the For you lane', async () => {
    await open({ path: '/read/maybe' });

    await screen.findByRole('slider', { name: 'Minimum tier' });
    expect(screen.queryByRole('radiogroup', { name: 'Sort by' })).toBeNull();
  });
});

describe('Simple mode', () => {
  it('hides the excerpts at once and saves the setting', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1)] });
    expect(await screen.findByText('Excerpt of article 1')).toBeVisible();
    const toggle = screen.getByRole('switch', { name: 'Simple mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await app.user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Excerpt of article 1')).toBeNull();
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(bodyOf(app.calls(UPDATE_ME)[0]!)).toEqual({ preferences: { simpleMode: true } });

    await app.user.click(toggle);

    expect(await screen.findByText('Excerpt of article 1')).toBeVisible();
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(2));
    expect(bodyOf(app.calls(UPDATE_ME)[1]!)).toEqual({ preferences: { simpleMode: false } });
  });

  it('is in every view', async () => {
    await open({ path: '/read/bookmarks' });

    expect(await screen.findByRole('switch', { name: 'Simple mode' })).toBeVisible();
  });
});

describe('a sort or a Simple mode that could not be saved', () => {
  it('puts the sort back and says so', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { [UPDATE_ME]: () => failure(400, 'VALIDATION_FAILED') },
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(screen.getByRole('radio', { name: 'Date' }));

    await findToast("Some of the information isn't valid. Check it and try again.");
    expect(screen.getByRole('radio', { name: 'Score' })).toBeChecked();
    await waitFor(() => expect(listQueries(app).at(-1)).toMatchObject({ sort: 'score' }));
  });

  it('puts Simple mode back and says so', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { [UPDATE_ME]: () => failure(400, 'VALIDATION_FAILED') },
    });
    expect(await screen.findByText('Excerpt of article 1')).toBeVisible();

    await app.user.click(screen.getByRole('switch', { name: 'Simple mode' }));

    await findToast("Some of the information isn't valid. Check it and try again.");
    expect(screen.getByRole('switch', { name: 'Simple mode' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(await screen.findByText('Excerpt of article 1')).toBeVisible();
  });
});

describe('Refresh', () => {
  it('starts the list again from page one and asks for the counts again', async () => {
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(3)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('article', { name: 'Article 3' });
    const counted = countsQueries(app).length;

    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(listQueries(app)).toHaveLength(3));
    expect(listQueries(app).map((query) => query['cursor'])).toEqual([undefined, 'c1', undefined]);
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2']));
    await waitFor(() => expect(countsQueries(app).length).toBe(counted + 1));
  });
});

describe('the More menu', () => {
  it('opens the hidden articles', async () => {
    const { app } = await open({ path: '/read/for_you' });

    await app.user.click(await screen.findByRole('button', { name: 'More' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Show hidden' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/hidden'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Hidden' })).toBeVisible();
  });
});

describe('Mark all read', () => {
  it.each([
    ['Bookmarks', '/read/bookmarks'],
    ['Hidden', '/read/hidden'],
  ])('is not offered in %s', async (title, path) => {
    await open({ path });

    const header = await headerOf(title);

    expect(within(header).getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(within(header).queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('is disabled when nothing is unread', async () => {
    await open({ path: '/read/for_you', counts: { forYou: 0 } });

    const button = await screen.findByRole('button', { name: 'Mark all read' });

    await waitFor(() => expect(button).toBeDisabled());
  });

  it('confirms with the count, then marks the lane read at the digest of the lane', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      list: (request) =>
        json(
          200,
          request.query.get('limit') === '1'
            ? page([item(1)], { asOf: PROBE_AS_OF, datasetVersion: 'd-lane' })
            : page([item(1), item(2), item(3)]),
        ),
      routes: { [MARK_READ]: () => json(200, { count: 3, mutationId: MUTATION_ID }) },
    });
    await screen.findByRole('article', { name: 'Article 3' });

    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));

    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read?' });
    expect(
      within(dialog).getByText('3 unread articles in “For you” will be marked as read.'),
    ).toBeVisible();
    expect(app.calls(MARK_READ)).toHaveLength(0);
    expect(listQueries(app)).toContainEqual({
      lane: 'for_you',
      minTier: '1',
      limit: '1',
    });
    expect(countsQueries(app)).toContainEqual({ minTier: '1', asOf: PROBE_AS_OF });

    await app.user.click(within(dialog).getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(app.calls(MARK_READ)).toHaveLength(1));
    const [request] = app.calls(MARK_READ);
    expect(bodyOf(request!)).toEqual({
      filter: { lane: 'for_you', minTier: 1, olderThan: PROBE_AS_OF },
      datasetVersion: 'd-lane',
    });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks the lane all of a feed with the counts the reader confirmed', async () => {
    const { app } = await open({
      path: '/read/feed/7',
      items: [item(1)],
      subscriptions: [makeSubscription({ feed: { id: '7', title: 'Verge' } })],
      routes: {
        'GET /articles/counts': (request) =>
          json(
            200,
            request.query.has('feedId')
              ? { ...COUNTS, total: 9, datasetVersion: 'd-feed' }
              : COUNTS,
          ),
        [MARK_READ]: () => json(200, { count: 9, mutationId: MUTATION_ID }),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await within(await headerOf('Verge')).findByText('Unread: 9');

    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));

    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read?' });
    expect(
      within(dialog).getByText('9 unread articles in “Verge” will be marked as read.'),
    ).toBeVisible();
    await app.user.click(within(dialog).getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(app.calls(MARK_READ)).toHaveLength(1));
    expect(bodyOf(app.calls(MARK_READ)[0]!)).toEqual({
      filter: { lane: 'all', feedId: '7', minTier: 1, olderThan: AS_OF },
      datasetVersion: 'd-feed',
    });
    expect(listQueries(app).some((query) => query['limit'] === '1')).toBe(false);
  });

  it.each([
    [
      'a folder',
      '/read/folder/Tech%20News',
      { lane: 'all', folder: 'Tech News', minTier: 1, olderThan: AS_OF },
    ],
    ['a label', '/read/label/12', { lane: 'all', labelId: '12', minTier: 1, olderThan: AS_OF }],
    [
      'the Everything else lane',
      '/read/everything',
      { lane: 'everything', minTier: 1, olderThan: PROBE_AS_OF },
    ],
    ['the New lane', '/read/new', { lane: 'new', minTier: 1, olderThan: PROBE_AS_OF }],
    [
      'the Maybe lane of a feed',
      '/read/feed/7?lane=maybe',
      { lane: 'maybe', feedId: '7', minTier: 1, olderThan: PROBE_AS_OF },
    ],
  ])('sends the scope of %s in the filter', async (_name, path, filter) => {
    const { app } = await open({
      path,
      items: [item(1)],
      list: (request) =>
        json(
          200,
          request.query.get('limit') === '1'
            ? page([], { asOf: PROBE_AS_OF, datasetVersion: 'd-lane' })
            : page([item(1)]),
        ),
      routes: { [MARK_READ]: () => json(200, { count: 1, mutationId: MUTATION_ID }) },
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    await waitFor(() => expect(app.calls(MARK_READ)).toHaveLength(1));
    const body = bodyOf(app.calls(MARK_READ)[0]!) as { filter: unknown; datasetVersion: string };
    expect(body.filter).toEqual(filter);
    expect(body.datasetVersion).toBe(filter.lane === 'all' ? 'd-counts' : 'd-lane');
  });

  it('does nothing when the reader cancels', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1)] });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls(MARK_READ)).toHaveLength(0);
  });

  it('says how many it marked, offers Undo, and undoes with the receipt', async () => {
    const undone = deferred<Response>();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      routes: {
        [MARK_READ]: () => json(200, { count: 3, mutationId: MUTATION_ID }),
        [UNDO]: () => undone.promise,
      },
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    const toast = await findToast('Marked 3 as read');
    expect(toast).toHaveAttribute('data-tone', 'success');
    await waitFor(() =>
      expect(listQueries(app).filter((q) => q['limit'] === '30')).toHaveLength(2),
    );
    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    expect(bodyOf(app.calls(UNDO)[0]!)).toEqual({ mutationId: MUTATION_ID });
    const listed = listQueries(app).length;
    const counted = countsQueries(app).length;
    undone.resolve(undoResponse(item(1), item(2), item(3)));

    await waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(counted));
    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(listed));
  });

  it('reloads the list and the counts after marking, and shows the lane as read', async () => {
    let marked = false;
    const { app } = await open({
      path: '/read/for_you',
      list: () => json(200, page(marked ? [] : [item(1), item(2)])),
      routes: {
        [MARK_READ]: () => {
          marked = true;
          return json(200, { count: 2, mutationId: MUTATION_ID });
        },
      },
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    expect(await screen.findByText("You're all caught up")).toBeVisible();
    expect(app.calls(MARK_READ)).toHaveLength(1);
  });

  it('shows as read only the loaded articles that had arrived by the instant it counted', async () => {
    const late = item(3, { firstSeenAt: '2026-05-31T10:07:00.000Z' });
    let rows = [item(1), item(2)];
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        json(
          200,
          request.query.get('limit') === '1'
            ? page([item(1)], { asOf: PROBE_AS_OF, datasetVersion: 'd-lane' })
            : page(rows),
        ),
      routes: {
        [MARK_READ]: () => {
          const read = { readAt: PROBE_AS_OF, stateVersion: '5' };
          rows = [late, item(1, read), item(2, read)];
          return json(200, { count: 2, mutationId: MUTATION_ID });
        },
      },
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read?' });

    // While the question is open, a poll brings an article that arrived after it counted.
    rows = [late, item(1), item(2)];
    await act(() => app.queryClient.refetchQueries({ type: 'active' }));
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Mark as read' }));

    await findToast('Marked 2 as read');
    await waitFor(() => expect(within(rowOf('Article 1')).getByText('Read')).toBeVisible());
    expect(within(rowOf('Article 2')).getByText('Read')).toBeVisible();
    expect(within(rowOf('Article 3')).getByText('Unread')).toBeVisible();
  });

  it('asks again with the new number when the list changed meanwhile', async () => {
    let attempts = 0;
    const { app, state } = await open({
      path: '/read/feed/7',
      items: [item(1)],
      subscriptions: [makeSubscription({ feed: { id: '7', title: 'Verge' } })],
      counts: { total: 9, datasetVersion: 'd-before' },
      routes: {
        [MARK_READ]: () => {
          attempts += 1;
          if (attempts > 1) return json(200, { count: 5, mutationId: MUTATION_ID });
          state.counts = { ...state.counts, total: 5, datasetVersion: 'd-after' };
          return failure(409, 'STALE_STATE', {
            reason: 'dataset_changed',
            datasetVersion: 'd-after',
          });
        },
      },
    });
    await within(await headerOf('Verge')).findByText('Unread: 9');
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read?' });
    expect(
      within(dialog).getByText('9 unread articles in “Verge” will be marked as read.'),
    ).toBeVisible();

    await app.user.click(within(dialog).getByRole('button', { name: 'Mark as read' }));

    expect(
      await within(screen.getByRole('dialog', { name: 'Mark all as read?' })).findByText(
        '5 unread articles in “Verge” will be marked as read.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'The list changed while you were deciding, so the number is up to date now.',
      ),
    ).toBeVisible();
    expect(app.calls(MARK_READ)).toHaveLength(1);

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    await findToast('Marked 5 as read');
    expect(app.calls(MARK_READ)).toHaveLength(2);
    expect(bodyOf(app.calls(MARK_READ)[0]!)).toMatchObject({ datasetVersion: 'd-before' });
    expect(bodyOf(app.calls(MARK_READ)[1]!)).toMatchObject({ datasetVersion: 'd-after' });
    expect(app.calls(MARK_READ)[1]!.headers.get('Idempotency-Key')).not.toBe(
      app.calls(MARK_READ)[0]!.headers.get('Idempotency-Key'),
    );
  });

  it('says so in a toast when marking failed, and closes the question', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { [MARK_READ]: () => failure(403, 'FORBIDDEN') },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    const toast = await findToast("You don't have permission to do that.");
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains when there are too many articles to mark at once', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: {
        [MARK_READ]: () =>
          failure(400, 'VALIDATION_FAILED', {
            reason: 'too_many_targets',
            max: 5000,
            total: 7000,
          }),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );

    await findToast(
      "That's more than 5000 articles at once. Raise the minimum tier or pick a smaller view, then try again.",
    );
  });
});
