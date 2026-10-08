import type { CardDto } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { cardsKey } from '../../src/features/interests/queries.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, deferred, findToast } from '../article/harness.js';
import { cardResult, makeCard } from '../interests/support.js';
import { USER_A_ID } from '../session/fixtures.js';
import { HELD, checkUnhandled, makeExplain, renderDrawer } from './support.js';

checkUnhandled();

const EV = 'EV battery tech';
const NOT_THIS = 'Not really about this';
const EXACTLY = 'Yes, exactly this';

/** The private copy the server makes of card 31 when it learns from the article. */
const FORK = makeCard({
  id: '35',
  title: EV,
  strength: 'love',
  origin: 'fork',
  isPrivateFork: true,
  examplesNo: ['Solid-state batteries reach the pilot line'],
});

const forkOf31 = () => json(200, cardResult(FORK, { from: '31', to: '35' }));

function row(app: Awaited<ReturnType<typeof renderDrawer>>, title: string) {
  return within(app.panel.getByRole('listitem', { name: title }));
}

function cachedIds(app: Awaited<ReturnType<typeof renderDrawer>>) {
  return app.queryClient.getQueryData<CardDto[]>(cardsKey(USER_A_ID))?.map((card) => card.id);
}

describe('"Not really about this" and "Yes, exactly this"', () => {
  it('"Not really about this" sends the article and side no, swaps the cached id and confirms', async () => {
    const app = await renderDrawer({ routes: { 'POST /cards/:id/examples': forkOf31 } });
    expect(cachedIds(app)).toEqual(['31', '32', '33']);

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    expect(await findToast("Learned: this isn't EV battery tech")).toBeInTheDocument();
    const requests = app.calls('POST', '/cards/31/examples');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ articleId: '101', side: 'no' });
    expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(cachedIds(app)).toEqual(['35', '32', '33']);
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));
  });

  it('"Yes, exactly this" sends side yes and confirms', async () => {
    const sibling = makeCard({
      id: '36',
      title: 'Solar power',
      origin: 'fork',
      isPrivateFork: true,
    });
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () => json(200, cardResult(sibling, { from: '32', to: '36' })),
      },
    });

    await app.user.click(row(app, 'Solar power').getByRole('button', { name: EXACTLY }));

    expect(await findToast('Learned: this is Solar power')).toBeInTheDocument();
    const requests = app.calls('POST', '/cards/32/examples');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ articleId: '101', side: 'yes' });
    expect(cachedIds(app)).toEqual(['31', '36', '33']);
  });

  it('confirms with the name the answer gives the card, which is the one the person set', async () => {
    const renamed = makeCard({ ...FORK, title: 'My batteries' });
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () => json(200, cardResult(renamed, { from: '31', to: '35' })),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    expect(await findToast("Learned: this isn't My batteries")).toBeInTheDocument();
  });

  it('confirms an example the card already had, which changes no id', async () => {
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () =>
          json(200, cardResult(makeCard({ id: '31', title: EV }), null)),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: EXACTLY }));

    expect(await findToast('Learned: this is EV battery tech')).toBeInTheDocument();
    expect(cachedIds(app)).toEqual(['31', '32', '33']);
  });

  it('sends the next answer for the same interest to the card that took its place', async () => {
    const second = makeCard({ id: '36', title: EV, origin: 'fork', isPrivateFork: true });
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': (_request, params) =>
          params['id'] === '31'
            ? forkOf31()
            : json(200, cardResult(second, { from: '35', to: '36' })),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));
    await findToast("Learned: this isn't EV battery tech");
    await waitFor(() => expect(row(app, EV).getByRole('button', { name: EXACTLY })).toBeEnabled());
    await app.user.click(row(app, EV).getByRole('button', { name: EXACTLY }));

    await waitFor(() => expect(app.calls('POST', '/cards/35/examples')).toHaveLength(1));
    expect(bodyOf(app.calls('POST', '/cards/35/examples')[0]!)).toEqual({
      articleId: '101',
      side: 'yes',
    });
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(1);
    expect(cachedIds(app)).toEqual(['36', '32', '33']);
  });

  it('holds the buttons of the interests while the answer is awaited', async () => {
    const answer = deferred<Response>();
    const app = await renderDrawer({
      routes: { 'POST /cards/:id/examples': () => answer.promise },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    await waitFor(() =>
      expect(row(app, EV).getByRole('button', { name: NOT_THIS })).toBeDisabled(),
    );
    expect(row(app, EV).getByRole('button', { name: EXACTLY })).toBeDisabled();
    expect(row(app, 'Solar power').getByRole('button', { name: NOT_THIS })).toBeDisabled();
    answer.resolve(forkOf31());
    await findToast("Learned: this isn't EV battery tech");
    await waitFor(() => expect(row(app, EV).getByRole('button', { name: NOT_THIS })).toBeEnabled());
    expect(row(app, 'Solar power').getByRole('button', { name: EXACTLY })).toBeEnabled();
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(1);
  });
});

describe('when the answer is an error', () => {
  it('says the plan has no room for another private card, with the numbers', async () => {
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () =>
          failure(409, 'QUOTA_EXCEEDED', { limit: 'maxForks', used: 20, max: 20 }),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    expect(
      await findToast(
        "Teaching an interest needs a private copy of it, and you've reached your plan's limit of private cards: 20 of 20.",
      ),
    ).toHaveAttribute('data-tone', 'error');
    expect(cachedIds(app)).toEqual(['31', '32', '33']);
  });

  it('says another limit in the general words', async () => {
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () =>
          failure(409, 'QUOTA_EXCEEDED', { limit: 'maxCards', used: 50, max: 50 }),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    expect(
      await findToast("You've reached your plan's limit for interest cards: 50 of 50."),
    ).toBeInTheDocument();
  });

  it('says the interest is gone for a 404 and reloads the cards', async () => {
    const app = await renderDrawer({
      routes: { 'POST /cards/:id/examples': () => failure(404, 'NOT_FOUND') },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: EXACTLY }));

    expect(
      await findToast("This interest is gone, so it can't learn from this article."),
    ).toHaveAttribute('data-tone', 'error');
    await waitFor(() => expect(app.calls('GET', '/cards')).toHaveLength(2));
  });

  it.each([
    [429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.'],
    [500, 'INTERNAL', 'Something went wrong on our side. Try again.'],
  ])('says %s in the words of every other screen', async (status, code, message) => {
    const app = await renderDrawer({
      routes: { 'POST /cards/:id/examples': () => failure(status, code) },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));

    expect(await findToast(message)).toHaveAttribute('data-tone', 'error');
    expect(row(app, EV).getByRole('button', { name: NOT_THIS })).toBeEnabled();
  });

  it('sends the same answer again under the same key', async () => {
    let healthy = false;
    const app = await renderDrawer({
      routes: {
        'POST /cards/:id/examples': () => (healthy ? forkOf31() : failure(500, 'INTERNAL')),
      },
    });

    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));
    await findToast('Something went wrong on our side. Try again.');
    healthy = true;
    await app.user.click(row(app, EV).getByRole('button', { name: NOT_THIS }));
    await findToast("Learned: this isn't EV battery tech");

    const [first, again] = app.calls('POST', '/cards/31/examples');
    expect(again!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'));
  });
});

describe('the interest rows', () => {
  it('offers the buttons for every interest and the editor only for the ones the person holds', async () => {
    const app = await renderDrawer({ cards: [HELD[0]!] });

    expect(row(app, EV).getByRole('button', { name: 'Edit card' })).toBeInTheDocument();
    expect(row(app, 'Solar power').queryByRole('button', { name: 'Edit card' })).toBeNull();
    for (const title of [EV, 'Solar power']) {
      expect(row(app, title).getByRole('button', { name: NOT_THIS })).toBeInTheDocument();
      expect(row(app, title).getByRole('button', { name: EXACTLY })).toBeInTheDocument();
    }
  });

  it('opens the card editor with the card the person holds, and closes it again', async () => {
    const held = makeCard({ id: '31', title: EV, interest: 'Batteries of electric vehicles' });
    const app = await renderDrawer({ cards: [held, ...HELD.slice(1)] });

    await app.user.click(row(app, EV).getByRole('button', { name: 'Edit card' }));

    const editor = await screen.findByRole('dialog', { name: 'Edit interest card' });
    expect(within(editor).getByLabelText('I want to read about…')).toHaveValue(
      'Batteries of electric vehicles',
    );
    await app.user.click(within(editor).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Edit interest card' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Why this?' })).toBeInTheDocument();
    expect(app.onClose).not.toHaveBeenCalled();
  });

  it('says it has no interests to show for an article they have not judged', async () => {
    const app = await renderDrawer({ explain: makeExplain({ cards: [] }) });

    expect(
      app.panel.getByText('No interest card has judged this article yet.'),
    ).toBeInTheDocument();
    expect(app.panel.queryByRole('list', { name: 'Your interests' })).toBeNull();
  });

  it('shows the strength of each card in words', async () => {
    const app = await renderDrawer();

    expect(row(app, EV).getByText('Strength: Love')).toBeInTheDocument();
    expect(row(app, 'Solar power').getByText('Strength: Like')).toBeInTheDocument();
  });
});
