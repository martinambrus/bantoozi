import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { cardResult, interestsServer, makeCard, makeOffer, type Offer } from './support.js';

const { open } = createHarness();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

const heldRust = makeCard({
  id: '101',
  title: 'Rust programming',
  interest: 'The Rust programming language: releases and libraries',
  origin: 'library',
  librarySlug: 'rust-lang',
  examplesYes: ['My own Rust example'],
});

const heldPython = makeCard({
  id: '102',
  title: 'Python programming',
  interest: 'The Python programming language: releases and libraries',
  origin: 'library',
  librarySlug: 'python-lang',
  examplesYes: ['My own Python example'],
});

const rustOffer = makeOffer({ hasPrivateCustomization: true });
const pythonOffer = makeOffer({
  currentCardId: '102',
  baseCardId: '102',
  newCardId: '152',
  librarySlug: 'python-lang',
  hasPrivateCustomization: true,
});

describe('the focus after the editor of a library update closes', () => {
  it('goes to the list of offers when the offer that opened the editor has left it', async () => {
    const updates: Offer[] = [rustOffer, pythonOffer];
    const app = await open({
      path: '/interests?tab=updates',
      server: interestsServer(
        { cards: [heldRust, heldPython], updates },
        {
          'PATCH /cards/:id': () => {
            updates.splice(0, updates.length, pythonOffer);
            return json(
              200,
              cardResult(makeCard({ ...heldRust, id: '201', interest: 'My own wording of Rust' }), {
                from: '101',
                to: '201',
              }),
            );
          },
        },
      ),
    });
    const offer = await screen.findByRole('listitem', { name: 'Rust programming' });
    await app.user.click(within(offer).getByRole('button', { name: 'Customize instead' }));
    const form = within(screen.getByRole('dialog', { name: 'Edit interest card' }));
    await app.user.clear(form.getByLabelText('I want to read about…'));
    await app.user.type(form.getByLabelText('I want to read about…'), 'My own wording of Rust');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Library updates' })).toHaveFocus(),
    );
    expect(screen.getByRole('listitem', { name: 'Python programming' })).toBeInTheDocument();
    expect(document.body).not.toHaveFocus();
  });
});
