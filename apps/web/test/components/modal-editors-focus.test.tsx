import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { cardResult, interestsServer, makeCard, makeSubscription } from '../interests/support.js';
import { labelResult, labelsServer, makeLabel } from '../labels/support.js';

const { open } = createHarness();

const readLater = makeLabel();
const recipes = makeLabel({ id: '32', name: 'Recipes', definition: 'Cooking ideas' });
const rust = makeCard();
const garden = makeCard({
  id: '102',
  title: 'Gardening',
  interest: 'Vegetable gardening for small plots',
});

function openLabels(routes: Parameters<typeof labelsServer>[1] = {}) {
  return open({ path: '/labels', server: labelsServer([readLater, recipes], routes) });
}

function openCards(routes: Parameters<typeof interestsServer>[1] = {}) {
  return open({
    path: '/interests',
    server: interestsServer(
      { cards: [rust, garden], subscriptions: [makeSubscription('11', 'Hacker News')] },
      routes,
    ),
  });
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

describe('the focus after a label is edited or deleted', () => {
  const renewed = () =>
    json(
      200,
      labelResult({ ...readLater, id: '71', definition: 'Long reads' }, { from: '31', to: '71' }),
    );

  async function saveRenewed(app: Awaited<ReturnType<typeof openLabels>>) {
    const row = await screen.findByRole('listitem', { name: 'Read later' });
    await app.user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit label' });
    const definition = within(dialog).getByLabelText('Definition');
    await app.user.clear(definition);
    await app.user.type(definition, 'Long reads');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await closed();
  }

  it('goes to the list when the saved label gets a new id and its row is replaced', async () => {
    const app = await openLabels({ 'PATCH /labels/:id': renewed });

    await saveRenewed(app);

    expect(screen.getAllByRole('listitem', { name: 'Read later' })).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Your labels' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('goes back to the Edit button when the editor is cancelled', async () => {
    const app = await openLabels();
    const row = await screen.findByRole('listitem', { name: 'Recipes' });
    await app.user.click(within(row).getByRole('button', { name: 'Edit' }));

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Edit label' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    expect(
      within(screen.getByRole('listitem', { name: 'Recipes' })).getByRole('button', {
        name: 'Edit',
      }),
    ).toHaveFocus();
  });

  it('goes to the list when the label is deleted', async () => {
    const app = await openLabels({ 'DELETE /labels/:id': () => noContent() });
    const row = await screen.findByRole('listitem', { name: 'Read later' });
    await app.user.click(within(row).getByRole('button', { name: 'Delete' }));

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this label?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await closed();

    expect(screen.queryByRole('listitem', { name: 'Read later' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Your labels' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('goes to the main landmark when the last label is deleted and no list is left', async () => {
    const app = await open({
      path: '/labels',
      server: labelsServer([readLater], { 'DELETE /labels/:id': () => noContent() }),
    });
    const row = await screen.findByRole('listitem', { name: 'Read later' });
    await app.user.click(within(row).getByRole('button', { name: 'Delete' }));

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this label?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await closed();

    expect(screen.queryByRole('list', { name: 'Your labels' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });
});

describe('the focus after an interest card is edited or deleted', () => {
  const renewed = () =>
    json(
      200,
      cardResult(
        { ...rust, id: '151', interest: 'The Rust language and its ecosystem' },
        { from: '101', to: '151' },
      ),
    );

  it('goes to the list when the saved card gets a new id and its row is replaced', async () => {
    const app = await openCards({ 'PATCH /cards/:id': renewed });
    const row = await screen.findByRole('listitem', { name: 'Rust programming' });
    await app.user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit interest card' });
    const interest = within(dialog).getByLabelText('I want to read about…');
    await app.user.clear(interest);
    await app.user.type(interest, 'The Rust language and its ecosystem');

    await app.user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await closed();

    expect(screen.getAllByRole('listitem', { name: 'Rust programming' })).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Your interest cards' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('goes back to the Edit button when the editor is cancelled', async () => {
    const app = await openCards();
    const row = await screen.findByRole('listitem', { name: 'Gardening' });
    await app.user.click(within(row).getByRole('button', { name: 'Edit' }));

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Edit interest card' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    expect(
      within(screen.getByRole('listitem', { name: 'Gardening' })).getByRole('button', {
        name: 'Edit',
      }),
    ).toHaveFocus();
  });

  it('goes to the list when the card is deleted', async () => {
    const app = await openCards({ 'DELETE /cards/:id': () => noContent() });
    const row = await screen.findByRole('listitem', { name: 'Rust programming' });
    await app.user.click(within(row).getByRole('button', { name: 'Delete' }));

    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this card?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await closed();

    expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Your interest cards' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });
});
