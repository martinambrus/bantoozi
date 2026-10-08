import { CARD_LIMITS } from '@bantoozi/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  cardResult,
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

const LABELS = {
  name: 'Name (optional)',
  interest: 'I want to read about…',
  notFor: '…but not about',
  scope: 'Applies to',
};

async function openCreate(fixtures: Fixtures = {}, routes: Record<string, ApiRouteHandler> = {}) {
  const app = await open({
    path: '/interests',
    server: interestsServer({ subscriptions: FEEDS, ...fixtures }, routes),
  });
  await app.user.click(await screen.findByRole('button', { name: 'New interest card' }));
  const dialog = screen.getByRole('dialog', { name: 'New interest card' });
  return { app, dialog, form: within(dialog) };
}

async function openEdit(card = makeCard(), routes: Record<string, ApiRouteHandler> = {}) {
  const app = await open({
    path: '/interests',
    server: interestsServer({ subscriptions: FEEDS, cards: [card] }, routes),
  });
  const row = await screen.findByRole('listitem', { name: card.title });
  await app.user.click(within(row).getByRole('button', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit interest card' });
  return { app, dialog, form: within(dialog) };
}

function hintStates(dialog: HTMLElement): boolean[] {
  const list = within(dialog).getByRole('list', { name: 'Writing a good card' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).queryByText('Check this') !== null);
}

describe('character counters and limits', () => {
  it('counts every field against its limit from CARD_LIMITS', async () => {
    const { app, form } = await openCreate();
    const name = form.getByLabelText(LABELS.name);
    const interest = form.getByLabelText(LABELS.interest);
    const notFor = form.getByLabelText(LABELS.notFor);

    expect(name).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.titleMax}`);
    expect(interest).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.interestMax}`);
    expect(notFor).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.notForMax}`);

    await app.user.type(name, 'Rust');
    await app.user.type(interest, 'Rust language');
    await app.user.type(notFor, 'The game');

    expect(name).toHaveAccessibleDescription(`4 / ${CARD_LIMITS.titleMax}`);
    expect(interest).toHaveAccessibleDescription(`13 / ${CARD_LIMITS.interestMax}`);
    expect(notFor).toHaveAccessibleDescription(`8 / ${CARD_LIMITS.notForMax}`);
  });

  it('stops typing and pasting at the limit of each field', async () => {
    const { app, form } = await openCreate();
    const name = form.getByLabelText(LABELS.name);
    const interest = form.getByLabelText(LABELS.interest);
    const notFor = form.getByLabelText(LABELS.notFor);
    expect(name).toHaveAttribute('maxlength', String(CARD_LIMITS.titleMax));
    expect(interest).toHaveAttribute('maxlength', String(CARD_LIMITS.interestMax));
    expect(notFor).toHaveAttribute('maxlength', String(CARD_LIMITS.notForMax));

    await app.user.type(name, 'n'.repeat(CARD_LIMITS.titleMax + 20));
    await app.user.click(interest);
    await app.user.paste('i'.repeat(CARD_LIMITS.interestMax + 40));
    await app.user.click(notFor);
    await app.user.paste('o'.repeat(CARD_LIMITS.notForMax + 40));

    expect(name).toHaveValue('n'.repeat(CARD_LIMITS.titleMax));
    expect(interest).toHaveValue('i'.repeat(CARD_LIMITS.interestMax));
    expect(notFor).toHaveValue('o'.repeat(CARD_LIMITS.notForMax));
    expect(name).toHaveAccessibleDescription(`${CARD_LIMITS.titleMax} / ${CARD_LIMITS.titleMax}`);
  });

  it.each([
    ['name', LABELS.name, CARD_LIMITS.titleMax, true],
    ['interest', LABELS.interest, CARD_LIMITS.interestMax, false],
    ['but-not text', LABELS.notFor, CARD_LIMITS.notForMax, true],
  ])(
    'refuses to save a %s past its limit and sends nothing',
    async (_field, label, max, needsInterest) => {
      const { app, form } = await openCreate();
      if (needsInterest)
        await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');
      const field = form.getByLabelText(label);

      fireEvent.change(field, { target: { value: 'x'.repeat(max + 1) } });
      expect(field).toHaveAccessibleDescription(`${max + 1} / ${max}`);
      await app.user.click(form.getByRole('button', { name: 'Save' }));

      expect(app.calls('POST /cards')).toHaveLength(0);
      expect(field).toBeInvalid();
      expect(field).toHaveAccessibleDescription(
        `${max + 1} / ${max} Keep this to ${max} characters or fewer.`,
      );
      expect(field).toHaveFocus();
      expect(screen.getByRole('dialog', { name: 'New interest card' })).toBeVisible();
    },
  );

  it('asks for the description, and for at least the minimum of it, before saving', async () => {
    const { app, form } = await openCreate();
    const interest = form.getByLabelText(LABELS.interest);

    await app.user.click(form.getByRole('button', { name: 'Save' }));
    expect(interest).toBeInvalid();
    expect(interest).toHaveAccessibleDescription(
      `0 / ${CARD_LIMITS.interestMax} Describe what you want to read about.`,
    );

    await app.user.type(interest, '  ab  ');
    await app.user.click(form.getByRole('button', { name: 'Save' }));
    expect(interest).toHaveAccessibleDescription(
      `6 / ${CARD_LIMITS.interestMax} Describe it in at least ${CARD_LIMITS.interestMin} characters.`,
    );
    expect(app.calls('POST /cards')).toHaveLength(0);
  });
});

describe('authoring hints (spec 05 §8)', () => {
  it('lists all three hints, none highlighted before anything is typed', async () => {
    const { dialog } = await openCreate();

    const list = within(dialog).getByRole('list', { name: 'Writing a good card' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Describe one topic');
    expect(items[1]).toHaveTextContent('Avoid “not” in the main text; use the “but not” field');
    expect(items[2]).toHaveTextContent(
      'Leave out dates and number limits such as prices, lengths or ages; freshness is handled for you',
    );
    expect(hintStates(dialog)).toEqual([false, false, false]);
  });

  it.each([
    ['a negation', 'Hiking without crowds', [false, true, false]],
    ['the word "not"', 'Python, not Java', [true, true, false]],
    ['a Slovak negation', 'Turistika bez davov', [false, true, false]],
    ['the Slovak "nie"', 'Správy, nie politika', [true, true, false]],
    ['a digit', 'Budget laptops 2026', [false, false, true]],
    ['two topics joined by "and"', 'Rust and security', [true, false, false]],
    ['two topics joined by "a"', 'Futbal a hokej', [true, false, false]],
    ['a comma-separated list', 'Hiking, climbing', [true, false, false]],
    ['everything at once', 'Rust and Go, not 2 of them', [true, true, true]],
    ['a word that only contains "not"', 'Notebooks and tablets for artists', [true, false, false]],
    ['plain single-topic text', 'Space launches', [false, false, false]],
  ])('highlights the matching hint for %s', async (_name, text, expected) => {
    const { app, form, dialog } = await openCreate();

    await app.user.type(form.getByLabelText(LABELS.interest), text);

    expect(hintStates(dialog)).toEqual(expected);
  });

  it('does not treat words that merely contain a negation as one', async () => {
    const { app, form, dialog } = await openCreate();

    await app.user.type(form.getByLabelText(LABELS.interest), 'Notebooks, nobel prizes');

    expect(hintStates(dialog)[1]).toBe(false);
  });

  it('ignores the "but not" field, where negations belong', async () => {
    const { app, form, dialog } = await openCreate();

    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');
    await app.user.type(form.getByLabelText(LABELS.notFor), 'Not astrology, no 2 films');

    expect(hintStates(dialog)).toEqual([false, false, false]);
  });

  it('clears a highlight when the text is fixed', async () => {
    const { app, form, dialog } = await openCreate();
    const interest = form.getByLabelText(LABELS.interest);

    await app.user.type(interest, 'Rust and Go');
    expect(hintStates(dialog)).toEqual([true, false, false]);
    await app.user.clear(interest);
    await app.user.type(interest, 'Rust');

    expect(hintStates(dialog)).toEqual([false, false, false]);
  });
});

describe('creating a card', () => {
  const created = makeCard({
    id: '301',
    title: 'Rust',
    titleOverride: 'Rust',
    interest: 'The Rust programming language',
    notFor: 'The video game',
    strength: 'love',
    scopeFeedId: '11',
  });

  it('posts the typed fields, the strength and the scope, then closes and lists the card', async () => {
    const { app, form } = await openCreate(
      {},
      { 'POST /cards': () => json(201, cardResult(created, null, 'english')) },
    );

    await app.user.type(form.getByLabelText(LABELS.name), 'Rust');
    await app.user.type(form.getByLabelText(LABELS.interest), '  The Rust programming language ');
    await app.user.type(form.getByLabelText(LABELS.notFor), 'The video game');
    await app.user.click(form.getByRole('radio', { name: 'Love' }));
    await app.user.selectOptions(form.getByLabelText(LABELS.scope), 'Hacker News');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('POST /cards')).toHaveLength(1));
    const request = app.calls('POST /cards')[0]!;
    expect(bodyOf(request)).toEqual({
      title: 'Rust',
      interest: 'The Rust programming language',
      notFor: 'The video game',
      strength: 'love',
      scopeFeedId: '11',
    });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('listitem', { name: 'Rust' })).toBeVisible();
  });

  it('sends only what was filled in, with the default strength Like and all feeds', async () => {
    const { app, form } = await openCreate(
      {},
      { 'POST /cards': () => json(201, cardResult(makeCard({ id: '302' }))) },
    );
    expect(form.getByRole('radio', { name: 'Like' })).toBeChecked();
    expect(form.getByLabelText(LABELS.scope)).toHaveValue('');

    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('POST /cards')).toHaveLength(1));
    expect(bodyOf(app.calls('POST /cards')[0]!)).toEqual({
      interest: 'Space launches',
      strength: 'like',
    });
  });

  it('offers the subscribed feeds by their own name first', async () => {
    const { form } = await openCreate();

    const scope = form.getByLabelText(LABELS.scope);
    await waitFor(() => expect(within(scope).getAllByRole('option')).toHaveLength(3));
    expect(
      within(scope)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All feeds', 'Hacker News', 'My blog']);
  });

  it('puts a 400 on the field it names and keeps everything typed', async () => {
    const { app, form } = await openCreate(
      {},
      {
        'POST /cards': () =>
          failure(400, 'VALIDATION_FAILED', { field: 'interest', reason: 'characters' }),
      },
    );
    await app.user.type(form.getByLabelText(LABELS.name), 'Rust');
    await app.user.type(form.getByLabelText(LABELS.interest), 'Rust language');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    const interest = form.getByLabelText(LABELS.interest);
    await waitFor(() => expect(interest).toBeInvalid());
    expect(interest).toHaveAccessibleDescription(
      `13 / ${CARD_LIMITS.interestMax} This text contains characters that can't be used.`,
    );
    expect(form.getByLabelText(LABELS.name)).not.toBeInvalid();
    expect(form.getByLabelText(LABELS.notFor)).not.toBeInvalid();
    expect(form.queryByRole('alert')).not.toBeInTheDocument();
    expect(interest).toHaveValue('Rust language');
    expect(form.getByLabelText(LABELS.name)).toHaveValue('Rust');
    expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it.each([
    ['title', LABELS.name, 'too_long', `Keep this to ${CARD_LIMITS.titleMax} characters or fewer.`],
    [
      'notFor',
      LABELS.notFor,
      'too_long',
      `Keep this to ${CARD_LIMITS.notForMax} characters or fewer.`,
    ],
    ['scopeFeedId', LABELS.scope, 'not_subscribed', "You're no longer subscribed to that feed."],
  ])('shows a 400 about %s under its own field', async (field, label, reason, message) => {
    const { app, form } = await openCreate(
      {},
      { 'POST /cards': () => failure(400, 'VALIDATION_FAILED', { field, reason }) },
    );
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    const target = form.getByLabelText(label);
    await waitFor(() => expect(target).toBeInvalid());
    expect(target).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(form.getByLabelText(LABELS.interest)).not.toBeInvalid();
  });

  it('reports a 400 about an unknown field for the whole form', async () => {
    const { app, form } = await openCreate(
      {},
      { 'POST /cards': () => failure(400, 'VALIDATION_FAILED', { field: 'lang', reason: 'x' }) },
    );
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      "Some of the information isn't valid. Check it and try again.",
    );
  });

  it('explains a full plan with what is used and the maximum', async () => {
    const { app, form } = await openCreate(
      {},
      {
        'POST /cards': () =>
          failure(409, 'QUOTA_EXCEEDED', { limit: 'maxCards', used: 50, max: 50 }),
      },
    );
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      "You've reached your plan's limit for interest cards: 50 of 50.",
    );
    expect(form.getByLabelText(LABELS.interest)).toHaveValue('Space launches');
  });

  it.each([
    [
      'already_held',
      'You already have a card with this text, with a different strength, scope or name. Find it in My interests to change it.',
    ],
    ['card_contention', 'This card changed while you were saving it. Try saving again.'],
  ])('explains the 409 %s', async (reason, message) => {
    const { app, form } = await openCreate(
      {},
      { 'POST /cards': () => failure(409, 'CONFLICT', { reason, cardId: '101' }) },
    );
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(message);
  });

  it('lets the person save again after a contention error', async () => {
    const answers: Array<() => Response> = [
      () => failure(409, 'CONFLICT', { reason: 'card_contention' }),
      () => json(201, cardResult(makeCard({ id: '303' }))),
    ];
    const { app, form } = await openCreate({}, { 'POST /cards': () => answers.shift()!() });
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');
    await app.user.click(form.getByRole('button', { name: 'Save' }));
    await form.findByRole('alert');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const keys = app.calls('POST /cards').map((request) => request.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('closes without a request on Cancel and on Escape', async () => {
    const { app, form } = await openCreate();
    await app.user.type(form.getByLabelText(LABELS.interest), 'Space launches');

    await app.user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await app.user.click(screen.getByRole('button', { name: 'New interest card' }));
    expect(screen.getByLabelText(LABELS.interest)).toHaveValue('');
    await app.user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('POST /cards')).toHaveLength(0);
  });
});

describe('editing a card', () => {
  const card = makeCard({
    id: '101',
    title: 'My Rust',
    titleOverride: 'My Rust',
    interest: 'The Rust programming language',
    notFor: 'The video game',
    strength: 'love',
    scopeFeedId: '11',
    examplesYes: ['Rust 1.80 released'],
    examplesNo: ['Rust (game) patch notes'],
  });
  const saved = (changes = {}) => json(200, cardResult({ ...card, ...changes }));

  it('opens with the card filled in and its examples shown for review', async () => {
    const { form } = await openEdit(card);

    expect(form.getByLabelText(LABELS.name)).toHaveValue('My Rust');
    expect(form.getByLabelText(LABELS.interest)).toHaveValue('The Rust programming language');
    expect(form.getByLabelText(LABELS.notFor)).toHaveValue('The video game');
    expect(form.getByRole('radio', { name: 'Love' })).toBeChecked();
    expect(form.getByLabelText(LABELS.scope)).toHaveValue('11');
    expect(form.getByText('Rust 1.80 released')).toBeVisible();
    expect(form.getByText('Rust (game) patch notes')).toBeVisible();
  });

  it('sends only the interest when only the interest changed', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () => saved({ interest: 'The Rust language and its ecosystem' }),
    });
    const interest = form.getByLabelText(LABELS.interest);

    await app.user.clear(interest);
    await app.user.type(interest, ' The Rust language and its ecosystem ');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    const request = app.calls('PATCH /cards/:id')[0]!;
    expect(request.pathname).toBe('/api/v1/cards/101');
    expect(bodyOf(request)).toEqual({ interest: 'The Rust language and its ecosystem' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
  });

  it('clears the name override, the but-not text and the scope with null', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () => saved({ titleOverride: null, notFor: null, scopeFeedId: null }),
    });

    await app.user.clear(form.getByLabelText(LABELS.name));
    await app.user.clear(form.getByLabelText(LABELS.notFor));
    await app.user.selectOptions(form.getByLabelText(LABELS.scope), 'All feeds');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /cards/:id')[0]!)).toEqual({
      title: null,
      notFor: null,
      scopeFeedId: null,
    });
  });

  it('changes the strength and the scope from the editor too', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () => saved({ strength: 'must', scopeFeedId: '12' }),
    });

    await app.user.click(form.getByRole('radio', { name: 'Must' }));
    await app.user.selectOptions(form.getByLabelText(LABELS.scope), 'My blog');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /cards/:id')[0]!)).toEqual({
      strength: 'must',
      scopeFeedId: '12',
    });
  });

  it('keeps the name of a card that has no override out of the request', async () => {
    const library = makeCard({ id: '102', title: 'EV battery tech', origin: 'library' });
    const { app, form } = await openEdit(library, {
      'PATCH /cards/:id': () => saved({ id: '102', notFor: 'Stock moves' }),
    });
    expect(form.getByLabelText(LABELS.name)).toHaveValue('EV battery tech');

    await app.user.type(form.getByLabelText(LABELS.notFor), ' Stock moves ');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /cards/:id')[0]!)).toEqual({ notFor: 'Stock moves' });
  });

  it('makes no request, and closes, when nothing changed', async () => {
    const { app, form } = await openEdit(card);

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('PATCH /cards/:id')).toHaveLength(0);
  });

  it('explains a 409 target_held: the new text already belongs to another holding', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () => failure(409, 'CONFLICT', { reason: 'target_held', cardId: '102' }),
    });
    await app.user.type(form.getByLabelText(LABELS.interest), ' news');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'You already have a card with this text, but with a different strength, scope or name. Edit that card instead, or make its settings match first.',
    );
  });

  it('explains a full set of private cards with what is used and the maximum', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxForks', used: 20, max: 20 }),
    });
    await app.user.type(form.getByLabelText(LABELS.interest), ' news');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      "You've reached your plan's limit for private cards: 20 of 20.",
    );
  });

  it('puts a 400 on its field when editing too', async () => {
    const { app, form } = await openEdit(card, {
      'PATCH /cards/:id': () =>
        failure(400, 'VALIDATION_FAILED', { field: 'interest', reason: 'too_long' }),
    });
    await app.user.type(form.getByLabelText(LABELS.interest), ' news');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toBeInvalid());
  });
});
