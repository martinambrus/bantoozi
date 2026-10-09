import type { CardDto, LibraryCardDto } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  cardResult,
  gate,
  interestsServer,
  makeCard,
  makeLibraryCard,
  type Fixtures,
  type Suggestion,
} from './support.js';

const { open } = createHarness();

const battery = makeLibraryCard();
const rustLanguage = makeLibraryCard({
  id: '502',
  slug: 'rust-lang',
  title: 'Rust programming',
  interest: 'The Rust programming language',
  notFor: null,
  topicIds: ['technology.software_dev'],
  l1TopicId: 'technology',
});
const space = makeLibraryCard({
  id: '503',
  slug: 'space-launches',
  title: 'Space launches',
  interest: 'Rocket launches and spacecraft missions',
  notFor: 'Astrology',
  topicIds: [],
  l1TopicId: 'science',
});

const page =
  (items: LibraryCardDto[], nextCursor: string | null = null) =>
  () =>
    json(200, { items, nextCursor });

function openLibrary(
  routes: Record<string, ApiRouteHandler>,
  fixtures: Fixtures = {},
  options: { language?: 'en' | 'sk' } = {},
) {
  return open({
    path: '/interests?tab=library',
    ...options,
    server: interestsServer(fixtures, routes),
  });
}

const rowOf = (title: string) => screen.findByRole('listitem', { name: title });
const topicSelect = () => screen.getByLabelText('Topic');

describe('browsing by topic', () => {
  it('groups the cards under their topic, named in English', async () => {
    await openLibrary({ 'GET /library': page([rustLanguage, battery, space]) });

    expect(await screen.findByRole('heading', { name: 'Technology', level: 3 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Cars and transport', level: 3 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Science', level: 3 })).toBeVisible();
    const row = await rowOf('EV battery tech');
    expect(
      within(row).getByText('New battery chemistry and manufacturing for electric vehicles'),
    ).toBeVisible();
    expect(within(row).getByText('But not: Stock-price moves')).toBeVisible();
    expect(within(row).getByText('Electric vehicles')).toBeVisible();
  });

  it('puts consecutive cards of one topic under one heading', async () => {
    await openLibrary({
      'GET /library': page([
        makeLibraryCard({ id: '511', title: 'Batteries', l1TopicId: 'transport' }),
        makeLibraryCard({ id: '512', title: 'Charging', l1TopicId: 'transport' }),
        makeLibraryCard({ id: '513', title: 'Telescopes', l1TopicId: 'science', topicIds: [] }),
      ]),
    });

    await rowOf('Batteries');

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Cars and transport', 'Science']);
  });

  it('names the topics in the filter in English, grouped under their parent', async () => {
    await openLibrary({ 'GET /library': page([battery]) });
    await rowOf('EV battery tech');

    const select = topicSelect();

    expect(within(select).getByRole('option', { name: 'All topics' })).toBeInTheDocument();
    const technology = within(select).getByRole('group', { name: 'Technology' });
    expect(
      within(technology)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All of Technology', 'Software development']);
    const transport = within(select).getByRole('group', { name: 'Cars and transport' });
    expect(
      within(transport)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All of Cars and transport', 'Electric vehicles']);
  });

  it('names the groups, the filter and the controls in Slovak', async () => {
    await openLibrary(
      { 'GET /library': page([battery, space]) },
      { me: makeMe({ locale: 'sk' }) },
      { language: 'sk' },
    );

    expect(await screen.findByRole('heading', { name: 'Autá a doprava', level: 3 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Veda', level: 3 })).toBeVisible();
    const select = screen.getByLabelText('Téma');
    expect(within(select).getByRole('option', { name: 'Všetky témy' })).toBeInTheDocument();
    expect(within(select).getByRole('group', { name: 'Technológie' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Elektromobily' })).toBeInTheDocument();
    expect(within(await rowOf('EV battery tech')).getByText('Elektromobily')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hľadať' })).toBeVisible();
  });

  it('asks for the cards of the chosen topic', async () => {
    const app = await openLibrary({
      'GET /library': (request) =>
        json(200, {
          items:
            request.query.get('topic') === 'transport.ev' ? [battery] : [rustLanguage, battery],
          nextCursor: null,
        }),
    });
    await rowOf('Rust programming');
    expect(app.calls('GET /library')[0]!.query.get('topic')).toBeNull();
    expect(app.calls('GET /library')[0]!.query.get('q')).toBeNull();
    expect(app.calls('GET /library')[0]!.query.get('cursor')).toBeNull();

    await app.user.selectOptions(topicSelect(), 'Electric vehicles');

    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument(),
    );
    const last = app.calls('GET /library').at(-1)!;
    expect(last.query.get('topic')).toBe('transport.ev');
    expect(last.query.get('cursor')).toBeNull();
    expect(screen.getByRole('listitem', { name: 'EV battery tech' })).toBeVisible();
  });

  it('asks for a whole top-level topic too', async () => {
    const app = await openLibrary({ 'GET /library': page([rustLanguage]) });
    await rowOf('Rust programming');

    await app.user.selectOptions(topicSelect(), 'All of Technology');

    await waitFor(() =>
      expect(app.calls('GET /library').at(-1)!.query.get('topic')).toBe('technology'),
    );
  });
});

describe('searching', () => {
  it('sends the typed words when the search is submitted', async () => {
    const app = await openLibrary({
      'GET /library': (request) =>
        json(200, {
          items: request.query.get('q') === 'battery' ? [battery] : [rustLanguage, battery],
          nextCursor: null,
        }),
    });
    await rowOf('Rust programming');

    await app.user.type(screen.getByLabelText('Search the library'), '  battery {Enter}');

    await waitFor(() => expect(app.calls('GET /library').at(-1)!.query.get('q')).toBe('battery'));
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('listitem', { name: 'EV battery tech' })).toBeVisible();
  });

  it('searches within the chosen topic, and clears the search when emptied', async () => {
    const app = await openLibrary({ 'GET /library': page([battery]) });
    await rowOf('EV battery tech');
    await app.user.selectOptions(topicSelect(), 'Electric vehicles');

    await app.user.type(screen.getByLabelText('Search the library'), 'solid');
    await app.user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = app.calls('GET /library').at(-1)!;
      expect(last.query.get('q')).toBe('solid');
      expect(last.query.get('topic')).toBe('transport.ev');
    });

    await app.user.clear(screen.getByLabelText('Search the library'));
    await app.user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = app.calls('GET /library').at(-1)!;
      expect(last.query.get('q')).toBeNull();
      expect(last.query.get('topic')).toBe('transport.ev');
    });
  });

  it('limits the search text to what the API accepts', async () => {
    await openLibrary({ 'GET /library': page([battery]) });
    await rowOf('EV battery tech');

    expect(screen.getByLabelText('Search the library')).toHaveAttribute('maxlength', '200');
  });

  it('says so when nothing matches', async () => {
    await openLibrary({ 'GET /library': page([]) });

    expect(await screen.findByText('No cards found')).toBeVisible();
    expect(screen.getByText('Try another topic or other words.')).toBeVisible();
  });
});

describe('paging', () => {
  const second = makeLibraryCard({ id: '521', title: 'Hydrogen cars', l1TopicId: 'transport' });

  it('loads the next page with its cursor and keeps the filters', async () => {
    const app = await openLibrary({
      'GET /library': (request) => {
        const cursor = request.query.get('cursor');
        if (cursor === null) return json(200, { items: [battery], nextCursor: 'cursor-1' });
        return json(200, { items: [second], nextCursor: null });
      },
    });
    await rowOf('EV battery tech');
    await app.user.type(screen.getByLabelText('Search the library'), 'car{Enter}');
    await waitFor(() => expect(app.calls('GET /library').at(-1)!.query.get('q')).toBe('car'));

    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await rowOf('Hydrogen cars')).toBeVisible();
    const next = app.calls('GET /library').at(-1)!;
    expect(next.query.get('cursor')).toBe('cursor-1');
    expect(next.query.get('q')).toBe('car');
    expect(screen.getByRole('listitem', { name: 'EV battery tech' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  });

  it('starts again from the first page when the filter changes', async () => {
    const app = await openLibrary({
      'GET /library': (request) =>
        request.query.get('cursor') === null
          ? json(200, { items: [battery], nextCursor: 'cursor-1' })
          : json(200, { items: [second], nextCursor: null }),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));
    await rowOf('Hydrogen cars');

    await app.user.selectOptions(topicSelect(), 'Electric vehicles');

    await waitFor(() =>
      expect(app.calls('GET /library').at(-1)!.query.get('topic')).toBe('transport.ev'),
    );
    expect(app.calls('GET /library').at(-1)!.query.get('cursor')).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Hydrogen cars' })).not.toBeInTheDocument(),
    );
  });

  it('shows the error, with a retry, when the next page cannot be loaded', async () => {
    let broken = true;
    const app = await openLibrary({
      'GET /library': (request) => {
        if (request.query.get('cursor') === null) {
          return json(200, { items: [battery], nextCursor: 'cursor-1' });
        }
        return broken ? failure(500, 'INTERNAL') : json(200, { items: [second], nextCursor: null });
      },
    });
    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Something went wrong on our side. Try again.')).toBeVisible();
    expect(screen.getByRole('listitem', { name: 'EV battery tech' })).toBeVisible();
    broken = false;
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await rowOf('Hydrogen cars')).toBeVisible();
  });
});

describe('adding a card', () => {
  it('adds with the chosen strength, marks the card as held and lists it in My interests', async () => {
    const held: CardDto[] = [];
    const app = await openLibrary(
      {
        'GET /library': page([battery, rustLanguage]),
        'GET /cards': () => json(200, held),
        'POST /library/:id/adopt': () => {
          const card = makeCard({
            id: '601',
            title: 'EV battery tech',
            strength: 'love',
            origin: 'library',
            librarySlug: 'ev-batteries',
          });
          held.push(card);
          return json(200, cardResult(card));
        },
      },
      {},
    );
    const row = await rowOf('EV battery tech');
    expect(within(row).getByLabelText('Add as')).toHaveValue('like');

    await app.user.selectOptions(within(row).getByLabelText('Add as'), 'Love');
    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(app.calls('POST /library/:id/adopt')).toHaveLength(1));
    const request = app.calls('POST /library/:id/adopt')[0]!;
    expect(request.pathname).toBe('/api/v1/library/501/adopt');
    expect(bodyOf(request)).toEqual({ strength: 'love' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
    expect(await within(row).findByText('In your interests')).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(
      within(await rowOf('Rust programming')).getByRole('button', { name: 'Add' }),
    ).toBeEnabled();

    await app.user.click(screen.getByRole('link', { name: 'My interests' }));
    const mine = await rowOf('EV battery tech');
    expect(within(mine).getByRole('radio', { name: 'Love' })).toBeChecked();
  });

  it('keeps the strength as it was chosen while the card is being added', async () => {
    const answer = gate();
    const app = await openLibrary({
      'GET /library': page([battery]),
      'POST /library/:id/adopt': async () => {
        await answer.opened;
        return json(
          200,
          cardResult(
            makeCard({
              id: '601',
              title: 'EV battery tech',
              strength: 'love',
              origin: 'library',
              librarySlug: 'ev-batteries',
            }),
          ),
        );
      },
    });
    const row = await rowOf('EV battery tech');
    await app.user.selectOptions(within(row).getByLabelText('Add as'), 'Love');
    await app.user.click(within(row).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(app.calls('POST /library/:id/adopt')).toHaveLength(1));

    const strength = within(row).getByLabelText('Add as');
    expect(strength).toBeDisabled();
    await app.user.selectOptions(strength, 'Never');
    expect(strength).toHaveValue('love');
    answer.release();

    expect(await within(row).findByText('In your interests')).toBeVisible();
    expect(app.calls('POST /library/:id/adopt')).toHaveLength(1);
    expect(bodyOf(app.calls('POST /library/:id/adopt')[0]!)).toEqual({ strength: 'love' });
  });

  it('does not offer to add what the person already holds', async () => {
    await openLibrary({ 'GET /library': page([makeLibraryCard({ held: true })]) });

    const row = await rowOf('EV battery tech');

    expect(within(row).getByText('In your interests')).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(within(row).queryByLabelText('Add as')).not.toBeInTheDocument();
  });

  it('offers the four strengths, Like first chosen', async () => {
    await openLibrary({ 'GET /library': page([battery]) });

    const select = within(await rowOf('EV battery tech')).getByLabelText('Add as');

    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Must', 'Love', 'Like', 'Never']);
    expect(select).toHaveValue('like');
  });

  it('follows a card that has a newer version and adds the current one', async () => {
    let superseded = true;
    const current = makeLibraryCard({ id: '505', version: 2, held: true });
    const adopted = makeCard({ id: '605', title: 'EV battery tech', origin: 'library' });
    const app = await openLibrary({
      'GET /library': () =>
        json(200, { items: [superseded ? battery : current], nextCursor: null }),
      'POST /library/:id/adopt': (_request, params) => {
        if (params['id'] === '501') {
          return failure(409, 'CONFLICT', {
            reason: 'superseded',
            cardId: '501',
            currentCardId: '505',
          });
        }
        superseded = false;
        return json(200, cardResult(adopted));
      },
    });
    const row = await rowOf('EV battery tech');

    await app.user.selectOptions(within(row).getByLabelText('Add as'), 'Must');
    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(app.calls('POST /library/:id/adopt')).toHaveLength(2));
    const [first, again] = app.calls('POST /library/:id/adopt');
    expect(first!.pathname).toBe('/api/v1/library/501/adopt');
    expect(again!.pathname).toBe('/api/v1/library/505/adopt');
    expect(bodyOf(again!)).toEqual({ strength: 'must' });
    expect(again!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(again!.headers.get('Idempotency-Key')).not.toBe(first!.headers.get('Idempotency-Key'));
    expect(
      await within(await rowOf('EV battery tech')).findByText('In your interests'),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when the person already has the card', async () => {
    const app = await openLibrary({
      'GET /library': page([battery]),
      'POST /library/:id/adopt': () =>
        failure(409, 'CONFLICT', { reason: 'already_held', cardId: '501' }),
    });
    const row = await rowOf('EV battery tech');

    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent('You already have this card.');
    expect(await within(row).findByText('In your interests')).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('explains a full plan with what is used and the maximum', async () => {
    const app = await openLibrary({
      'GET /library': page([battery]),
      'POST /library/:id/adopt': () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxCards', used: 50, max: 50 }),
    });
    const row = await rowOf('EV battery tech');

    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent(
      "You've reached your plan's limit for interest cards: 50 of 50.",
    );
    expect(within(row).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('keeps the card addable and says why after any other error', async () => {
    const app = await openLibrary({
      'GET /library': page([battery]),
      'POST /library/:id/adopt': () => failure(500, 'INTERNAL'),
    });
    const row = await rowOf('EV battery tech');

    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(within(row).getByRole('button', { name: 'Add' })).toBeEnabled();
  });
});

describe('library states', () => {
  it('shows the error with a retry', async () => {
    let broken = true;
    const app = await openLibrary({
      'GET /library': () =>
        broken ? failure(500, 'INTERNAL') : json(200, { items: [battery], nextCursor: null }),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    broken = false;
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await rowOf('EV battery tech')).toBeVisible();
  });

  it('still lists the cards, without groups, when the topic names cannot be loaded', async () => {
    await openLibrary({
      'GET /library': page([battery, space]),
      'GET /topics': () => failure(500, 'INTERNAL'),
    });

    expect(await rowOf('EV battery tech')).toBeVisible();
    expect(screen.getByRole('listitem', { name: 'Space launches' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Topic')).not.toBeInTheDocument();
  });

  it('groups a card without a topic under Other', async () => {
    await openLibrary({
      'GET /library': page([
        makeLibraryCard({ id: '531', title: 'Odd one', l1TopicId: null, topicIds: [] }),
      ]),
    });

    await rowOf('Odd one');

    expect(screen.getByRole('heading', { name: 'Other', level: 3 })).toBeVisible();
  });

  it('shows that the library is loading', async () => {
    await openLibrary({
      'GET /library': () => new Promise<Response>(() => undefined),
    });

    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeVisible();
  });
});

describe('suggestions', () => {
  const suggestion = (card: LibraryCardDto, score = 0.8): Suggestion => ({ card, score });

  function openSuggestions(
    suggestions: Suggestion[],
    routes: Record<string, ApiRouteHandler> = {},
  ) {
    return open({
      path: '/interests?tab=suggestions',
      server: interestsServer({ suggestions }, routes),
    });
  }

  it('explains that there is nothing to suggest yet', async () => {
    await openSuggestions([]);

    expect(await screen.findByText('No suggestions right now')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse the library' })).toBeVisible();
  });

  it('lists the suggested cards with an Add and a Dismiss action', async () => {
    await openSuggestions([suggestion(battery), suggestion(space, 0.6)]);

    const row = await rowOf('EV battery tech');

    expect(
      within(row).getByText('New battery chemistry and manufacturing for electric vehicles'),
    ).toBeVisible();
    expect(within(row).getByLabelText('Add as')).toHaveValue('like');
    expect(within(row).getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(screen.getByRole('listitem', { name: 'Space launches' })).toBeVisible();
  });

  it('adds a suggestion with the chosen strength and removes it from the list', async () => {
    const app = await openSuggestions([suggestion(battery), suggestion(space)], {
      'POST /library/:id/adopt': () =>
        json(200, cardResult(makeCard({ id: '602', title: 'EV battery tech', origin: 'library' }))),
    });
    const row = await rowOf('EV battery tech');

    await app.user.selectOptions(within(row).getByLabelText('Add as'), 'Never');
    await app.user.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(app.calls('POST /library/:id/adopt')).toHaveLength(1));
    const request = app.calls('POST /library/:id/adopt')[0]!;
    expect(request.pathname).toBe('/api/v1/library/501/adopt');
    expect(bodyOf(request)).toEqual({ strength: 'never' });
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'EV battery tech' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('listitem', { name: 'Space launches' })).toBeVisible();
  });

  it('dismisses a suggestion with an empty body and removes it', async () => {
    const app = await openSuggestions([suggestion(battery), suggestion(space)], {
      'POST /cards/suggestions/:cardId/dismiss': () => noContent(),
    });
    const row = await rowOf('EV battery tech');

    await app.user.click(within(row).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(app.calls('POST /cards/suggestions/:cardId/dismiss')).toHaveLength(1),
    );
    const request = app.calls('POST /cards/suggestions/:cardId/dismiss')[0]!;
    expect(request.pathname).toBe('/api/v1/cards/suggestions/501/dismiss');
    expect(bodyOf(request)).toEqual({});
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'EV battery tech' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('listitem', { name: 'Space launches' })).toBeVisible();
  });

  it('keeps the suggestion and says why when adding or dismissing fails', async () => {
    const app = await openSuggestions([suggestion(battery)], {
      'POST /library/:id/adopt': () => failure(500, 'INTERNAL'),
      'POST /cards/suggestions/:cardId/dismiss': () =>
        failure(404, 'NOT_FOUND', { resource: 'suggestion' }),
    });
    const row = await rowOf('EV battery tech');

    await app.user.click(within(row).getByRole('button', { name: 'Add' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    await app.user.click(within(row).getByRole('button', { name: 'Dismiss' }));

    expect(await within(row).findByText("We couldn't find that.")).toBeVisible();
    expect(screen.getByRole('listitem', { name: 'EV battery tech' })).toBeVisible();
  });
});
