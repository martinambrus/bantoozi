import type { CardDto, PublicationRequestDto } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  makeOffer,
  makeRequest,
  type Fixtures,
  type Offer,
} from './support.js';

const { open } = createHarness();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

const rowOf = (title: string) => screen.findByRole('listitem', { name: title });

const heldRust = makeCard({
  id: '101',
  title: 'Rust programming',
  interest: 'The Rust programming language: releases and libraries',
  origin: 'library',
  librarySlug: 'rust-lang',
  strength: 'love',
  examplesYes: ['My own Rust example'],
});

const CARDS_KEY = accountKey(USER_A_ID, 'cards');
const keptKeys = () => Object.keys(window.localStorage).filter((key) => key.startsWith(USER_A_ID));

describe('library updates', () => {
  function openUpdates(
    fixtures: Fixtures = {},
    routes: Record<string, ApiRouteHandler> = {},
    path = '/interests?tab=updates',
  ) {
    return open({
      path,
      server: interestsServer(
        { cards: [heldRust], updates: [makeOffer()], ...fixtures },
        { 'POST /auth/logout': () => noContent(), ...routes },
      ),
    });
  }

  it('shows the old and the new text side by side, with the versions', async () => {
    await openUpdates();

    const offer = await rowOf('Rust programming');

    const field = within(offer).getByRole('group', { name: 'I want to read about…' });
    const current = within(field).getByRole('group', { name: 'Current version 1' });
    const incoming = within(field).getByRole('group', { name: 'New version 2' });
    expect(current).toHaveTextContent('The Rust programming language: releases and libraries');
    expect(incoming).toHaveTextContent(
      'The Rust programming language: releases, libraries, tooling and real-world use',
    );
    expect(
      current.compareDocumentPosition(incoming) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(offer).getByText('Version 2 available')).toBeVisible();
  });

  it('shows only the fields that changed, and what is new where a field was empty', async () => {
    await openUpdates({
      updates: [
        makeOffer({
          diff: {
            title: { from: 'Rust', to: 'Rust programming' },
            interest: null,
            notFor: { from: null, to: 'Rust the video game' },
            examplesYes: { added: ['Rust 1.80 released'], removed: ['Old release note'] },
            examplesNo: { added: [], removed: [] },
          },
        }),
      ],
    });

    const offer = await rowOf('Rust programming');

    const title = within(offer).getByRole('group', { name: 'Name' });
    expect(
      within(within(title).getByRole('group', { name: 'Current version 1' })).getByText('Rust'),
    ).toBeVisible();
    expect(
      within(within(title).getByRole('group', { name: 'New version 2' })).getByText(
        'Rust programming',
      ),
    ).toBeVisible();
    const notFor = within(offer).getByRole('group', { name: '…but not about' });
    expect(
      within(within(notFor).getByRole('group', { name: 'Current version 1' })).getByText('Nothing'),
    ).toBeVisible();
    expect(
      within(within(notFor).getByRole('group', { name: 'New version 2' })).getByText(
        'Rust the video game',
      ),
    ).toBeVisible();
    const examples = within(offer).getByRole('group', { name: 'More like this' });
    expect(
      within(within(examples).getByRole('list', { name: 'Removed' })).getByText('Old release note'),
    ).toBeVisible();
    expect(
      within(within(examples).getByRole('list', { name: 'Added' })).getByText('Rust 1.80 released'),
    ).toBeVisible();
    expect(
      within(offer).queryByRole('group', { name: 'I want to read about…' }),
    ).not.toBeInTheDocument();
    expect(within(offer).queryByRole('group', { name: 'Not like this' })).not.toBeInTheDocument();
  });

  it('says that a new version never changes anything by itself', async () => {
    await openUpdates();

    expect(
      await screen.findByText(
        'Updates are never applied by themselves. Your card stays as it is until you apply one.',
      ),
    ).toBeVisible();
    const offer = await rowOf('Rust programming');
    expect(within(offer).getByRole('button', { name: 'Apply this update' })).toBeEnabled();
    expect(
      within(offer).getByText(
        'Applying switches this card to the new version. Your strength, scope and name stay as they are.',
      ),
    ).toBeVisible();
  });

  it('names an offer by its library name when the card is not in the list', async () => {
    await openUpdates({ cards: [] });

    expect(await rowOf('rust-lang')).toBeVisible();
  });

  it('still lists the offers, without Customize, when the cards cannot be loaded', async () => {
    await openUpdates({}, { 'GET /cards': () => failure(500, 'INTERNAL') });

    const offer = await rowOf('rust-lang');

    expect(within(offer).getByRole('button', { name: 'Apply this update' })).toBeEnabled();
    expect(within(offer).getByRole('button', { name: 'Customize instead' })).toBeDisabled();
  });

  it('counts the open offers on the tab and drops the count when there are none', async () => {
    await openUpdates({
      updates: [
        makeOffer(),
        makeOffer({ currentCardId: '102', newCardId: '152', librarySlug: 'ev' }),
      ],
    });

    expect(await screen.findByRole('link', { name: /^Library updates\s*2$/ })).toBeVisible();
  });

  it('shows the empty state when there is nothing to update', async () => {
    await openUpdates({ updates: [] });

    expect(await screen.findByText('No library updates')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Library updates' })).toBeVisible();
  });

  describe('applying', () => {
    const applied = makeCard({
      id: '151',
      title: 'Rust programming',
      origin: 'library',
      interest: 'The Rust programming language: releases, libraries, tooling and real-world use',
      strength: 'love',
    });

    it('applies the update named by the offer, expecting the card the person holds', async () => {
      const updates: Offer[] = [makeOffer({ baseCardId: '90' })];
      const app = await openUpdates(
        { updates },
        {
          'POST /library/:id/updates/:newId/apply': () => {
            updates.splice(0);
            return json(200, cardResult(applied, { from: '101', to: '151' }));
          },
        },
      );
      const articles = accountKey(USER_A_ID, 'articles', 'list');
      app.queryClient.setQueryData(articles, { pages: [], pageParams: [] });
      const offer = await rowOf('Rust programming');

      await app.user.click(within(offer).getByRole('button', { name: 'Apply this update' }));

      await waitFor(() =>
        expect(app.calls('POST /library/:id/updates/:newId/apply')).toHaveLength(1),
      );
      const request = app.calls('POST /library/:id/updates/:newId/apply')[0]!;
      expect(request.pathname).toBe('/api/v1/library/90/updates/151/apply');
      expect(bodyOf(request)).toEqual({ expectedCurrentCardId: '101' });
      expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
      expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.map((card) => card.id)).toEqual([
        '151',
      ]);
      expect(app.queryClient.getQueryState(articles)?.isInvalidated).toBe(true);
    });

    it('opens no card editor while the update is being applied, which the answer would drop', async () => {
      const answer = gate();
      const updates: Offer[] = [makeOffer()];
      const app = await openUpdates(
        { updates },
        {
          'POST /library/:id/updates/:newId/apply': async () => {
            await answer.opened;
            updates.splice(0);
            return json(200, cardResult(applied, { from: '101', to: '151' }));
          },
        },
      );
      const offer = await rowOf('Rust programming');
      await app.user.click(within(offer).getByRole('button', { name: 'Apply this update' }));
      await waitFor(() =>
        expect(app.calls('POST /library/:id/updates/:newId/apply')).toHaveLength(1),
      );

      const customize = within(offer).getByRole('button', { name: 'Customize instead' });
      expect(customize).toBeDisabled();
      await app.user.click(customize);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      answer.release();

      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('keeps no current version while the update is being applied, which the answer replaces', async () => {
      const answer = gate();
      const updates: Offer[] = [makeOffer()];
      const app = await openUpdates(
        { updates },
        {
          'POST /library/:id/updates/:newId/apply': async () => {
            await answer.opened;
            updates.splice(0);
            return json(200, cardResult(applied, { from: '101', to: '151' }));
          },
        },
      );
      const offer = await rowOf('Rust programming');
      await app.user.click(within(offer).getByRole('button', { name: 'Apply this update' }));
      await waitFor(() =>
        expect(app.calls('POST /library/:id/updates/:newId/apply')).toHaveLength(1),
      );

      const keep = within(offer).getByRole('button', { name: 'Keep my current version' });
      expect(keep).toBeDisabled();
      await app.user.click(keep);
      expect(keptKeys()).toEqual([]);
      expect(screen.getByRole('listitem', { name: 'Rust programming' })).toBeVisible();
      answer.release();

      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(keptKeys()).toEqual([]);
      expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.map((card) => card.id)).toEqual([
        '151',
      ]);
    });

    it.each([
      [
        'private_holding',
        409,
        "This card has your own changes or examples, so the update can't replace it. Use Customize instead to review them.",
      ],
      [
        'holding_mismatch',
        409,
        'This card changed after the update was offered. The list has been refreshed.',
      ],
      [
        'target_held',
        409,
        'You already have the new version with other settings. Edit that card instead.',
      ],
    ])('explains the conflict %s', async (reason, status, message) => {
      const app = await openUpdates(
        {},
        { 'POST /library/:id/updates/:newId/apply': () => failure(status, 'CONFLICT', { reason }) },
      );
      const offer = await rowOf('Rust programming');

      await app.user.click(within(offer).getByRole('button', { name: 'Apply this update' }));

      expect(await within(offer).findByRole('alert')).toHaveTextContent(message);
      expect(within(offer).getByRole('button', { name: 'Apply this update' })).toBeEnabled();
      if (reason === 'holding_mismatch') {
        await waitFor(() => expect(app.calls('GET /library/updates').length).toBeGreaterThan(1));
        await waitFor(() => expect(app.calls('GET /cards').length).toBeGreaterThan(1));
      }
    });

    it('refreshes the list when the offer is gone', async () => {
      const updates: Offer[] = [makeOffer()];
      const app = await openUpdates(
        { updates },
        {
          'POST /library/:id/updates/:newId/apply': () => {
            updates.splice(0);
            return failure(404, 'NOT_FOUND', { resource: 'library update' });
          },
        },
      );

      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', { name: 'Apply this update' }),
      );

      expect(await screen.findByText('No library updates')).toBeVisible();
    });

    it('says why after any other error and lets the person try again', async () => {
      const app = await openUpdates(
        {},
        { 'POST /library/:id/updates/:newId/apply': () => failure(500, 'INTERNAL') },
      );
      const offer = await rowOf('Rust programming');

      await app.user.click(within(offer).getByRole('button', { name: 'Apply this update' }));

      expect(await within(offer).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(within(offer).getByRole('button', { name: 'Apply this update' })).toBeEnabled();
    });
  });

  describe('a card with changes of its own', () => {
    const privateOffer = makeOffer({ hasPrivateCustomization: true });

    it('cannot be replaced, and the page says why', async () => {
      const app = await openUpdates({ updates: [privateOffer] });
      const offer = await rowOf('Rust programming');

      const apply = within(offer).getByRole('button', { name: 'Apply this update' });

      expect(apply).toBeDisabled();
      expect(apply).toHaveAccessibleDescription(
        expect.stringContaining(
          "This card has your own changes or examples, so the update can't replace it.",
        ),
      );
      await app.user.click(apply);
      expect(app.calls('POST /library/:id/updates/:newId/apply')).toHaveLength(0);
      expect(within(offer).getByRole('button', { name: 'Customize instead' })).toBeEnabled();
      expect(within(offer).getByRole('button', { name: 'Keep my current version' })).toBeEnabled();
    });

    it('opens the card editor on the current card, with the proposed update to review', async () => {
      const app = await openUpdates({ updates: [privateOffer] });
      const offer = await rowOf('Rust programming');

      await app.user.click(within(offer).getByRole('button', { name: 'Customize instead' }));

      const dialog = screen.getByRole('dialog', { name: 'Edit interest card' });
      const form = within(dialog);
      expect(form.getByLabelText('I want to read about…')).toHaveValue(
        'The Rust programming language: releases and libraries',
      );
      expect(form.getByRole('radio', { name: 'Love' })).toBeChecked();
      expect(form.getByText('My own Rust example')).toBeVisible();
      const review = form.getByRole('group', { name: 'Proposed update from the library' });
      expect(review).toHaveTextContent('The Rust programming language: releases and libraries');
      expect(review).toHaveTextContent(
        'The Rust programming language: releases, libraries, tooling and real-world use',
      );
      expect(app.calls('POST /library/:id/updates/:newId/apply')).toHaveLength(0);
    });

    it('takes a change saved elsewhere into the fields not edited here, and sends only the edit', async () => {
      const app = await openUpdates(
        { updates: [privateOffer] },
        {
          'PATCH /cards/:id': () =>
            json(
              200,
              cardResult(
                makeCard({
                  ...heldRust,
                  id: '201',
                  interest: 'My own wording of Rust',
                  strength: 'like',
                }),
                { from: '101', to: '201' },
              ),
            ),
        },
      );
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', { name: 'Customize instead' }),
      );
      const form = within(screen.getByRole('dialog', { name: 'Edit interest card' }));
      await app.user.clear(form.getByLabelText('I want to read about…'));
      await app.user.type(form.getByLabelText('I want to read about…'), 'My own wording of Rust');

      // Another tab made the card a Like, and the cards of this tab are loaded again with it.
      act(() => {
        app.queryClient.setQueryData<CardDto[]>(CARDS_KEY, (cards) =>
          cards?.map((card) => (card.id === '101' ? { ...card, strength: 'like' } : card)),
        );
      });

      await waitFor(() => expect(form.getByRole('radio', { name: 'Like' })).toBeChecked());
      expect(form.getByLabelText('I want to read about…')).toHaveValue('My own wording of Rust');
      await app.user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(app.calls('PATCH /cards/:id')).toHaveLength(1));
      expect(app.calls('PATCH /cards/:id').map((request) => bodyOf(request))).toEqual([
        { interest: 'My own wording of Rust' },
      ]);
    });

    it('refreshes the offers after the customized card is saved', async () => {
      const app = await openUpdates(
        { updates: [privateOffer] },
        {
          'PATCH /cards/:id': () =>
            json(
              200,
              cardResult(makeCard({ ...heldRust, id: '201', interest: 'My own wording of Rust' }), {
                from: '101',
                to: '201',
              }),
            ),
        },
      );
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', { name: 'Customize instead' }),
      );
      const form = within(screen.getByRole('dialog', { name: 'Edit interest card' }));
      const before = app.calls('GET /library/updates').length;

      await app.user.clear(form.getByLabelText('I want to read about…'));
      await app.user.type(form.getByLabelText('I want to read about…'), 'My own wording of Rust');
      await app.user.click(form.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(app.calls('GET /library/updates').length).toBeGreaterThan(before));
      expect(app.queryClient.getQueryData<CardDto[]>(CARDS_KEY)?.map((card) => card.id)).toEqual([
        '201',
      ]);
    });
  });

  describe('keeping the current version', () => {
    it('hides the offer without any request to the server', async () => {
      const app = await openUpdates();
      const offer = await rowOf('Rust programming');

      await app.user.click(within(offer).getByRole('button', { name: 'Keep my current version' }));

      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
      expect(app.requests.filter((request) => request.method !== 'GET')).toEqual([]);
      expect(
        screen.getByText(
          'You chose to keep your current version of 1 card. It comes back only if the library publishes a newer version.',
        ),
      ).toBeVisible();
      expect(screen.getByRole('link', { name: 'Library updates' })).toBeVisible();
    });

    it('is stored under the account id, for that card and that version', async () => {
      const app = await openUpdates();

      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );

      await waitFor(() => expect(keptKeys()).toHaveLength(1));
      const [key] = keptKeys();
      expect(key!.startsWith(`${USER_A_ID}:`)).toBe(true);
      expect(key).toContain(':101:');
      expect(key!.endsWith(':2')).toBe(true);
    });

    it('survives going to another tab and back, and a fresh page load', async () => {
      const app = await openUpdates();
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );
      expect(await screen.findByText('No library updates')).toBeVisible();

      await app.user.click(screen.getByRole('link', { name: 'My interests' }));
      expect(await rowOf('Rust programming')).toBeVisible();
      await app.user.click(screen.getByRole('link', { name: 'Library updates' }));
      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();

      app.unmount();
      await openUpdates();
      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
    });

    it('hides the offer when another tab keeps it', async () => {
      await openUpdates();
      expect(await rowOf('Rust programming')).toBeVisible();
      const key = `${USER_A_ID}:interests:keep:101:2`;

      act(() => {
        window.localStorage.setItem(key, '1');
        window.dispatchEvent(
          new StorageEvent('storage', { key, newValue: '1', storageArea: window.localStorage }),
        );
      });

      expect(await screen.findByText('No library updates')).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
    });

    it('offers the card again when the library publishes a newer version', async () => {
      const app = await openUpdates();
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );
      await screen.findByText('No library updates');
      app.unmount();

      await openUpdates({ updates: [makeOffer({ newCardId: '161', toVersion: 3 })] });

      const offer = await rowOf('Rust programming');
      expect(within(offer).getByText('Version 3 available')).toBeVisible();
      expect(within(offer).getByRole('group', { name: /^New version 3$/ })).toBeVisible();
    });

    it('keeps another card of the same library entry apart', async () => {
      const app = await openUpdates({
        cards: [heldRust, makeCard({ id: '102', title: 'Rust at work', origin: 'fork' })],
        updates: [makeOffer(), makeOffer({ currentCardId: '102', newCardId: '152' })],
      });
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );

      expect(await screen.findByRole('listitem', { name: 'Rust at work' })).toBeVisible();
      expect(screen.queryByRole('listitem', { name: 'Rust programming' })).not.toBeInTheDocument();
    });

    it('is forgotten when the person signs out', async () => {
      const app = await openUpdates();
      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );
      await waitFor(() => expect(keptKeys()).toHaveLength(1));
      window.localStorage.setItem('someone-else:interests:keep:5:2', '1');
      window.localStorage.setItem('unrelated', 'value');

      await act(async () => {
        await app.session.logout();
      });

      expect(keptKeys()).toEqual([]);
      expect(window.localStorage.getItem('someone-else:interests:keep:5:2')).toBe('1');
      expect(window.localStorage.getItem('unrelated')).toBe('value');
    });

    it('still hides the offer for the session when the browser refuses to store it', async () => {
      const app = await openUpdates();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Access is denied.', 'SecurityError');
      });

      await app.user.click(
        within(await rowOf('Rust programming')).getByRole('button', {
          name: 'Keep my current version',
        }),
      );

      expect(await screen.findByText('No library updates')).toBeVisible();
      await act(async () => {
        await app.session.resetAccountState();
      });
    });

    it('shows every offer when the browser refuses to read what was kept', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Access is denied.', 'SecurityError');
      });

      await openUpdates();

      expect(await rowOf('Rust programming')).toBeVisible();
    });
  });
});

describe('publication requests', () => {
  function openRequests(
    requests: PublicationRequestDto[] = [makeRequest()],
    routes: Record<string, ApiRouteHandler> = {},
    fixtures: Fixtures = {},
  ) {
    return open({
      path: '/interests?tab=requests',
      server: interestsServer({ requests, ...fixtures }, routes),
    });
  }

  const RESPOND = 'POST /cards/publication-requests/:id/respond';
  const answered = (changes: Partial<PublicationRequestDto>) => () =>
    json(200, { request: makeRequest(changes) });

  it('shows the exact card that would be published', async () => {
    await openRequests([
      makeRequest({
        proposed: {
          slug: 'rust-programming',
          title: 'Rust programming',
          topicIds: ['technology.software_dev', 'technology'],
          i18n: {
            sk: {
              title: 'Programovanie v Ruste',
              interest: 'Programovací jazyk Rust',
              notFor: 'Videohra Rust',
            },
          },
        },
        card: {
          title: 'My Rust',
          interest: 'The Rust programming language: releases, libraries and tooling',
          notFor: 'Rust the video game',
          examplesYes: ['A public example'],
          examplesNo: [],
          textHash: 'abc123',
        },
      }),
    ]);

    const item = await rowOf('My Rust');

    expect(within(item).getByText('Rust programming')).toBeVisible();
    expect(
      within(item).getByText('The Rust programming language: releases, libraries and tooling'),
    ).toBeVisible();
    expect(within(item).getByText('Rust the video game')).toBeVisible();
    expect(within(item).getByText('A public example')).toBeVisible();
    expect(within(item).getByText('Programovanie v Ruste')).toBeVisible();
    expect(within(item).getByText('Programovací jazyk Rust')).toBeVisible();
    expect(within(item).getByText('Videohra Rust')).toBeVisible();
    expect(within(item).getByText('Software development')).toBeVisible();
    expect(within(item).getByText('Technology')).toBeVisible();
    expect(within(item).getByText('Waiting for your answer')).toBeVisible();
    expect(within(item).getByText('Title in Slovak')).toBeVisible();
  });

  it('explains reuse, public listing, versions, silence and the 30-day rule', async () => {
    await openRequests();

    const about = await screen.findByRole('region', { name: 'How publication works' });

    expect(about).toHaveTextContent('Reuse is not publication');
    expect(about).toHaveTextContent('does not list it in the public library');
    expect(about).toHaveTextContent('A public listing makes the card findable in the library');
    expect(about).toHaveTextContent('Approving covers only the version shown');
    expect(about).toHaveTextContent('it needs a new approval');
    expect(about).toHaveTextContent('Not responding is not approval');
    expect(about).toHaveTextContent(
      "An administrator may publish a card after at least 30 days in which you haven't used Bantoozi, unless you have declined.",
    );
    expect(about).toHaveTextContent('Coming back to Bantoozi starts that period again.');
  });

  it('shows the explanations when there are no requests too, and no countdown anywhere', async () => {
    await openRequests([]);

    expect(await screen.findByText('No publication requests')).toBeVisible();
    expect(screen.getByRole('region', { name: 'How publication works' })).toBeVisible();
    expect(
      screen.queryByText(/countdown|days left|days remaining|expires/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('2026-10-20')).not.toBeInTheDocument();
  });

  it('names the topics by their codes when their names cannot be loaded', async () => {
    await openRequests([makeRequest()], { 'GET /topics': () => failure(500, 'INTERNAL') });

    const item = await rowOf('Rust programming');

    expect(within(item).getByText('technology.software_dev')).toBeVisible();
  });

  it('shows no date or time left for a pending request', async () => {
    await openRequests([makeRequest({ expiresAt: '2026-10-20T10:00:00.000Z' })]);

    const item = await rowOf('Rust programming');

    expect(item).not.toHaveTextContent(/2026|Oct|expires|days/i);
  });

  it('approves the exact version shown', async () => {
    const app = await openRequests([makeRequest()], {
      [RESPOND]: answered({
        status: 'approved',
        version: '4',
        respondedAt: '2026-10-08T09:00:00.000Z',
      }),
    });
    const item = await rowOf('Rust programming');

    await app.user.click(within(item).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(app.calls(RESPOND)).toHaveLength(1));
    const request = app.calls(RESPOND)[0]!;
    expect(request.pathname).toBe('/api/v1/cards/publication-requests/7/respond');
    expect(bodyOf(request)).toEqual({ decision: 'approve', expectedVersion: '3' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
    expect(await within(item).findByText('Approved')).toBeVisible();
    expect(within(item).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it('declines the exact version shown, and then offers nothing more', async () => {
    const app = await openRequests([makeRequest()], {
      [RESPOND]: answered({
        status: 'rejected',
        version: '4',
        respondedAt: '2026-10-08T09:00:00.000Z',
      }),
    });
    const item = await rowOf('Rust programming');

    await app.user.click(within(item).getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(app.calls(RESPOND)).toHaveLength(1));
    expect(bodyOf(app.calls(RESPOND)[0]!)).toEqual({ decision: 'decline', expectedVersion: '3' });
    expect(await within(item).findByText('Declined')).toBeVisible();
    expect(within(item).queryByRole('button')).not.toBeInTheDocument();
  });

  it('can still decline a request that was approved earlier', async () => {
    const app = await openRequests([makeRequest({ status: 'approved', version: '4' })], {
      [RESPOND]: answered({ status: 'rejected', version: '5' }),
    });
    const item = await rowOf('Rust programming');
    expect(within(item).getByText('Approved')).toBeVisible();
    expect(within(item).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    await app.user.click(within(item).getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(app.calls(RESPOND)).toHaveLength(1));
    expect(bodyOf(app.calls(RESPOND)[0]!)).toEqual({ decision: 'decline', expectedVersion: '4' });
    expect(await within(item).findByText('Declined')).toBeVisible();
  });

  it.each([
    ['rejected', 'Declined'],
    ['expired', 'Expired'],
    ['promoted', 'Published'],
  ] as const)('shows a %s request as %s, with no way to answer it', async (status, label) => {
    await openRequests([makeRequest({ status })]);

    const item = await rowOf('Rust programming');

    expect(within(item).getByText(label)).toBeVisible();
    expect(within(item).queryByRole('button')).not.toBeInTheDocument();
  });

  it('refetches and shows the current state when the request changed in the meantime', async () => {
    const requests = [makeRequest()];
    const app = await openRequests(requests, {
      [RESPOND]: () => {
        requests[0] = makeRequest({ status: 'rejected', version: '5' });
        return failure(409, 'CONFLICT', { sqlState: 'BZ409' });
      },
    });
    const item = await rowOf('Rust programming');
    const before = app.calls('GET /cards/publication-requests').length;

    await app.user.click(within(item).getByRole('button', { name: 'Approve' }));

    const current = await screen.findByRole('listitem', { name: 'Rust programming' });
    expect(await within(current).findByRole('alert')).toHaveTextContent(
      'This request changed in the meantime. What you see now is its current state.',
    );
    await waitFor(() => expect(within(current).getByText('Declined')).toBeVisible());
    expect(within(current).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(app.calls('GET /cards/publication-requests').length).toBeGreaterThan(before);
  });

  it('answers a refreshed request with its new version', async () => {
    const requests = [makeRequest()];
    let first = true;
    const app = await openRequests(requests, {
      [RESPOND]: () => {
        if (first) {
          first = false;
          requests[0] = makeRequest({ version: '4' });
          return failure(409, 'CONFLICT', { sqlState: 'BZ409' });
        }
        return json(200, { request: makeRequest({ status: 'approved', version: '5' }) });
      },
    });
    await app.user.click(
      within(await rowOf('Rust programming')).getByRole('button', { name: 'Approve' }),
    );
    expect(await screen.findByText(/This request changed in the meantime/)).toBeVisible();

    await app.user.click(
      within(screen.getByRole('listitem', { name: 'Rust programming' })).getByRole('button', {
        name: 'Approve',
      }),
    );

    await waitFor(() => expect(app.calls(RESPOND)).toHaveLength(2));
    expect(bodyOf(app.calls(RESPOND)[1]!)).toEqual({ decision: 'approve', expectedVersion: '4' });
    expect(await screen.findByText('Approved')).toBeVisible();
  });

  it('says why after any other error and leaves the request unanswered', async () => {
    const app = await openRequests([makeRequest()], { [RESPOND]: () => failure(500, 'INTERNAL') });
    const item = await rowOf('Rust programming');

    await app.user.click(within(item).getByRole('button', { name: 'Approve' }));

    expect(await within(item).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(within(item).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(within(item).getByText('Waiting for your answer')).toBeVisible();
  });

  it('counts the requests waiting for an answer on the tab', async () => {
    await openRequests([
      makeRequest(),
      makeRequest({ id: '8', cardId: '102', status: 'approved' }),
      makeRequest({ id: '9', cardId: '103' }),
    ]);

    expect(await screen.findByRole('link', { name: /^Publication requests\s*2$/ })).toBeVisible();
  });

  it('shows the error with a retry', async () => {
    let broken = true;
    const app = await openRequests([makeRequest()], {
      'GET /cards/publication-requests': () =>
        broken ? failure(500, 'INTERNAL') : json(200, [makeRequest()]),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    broken = false;
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await rowOf('Rust programming')).toBeVisible();
  });
});
