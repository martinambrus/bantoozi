import type { CardDto } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { accountKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { USER_A_ID } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  cardResult,
  gate,
  interestsServer,
  makeCard,
  makeSubscription,
  type Fixtures,
} from './support.js';

const { open } = createHarness();

const FEEDS = [
  makeSubscription('11', 'Hacker News'),
  makeSubscription('12', 'Blog feed', { titleOverride: 'My blog' }),
];

const rust = makeCard({
  id: '101',
  title: 'Rust programming',
  interest: 'The Rust programming language',
  strength: 'like',
});

const garden = makeCard({
  id: '102',
  title: 'Gardening',
  interest: 'Vegetable gardening for small plots',
  notFor: 'Lawn mower reviews',
  strength: 'love',
  scopeFeedId: '12',
  examplesYes: ['How I grew tomatoes on a balcony'],
  examplesNo: ['Lawn care schedule'],
});

const CARDS_KEY = accountKey(USER_A_ID, 'cards');

function openMine(fixtures: Fixtures = {}, routes: Record<string, ApiRouteHandler> = {}) {
  return open({
    path: '/interests',
    server: interestsServer({ subscriptions: FEEDS, ...fixtures }, routes),
  });
}

const rowOf = (title: string) => screen.findByRole('listitem', { name: title });

describe('the sections of the page', () => {
  const currentSection = () =>
    screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);

  it('opens on My interests when the address names no section', async () => {
    await openMine({ cards: [rust] });

    expect(await rowOf('Rust programming')).toBeVisible();
    expect(currentSection()).toContain('My interests');
    expect(screen.getByRole('link', { name: 'Library' })).not.toHaveAttribute('aria-current');
  });

  it('opens on My interests when the address names a section that does not exist', async () => {
    await open({
      path: '/interests?tab=nonsense',
      server: interestsServer({ subscriptions: FEEDS, cards: [rust] }),
    });

    expect(await rowOf('Rust programming')).toBeVisible();
    expect(screen.getByRole('link', { name: 'My interests' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks only the open section as the current one', async () => {
    await open({ path: '/interests?tab=library', server: interestsServer() });

    expect(await screen.findByRole('heading', { name: 'Library', level: 2 })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'My interests' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Suggestions' })).not.toHaveAttribute('aria-current');
  });
});

describe('listing the cards', () => {
  it('shows each card with its text, strength and scope', async () => {
    await openMine({ cards: [rust, garden] });

    const gardening = await rowOf('Gardening');
    expect(within(gardening).getByText('Vegetable gardening for small plots')).toBeVisible();
    expect(within(gardening).getByText('But not: Lawn mower reviews')).toBeVisible();
    expect(within(gardening).getByRole('radiogroup', { name: 'Strength' })).toBeVisible();
    expect(within(gardening).getByRole('radio', { name: 'Love' })).toBeChecked();
    expect(within(gardening).getByLabelText('Applies to')).toHaveValue('12');

    const programming = await rowOf('Rust programming');
    expect(within(programming).getByRole('radio', { name: 'Like' })).toBeChecked();
    expect(within(programming).getByLabelText('Applies to')).toHaveValue('');
    expect(within(programming).queryByText(/^But not/)).not.toBeInTheDocument();
  });

  it('offers all feeds and each subscribed feed by its own name', async () => {
    await openMine({ cards: [rust] });

    const scope = within(await rowOf('Rust programming')).getByLabelText('Applies to');

    expect(
      within(scope)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All feeds', 'Hacker News', 'My blog']);
  });

  it('still lists the cards when the feeds cannot be loaded', async () => {
    await openMine({ cards: [garden] }, { 'GET /subscriptions': () => failure(500, 'INTERNAL') });

    const scope = within(await rowOf('Gardening')).getByLabelText('Applies to');

    expect(scope).toHaveValue('12');
    expect(within(scope).getByRole('option', { name: 'Another feed' })).toBeInTheDocument();
  });

  it('keeps showing the scope of a card whose feed is gone', async () => {
    await openMine({ cards: [makeCard({ id: '103', title: 'Old scope', scopeFeedId: '99' })] });

    const scope = within(await rowOf('Old scope')).getByLabelText('Applies to');

    expect(scope).toHaveValue('99');
    expect(within(scope).getByRole('option', { name: 'Another feed' })).toBeInTheDocument();
  });

  it('says where a card came from', async () => {
    await openMine({
      cards: [
        makeCard({ id: '104', title: 'Chess', origin: 'library' }),
        makeCard({ id: '105', title: 'My chess', origin: 'fork', isPrivateFork: true }),
        makeCard({ id: '106', title: 'Mine', origin: 'user' }),
      ],
    });

    expect(within(await rowOf('Chess')).getByText('From the library')).toBeVisible();
    expect(within(await rowOf('My chess')).getByText('Your own version')).toBeVisible();
    expect(within(await rowOf('Mine')).queryByText(/library|version/i)).not.toBeInTheDocument();
  });
});

describe('screen states', () => {
  it('shows that the cards are loading', async () => {
    const answer = gate();
    await openMine(
      { cards: [rust] },
      {
        'GET /cards': async () => {
          await answer.opened;
          return json(200, [rust]);
        },
      },
    );

    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeVisible();
    answer.release();
    expect(await rowOf('Rust programming')).toBeVisible();
  });

  it('points to the library when there are no cards yet', async () => {
    await openMine({ cards: [] });

    expect(await screen.findByText('No interest cards yet')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse the library' })).toHaveAttribute(
      'href',
      expect.stringContaining('tab=library'),
    );
  });

  it('shows the error with a retry that loads the cards', async () => {
    let broken = true;
    const app = await openMine(
      { cards: [rust] },
      { 'GET /cards': () => (broken ? failure(500, 'INTERNAL') : json(200, [rust])) },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    broken = false;
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await rowOf('Rust programming')).toBeVisible();
  });

  it('says it is offline when the server cannot be reached', async () => {
    await openMine(
      { cards: [rust] },
      {
        'GET /cards': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    );

    expect(await screen.findByText("You're offline")).toBeVisible();
  });
});

describe('changing the strength', () => {
  it('shows the new strength at once and sends only the strength', async () => {
    const answer = gate();
    const app = await openMine(
      { cards: [rust] },
      {
        'PATCH /cards/:id': async () => {
          await answer.opened;
          return json(200, cardResult({ ...rust, strength: 'must' }));
        },
      },
    );
    const row = await rowOf('Rust programming');

    await app.user.click(within(row).getByRole('radio', { name: 'Must' }));

    await waitFor(() => expect(within(row).getByRole('radio', { name: 'Must' })).toBeChecked());
    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    const request = app.calls('PATCH /cards/:id')[0]!;
    expect(request.pathname).toBe('/api/v1/cards/101');
    expect(bodyOf(request)).toEqual({ strength: 'must' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');

    answer.release();
    await waitFor(() =>
      expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.[0]?.strength).toBe('must'),
    );
    expect(within(row).getByRole('radio', { name: 'Must' })).toBeChecked();
  });

  it('offers all four strengths', async () => {
    await openMine({ cards: [rust] });

    const group = within(await rowOf('Rust programming')).getByRole('radiogroup', {
      name: 'Strength',
    });

    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Must', 'Love', 'Like', 'Never']);
  });

  it('puts the previous strength back and says why when saving fails', async () => {
    const answer = gate();
    const app = await openMine(
      { cards: [rust] },
      {
        'PATCH /cards/:id': async () => {
          await answer.opened;
          return failure(429, 'RATE_LIMITED');
        },
      },
    );
    const row = await rowOf('Rust programming');
    await app.user.click(within(row).getByRole('radio', { name: 'Never' }));
    await waitFor(() => expect(within(row).getByRole('radio', { name: 'Never' })).toBeChecked());

    answer.release();

    await waitFor(() => expect(within(row).getByRole('radio', { name: 'Like' })).toBeChecked());
    expect(
      await screen.findByText('Too many requests. Wait a moment and try again.'),
    ).toBeVisible();
  });

  it('restores only the control that failed, not what was changed after it', async () => {
    const strengthAnswer = gate();
    const scopeAnswer = gate();
    const app = await openMine(
      { cards: [rust] },
      {
        'PATCH /cards/:id': async (request) => {
          if ('strength' in (bodyOf(request) as object)) {
            await strengthAnswer.opened;
            return failure(500, 'INTERNAL');
          }
          await scopeAnswer.opened;
          return json(200, cardResult({ ...rust, scopeFeedId: '11' }));
        },
      },
    );
    const row = await rowOf('Rust programming');
    await app.user.click(within(row).getByRole('radio', { name: 'Never' }));
    await app.user.selectOptions(within(row).getByLabelText('Applies to'), 'Hacker News');
    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(2));
    await waitFor(() => expect(within(row).getByRole('radio', { name: 'Never' })).toBeChecked());
    await waitFor(() => expect(within(row).getByLabelText('Applies to')).toHaveValue('11'));

    strengthAnswer.release();

    await waitFor(() => expect(within(row).getByRole('radio', { name: 'Like' })).toBeChecked());
    expect(within(row).getByLabelText('Applies to')).toHaveValue('11');
    scopeAnswer.release();
    await waitFor(() =>
      expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.[0]?.scopeFeedId).toBe('11'),
    );
    expect(within(row).getByRole('radio', { name: 'Like' })).toBeChecked();
  });
});

describe('changing the scope', () => {
  it('moves a card to one feed and back to all feeds', async () => {
    const app = await openMine(
      { cards: [rust] },
      {
        'PATCH /cards/:id': (request) => {
          const { scopeFeedId } = bodyOf(request) as { scopeFeedId: string | null };
          return json(200, cardResult({ ...rust, scopeFeedId }));
        },
      },
    );
    const scope = within(await rowOf('Rust programming')).getByLabelText('Applies to');

    await app.user.selectOptions(scope, 'My blog');
    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    const first = app.calls('PATCH /cards/:id')[0]!;
    expect(first.pathname).toBe('/api/v1/cards/101');
    expect(bodyOf(first)).toEqual({ scopeFeedId: '12' });
    expect(first.headers.get('Idempotency-Key')).toMatch(UUID_V4);

    await app.user.selectOptions(scope, 'All feeds');
    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(2));
    expect(bodyOf(app.calls('PATCH /cards/:id')[1]!)).toEqual({ scopeFeedId: null });
    expect(scope).toHaveValue('');
  });

  it('puts the old scope back when saving fails', async () => {
    const app = await openMine(
      { cards: [garden] },
      {
        'PATCH /cards/:id': () =>
          failure(400, 'VALIDATION_FAILED', { field: 'scopeFeedId', reason: 'not_subscribed' }),
      },
    );
    const scope = within(await rowOf('Gardening')).getByLabelText('Applies to');

    await app.user.selectOptions(scope, 'Hacker News');

    await waitFor(() => expect(scope).toHaveValue('12'));
    expect(await screen.findByText("You're no longer subscribed to that feed.")).toBeVisible();
  });
});

describe('cards that get a new id', () => {
  const forked = makeCard({
    ...garden,
    id: '201',
    origin: 'fork',
    isPrivateFork: true,
    examplesYes: [],
  });
  const cardIds = (app: Awaited<ReturnType<typeof openMine>>) =>
    app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.map((card) => card.id);

  it('swaps the id in the list, keeps its place and refreshes what depends on cards', async () => {
    const app = await openMine(
      { cards: [rust, garden] },
      {
        'POST /cards/:id/examples/remove': () =>
          json(200, cardResult(forked, { from: '102', to: '201' })),
        'DELETE /cards/:id': () => noContent(),
      },
    );
    const articles = accountKey(USER_A_ID, 'articles', 'list', { lane: 'for_you' });
    app.queryClient.setQueryData(articles, { pages: [], pageParams: [] });
    const row = await rowOf('Gardening');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: How I grew tomatoes on a balcony' }),
    );

    await waitFor(() => expect(cardIds(app)).toEqual(['101', '201']));
    expect(app.queryClient.getQueryState(articles)?.isInvalidated).toBe(true);
    expect(
      app.queryClient.getQueryState(accountKey(USER_A_ID, 'subscriptions'))?.isInvalidated,
    ).toBe(false);
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Gardening' })).queryByText(
          'How I grew tomatoes on a balcony',
        ),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getAllByRole('listitem', { name: /^(Rust programming|Gardening)$/ }),
    ).toHaveLength(2);

    await app.user.click(
      within(screen.getByRole('listitem', { name: 'Gardening' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this card?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(app.calls('DELETE /cards/:id')).toHaveLength(1));
    expect(app.calls('DELETE /cards/:id')[0]!.pathname).toBe('/api/v1/cards/201');
  });

  it('shows one card when the change makes two cards the same', async () => {
    const merged = makeCard({ ...rust, examplesYes: ['A newer Rust release'] });
    const app = await openMine(
      { cards: [rust, garden] },
      {
        'POST /cards/:id/examples/remove': () =>
          json(200, cardResult(merged, { from: '102', to: '101' })),
      },
    );

    await app.user.click(
      within(await rowOf('Gardening')).getByRole('button', {
        name: 'Remove example: How I grew tomatoes on a balcony',
      }),
    );

    await waitFor(() => expect(cardIds(app)).toEqual(['101']));
    expect(screen.queryByRole('listitem', { name: 'Gardening' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: 'Rust programming' })).toHaveLength(1);
    expect(screen.getByText('A newer Rust release')).toBeVisible();
  });

  it('refreshes the article lists of this account after any card change, and only those', async () => {
    const app = await openMine(
      { cards: [rust, garden] },
      { 'PATCH /cards/:id': () => json(200, cardResult({ ...garden, strength: 'must' })) },
    );
    const own = accountKey(USER_A_ID, 'articles', 'list');
    const other = accountKey('someone-else', 'articles', 'list');
    app.queryClient.setQueryData(own, { pages: [], pageParams: [] });
    app.queryClient.setQueryData(other, { pages: [], pageParams: [] });

    await app.user.click(within(await rowOf('Gardening')).getByRole('radio', { name: 'Must' }));

    await waitFor(() => expect(app.queryClient.getQueryState(own)?.isInvalidated).toBe(true));
    expect(app.queryClient.getQueryState(other)?.isInvalidated).toBe(false);
    expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.map((card) => card.id)).toEqual([
      '101',
      '102',
    ]);
  });
});

describe('examples', () => {
  it('lists the examples of each side', async () => {
    await openMine({ cards: [garden] });

    const row = await rowOf('Gardening');

    const more = within(row).getByRole('list', { name: 'More like this' });
    expect(within(more).getByText('How I grew tomatoes on a balcony')).toBeVisible();
    const less = within(row).getByRole('list', { name: 'Not like this' });
    expect(within(less).getByText('Lawn care schedule')).toBeVisible();
  });

  it('shows no example lists for a card without examples', async () => {
    await openMine({ cards: [rust] });

    const row = await rowOf('Rust programming');

    expect(within(row).queryByRole('list', { name: 'More like this' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('list', { name: 'Not like this' })).not.toBeInTheDocument();
  });

  it('removes an example from either side by its text', async () => {
    const app = await openMine(
      { cards: [garden] },
      {
        'POST /cards/:id/examples/remove': (request) => {
          const { side } = bodyOf(request) as { side: 'yes' | 'no' };
          return json(
            200,
            cardResult({
              ...garden,
              examplesYes: side === 'yes' ? [] : garden.examplesYes,
              examplesNo: side === 'no' ? [] : garden.examplesNo,
            }),
          );
        },
      },
    );
    const row = await rowOf('Gardening');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: How I grew tomatoes on a balcony' }),
    );
    await waitFor(() => expect(app.calls('POST /cards/:id/examples/remove')).toHaveLength(1));
    const first = app.calls('POST /cards/:id/examples/remove')[0]!;
    expect(first.pathname).toBe('/api/v1/cards/102/examples/remove');
    expect(bodyOf(first)).toEqual({ side: 'yes', text: 'How I grew tomatoes on a balcony' });
    expect(first.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(within(row).queryByText('How I grew tomatoes on a balcony')).not.toBeInTheDocument(),
    );

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: Lawn care schedule' }),
    );
    await waitFor(() => expect(app.calls('POST /cards/:id/examples/remove')).toHaveLength(2));
    expect(bodyOf(app.calls('POST /cards/:id/examples/remove')[1]!)).toEqual({
      side: 'no',
      text: 'Lawn care schedule',
    });
    await waitFor(() =>
      expect(within(row).queryByText('Lawn care schedule')).not.toBeInTheDocument(),
    );
  });

  it('keeps the example and says why when removing it fails', async () => {
    const app = await openMine(
      { cards: [garden] },
      {
        'POST /cards/:id/examples/remove': () => failure(404, 'NOT_FOUND', { resource: 'example' }),
      },
    );
    const row = await rowOf('Gardening');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: Lawn care schedule' }),
    );

    expect(await screen.findByText("We couldn't find that.")).toBeVisible();
    expect(within(row).getByText('Lawn care schedule')).toBeVisible();
    expect(
      within(row).getByRole('button', { name: 'Remove example: Lawn care schedule' }),
    ).toBeEnabled();
  });
});

describe('deleting a card', () => {
  const deleteButton = (row: HTMLElement) => within(row).getByRole('button', { name: 'Delete' });

  it('asks first and sends nothing when cancelled', async () => {
    const app = await openMine({ cards: [rust] });

    await app.user.click(deleteButton(await rowOf('Rust programming')));
    const dialog = screen.getByRole('dialog', { name: 'Delete this card?' });
    expect(dialog).toHaveAccessibleDescription(
      '“Rust programming” will be removed from your interests. Articles are ranked without it from now on.',
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('DELETE /cards/:id')).toHaveLength(0);
    expect(screen.getByRole('listitem', { name: 'Rust programming' })).toBeVisible();
  });

  it('deletes the card once confirmed and drops it from the list', async () => {
    const app = await openMine(
      { cards: [rust, garden] },
      { 'DELETE /cards/:id': () => noContent() },
    );

    await app.user.click(deleteButton(await rowOf('Rust programming')));
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this card?' })).getByRole('button', {
        name: 'Delete',
      }),
    );

    await waitFor(() => expect(app.calls('DELETE /cards/:id')).toHaveLength(1));
    const request = app.calls('DELETE /cards/:id')[0]!;
    expect(request.pathname).toBe('/api/v1/cards/101');
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Gardening' })).toBeVisible();
  });

  it('shows the empty state after the last card is deleted', async () => {
    const app = await openMine({ cards: [rust] }, { 'DELETE /cards/:id': () => noContent() });

    await app.user.click(deleteButton(await rowOf('Rust programming')));
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this card?' })).getByRole('button', {
        name: 'Delete',
      }),
    );

    expect(await screen.findByText('No interest cards yet')).toBeVisible();
  });

  it('keeps the card, and says why inside the dialog, when deleting fails', async () => {
    const app = await openMine(
      { cards: [rust] },
      { 'DELETE /cards/:id': () => failure(500, 'INTERNAL') },
    );

    await app.user.click(deleteButton(await rowOf('Rust programming')));
    const dialog = screen.getByRole('dialog', { name: 'Delete this card?' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(screen.getByRole('listitem', { name: 'Rust programming' })).toBeVisible();
  });
});
