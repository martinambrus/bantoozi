import type { AdminLibraryCard, LibraryCandidate } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, renderApp, type ApiRouteHandler } from '../support/app.js';
import {
  T1,
  T2,
  adminMe,
  adminRoutes,
  makeCandidate,
  makeLibraryCard,
  makeRequest,
  page,
  unhandledGuard,
} from './support.js';

const guard = unhandledGuard();

async function render(options: Parameters<typeof renderApp>[0]) {
  return guard(await renderApp(options));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

const article = (name: string) => screen.getByRole('article', { name });

const solar = makeLibraryCard({
  cardId: '301',
  slug: 'solar-power',
  version: 2,
  title: 'Solar power',
  publication: { requestId: '7', authorizationKind: 'creator_approval', promotedAt: T1 },
});
const birds = makeLibraryCard({
  cardId: '302',
  slug: 'garden-birds',
  version: 1,
  title: 'Garden birds',
  interest: 'Feeding and identifying garden birds',
  publication: { requestId: '8', authorizationKind: 'creator_inactive_30d', promotedAt: T2 },
});
/** An older version of the solar card: its slug moved to the newest version, which the server names. */
const solarBasics = makeLibraryCard({
  cardId: '300',
  slug: null,
  version: 1,
  latestVersion: 2,
  title: 'Solar basics',
});
const chess = makeLibraryCard({
  cardId: '303',
  slug: 'chess',
  version: 1,
  title: 'Chess',
  interest: 'Chess openings and endgames',
  notFor: null,
  publication: null,
});

const approvedJazz = makeCandidate({
  cardId: '502',
  title: 'Jazz',
  interest: 'Jazz history and new releases',
  request: makeRequest({
    id: '12',
    cardId: '502',
    cardTitle: 'Jazz',
    version: '4',
    payload: { slug: 'jazz-502', title: 'Jazz', titleSk: null, topicIds: ['music'] },
    promotionEligibility: { status: 'eligible', basis: 'creator_inactive_30d', reason: null },
  }),
  promotionEligibility: { status: 'eligible', basis: 'creator_inactive_30d', reason: null },
});
const hiking = makeCandidate({
  request: makeRequest({
    status: 'approved',
    respondedAt: T2,
    promotionEligibility: { status: 'eligible', basis: 'creator_approval', reason: null },
  }),
  promotionEligibility: { status: 'eligible', basis: 'creator_approval', reason: null },
});

function held(
  title: string,
  cardId: string,
  reason: NonNullable<LibraryCandidate['promotionEligibility']['reason']>,
  over: Partial<LibraryCandidate> = {},
  withRequest = true,
): LibraryCandidate {
  const eligibility = { status: 'held' as const, basis: null, reason };
  return makeCandidate({
    cardId,
    title,
    request: withRequest
      ? makeRequest({
          id: `9${cardId}`,
          cardId,
          cardTitle: title,
          promotionEligibility: eligibility,
        })
      : null,
    promotionEligibility: eligibility,
    ...over,
  });
}

const EVERY_STATE: [title: string, label: string, candidate: LibraryCandidate][] = [
  ['Hiking trails', 'Approved by creator', hiking],
  ['Jazz', 'Eligible after 30 days inactive', approvedJazz],
  ['Birdwatching', 'Awaiting approval', held('Birdwatching', '503', 'awaiting_approval')],
  ['Gardening', 'Declined', held('Gardening', '504', 'declined', { vetoed: true }, false)],
  [
    'Cooking',
    'Unknown creator',
    held('Cooking', '505', 'unknown_creator', { creatorKnown: false }, false),
  ],
  ['Sailing', 'No request yet', held('Sailing', '506', 'no_request', {}, false)],
  ['Pottery', 'Not enough holders', held('Pottery', '507', 'insufficient_holders', { holders: 2 })],
  ['Origami', 'Request expired', held('Origami', '508', 'expired')],
  ['Cycling', 'Card text changed', held('Cycling', '509', 'stale_payload')],
  [
    'Knitting',
    'Promoted',
    makeCandidate({
      cardId: '510',
      title: 'Knitting',
      request: makeRequest({
        id: '910',
        cardId: '510',
        cardTitle: 'Knitting',
        status: 'promoted',
        authorizationKind: 'creator_approval',
        promotedAt: T2,
        promotionEligibility: { status: 'promoted', basis: 'creator_approval', reason: null },
      }),
      promotionEligibility: { status: 'promoted', basis: 'creator_approval', reason: null },
    }),
  ],
];

interface LibraryServer {
  cards: AdminLibraryCard[];
  candidates: LibraryCandidate[];
}

async function openLibrary(server: LibraryServer, routes: Record<string, ApiRouteHandler> = {}) {
  const app = await render({
    path: '/admin/library',
    server: {
      me: adminMe(),
      routes: adminRoutes({
        'GET /admin/library': () => json(200, page(server.cards)),
        'GET /admin/library/candidates': () => json(200, { items: server.candidates }),
        ...routes,
      }),
    },
  });
  await screen.findByRole('heading', { level: 3, name: 'Library cards' });
  await screen.findByRole('heading', { level: 3, name: 'Promotion candidates' });
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull());
  return app;
}

describe('admin library (spec 09 §8)', () => {
  describe('publication record', () => {
    it('shows the actual basis and audit time of each published card', async () => {
      await openLibrary({ cards: [solar, birds, chess], candidates: [] });

      const approved = within(article('Solar power'));
      expect(approved.getByText('Approved by creator')).toBeVisible();
      expect(article('Solar power').querySelector(`time[datetime="${T1}"]`)).not.toBeNull();

      const inactive = within(article('Garden birds'));
      expect(inactive.getByText('Published after 30 days of creator inactivity')).toBeVisible();
      expect(inactive.queryByText('Approved by creator')).toBeNull();
      expect(article('Garden birds').querySelector(`time[datetime="${T2}"]`)).not.toBeNull();

      const original = within(article('Chess'));
      expect(original.getByText('Created in the library')).toBeVisible();
      expect(article('Chess').querySelector('time')).toBeNull();
    });

    it('shows the card text, version, holders and a retired card as retired', async () => {
      await openLibrary({
        cards: [solar, makeLibraryCard({ ...chess, retiredAt: T2 })],
        candidates: [],
      });

      const card = within(article('Solar power'));
      expect(card.getByText('Rooftop solar panels and home batteries')).toBeVisible();
      expect(card.getByText('Stock tips')).toBeVisible();
      expect(card.getByText('solar-power')).toBeVisible();
      expect(card.getByText('Version 2')).toBeVisible();
      expect(card.getByText('12 holders')).toBeVisible();
      expect(within(article('Chess')).getByText('Retired')).toBeVisible();
      expect(card.queryByText('Retired')).toBeNull();
    });

    it('marks an older version as superseded and does not offer to edit it', async () => {
      await openLibrary({ cards: [solarBasics, solar], candidates: [] });

      expect(within(article('Solar basics')).getByText('Superseded by version 2')).toBeVisible();
      expect(
        within(article('Solar basics')).getByRole('button', { name: 'Edit Solar basics' }),
      ).toBeDisabled();
      expect(
        within(article('Solar power')).getByRole('button', { name: 'Edit Solar power' }),
      ).toBeEnabled();
      expect(within(article('Solar power')).queryByText(/Superseded/)).toBeNull();
    });

    it('marks an older version by the newest version the server names, before that one is loaded', async () => {
      await openLibrary(
        { cards: [], candidates: [] },
        {
          'GET /admin/library': (request) =>
            json(
              200,
              request.query.get('cursor') === 'next' ? page([solar]) : page([solarBasics], 'next'),
            ),
        },
      );

      expect(screen.queryByText('Solar power')).toBeNull();
      expect(within(article('Solar basics')).getByText('Superseded by version 2')).toBeVisible();
      expect(
        within(article('Solar basics')).getByRole('button', { name: 'Edit Solar basics' }),
      ).toBeDisabled();
    });
  });

  describe('promotion candidates', () => {
    it.each(EVERY_STATE)('labels %s as "%s"', async (title, label, candidate) => {
      await openLibrary({ cards: [chess], candidates: [candidate] });

      expect(within(article(title)).getByText(label)).toBeVisible();
    });

    it('explains inactivity as the administrator’s own decision, never as approval', async () => {
      await openLibrary({ cards: [chess], candidates: [approvedJazz, hiking] });

      const inactive = within(article('Jazz'));
      expect(inactive.getByText(/has not answered this request/)).toBeVisible();
      expect(inactive.queryByText('Approved by creator')).toBeNull();
      expect(
        within(article('Hiking trails')).getByText(/approved this exact listing/),
      ).toBeVisible();
    });

    it('shows the exact proposed listing, the card text and the holders', async () => {
      await openLibrary({ cards: [chess], candidates: [hiking] });

      const candidate = within(article('Hiking trails'));
      expect(candidate.getByText('5 holders')).toBeVisible();
      expect(candidate.getByText('Day hikes and mountain trails')).toBeVisible();
      expect(candidate.getByText('Extreme sports')).toBeVisible();
      expect(candidate.getByText('hiking-trails-501')).toBeVisible();
      expect(candidate.getByText('Turistické chodníky')).toBeVisible();
      expect(candidate.getByText('outdoors')).toBeVisible();
      expect(candidate.getByText('Proposed listing')).toBeVisible();
    });

    it('offers Promote only for an eligible candidate and a new request only where one is needed', async () => {
      await openLibrary({
        cards: [chess],
        candidates: EVERY_STATE.map(([, , candidate]) => candidate),
      });

      const promotable = EVERY_STATE.filter(([, label]) =>
        ['Approved by creator', 'Eligible after 30 days inactive'].includes(label),
      ).map(([title]) => title);
      for (const [title] of EVERY_STATE) {
        const button = within(article(title)).queryByRole('button', { name: `Promote ${title}` });
        if (promotable.includes(title)) expect(button).toBeEnabled();
        else expect(button).toBeNull();
      }
      const needsRequest = ['Sailing', 'Origami', 'Cycling'];
      for (const [title] of EVERY_STATE) {
        const button = within(article(title)).queryByRole('button', {
          name: `Create promotion request for ${title}`,
        });
        if (needsRequest.includes(title)) expect(button).toBeEnabled();
        else expect(button).toBeNull();
      }
    });
  });

  describe('promoting', () => {
    it('names the inactivity basis in the confirmation and never words it as approval', async () => {
      const server = { cards: [chess], candidates: [approvedJazz] };
      const app = await openLibrary(server, {
        'POST /admin/library/promote': () =>
          json(200, {
            request: makeRequest({
              id: '12',
              cardId: '502',
              cardTitle: 'Jazz',
              status: 'promoted',
              authorizationKind: 'creator_inactive_30d',
              promotedAt: T2,
              promotionEligibility: {
                status: 'promoted',
                basis: 'creator_inactive_30d',
                reason: null,
              },
            }),
            cardId: '502',
            authorizationKind: 'creator_inactive_30d',
          }),
      });

      await app.user.click(within(article('Jazz')).getByRole('button', { name: 'Promote Jazz' }));

      const dialog = await screen.findByRole('dialog', {
        name: 'Promote “Jazz” to the public library?',
      });
      expect(within(dialog).getByText('Eligible after 30 days inactive')).toBeVisible();
      expect(within(dialog).getByText(/Activity is rechecked when you confirm/)).toBeVisible();
      expect(dialog.textContent).not.toMatch(/approv/i);
      expect(app.calls('POST /admin/library/promote')).toHaveLength(0);

      await app.user.click(
        within(dialog).getByRole('button', { name: 'Promote after 30 days of inactivity' }),
      );

      expect(
        await screen.findByText('Promoted “Jazz”. Published after 30 days of creator inactivity.'),
      ).toBeVisible();
      const [request] = app.calls('POST /admin/library/promote');
      expect(bodyOf(request!)).toEqual({ requestId: '12', expectedVersion: '4' });
      expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.calls('GET /admin/library/candidates')).toHaveLength(2);
      expect(app.calls('GET /admin/library')).toHaveLength(2);
    });

    it('names creator approval as the basis when the creator approved', async () => {
      const app = await openLibrary(
        { cards: [chess], candidates: [hiking] },
        {
          'POST /admin/library/promote': () =>
            json(200, {
              request: makeRequest({
                status: 'promoted',
                authorizationKind: 'creator_approval',
                promotedAt: T2,
                promotionEligibility: {
                  status: 'promoted',
                  basis: 'creator_approval',
                  reason: null,
                },
              }),
              cardId: '501',
              authorizationKind: 'creator_approval',
            }),
        },
      );

      await app.user.click(
        within(article('Hiking trails')).getByRole('button', { name: 'Promote Hiking trails' }),
      );
      const dialog = await screen.findByRole('dialog', {
        name: 'Promote “Hiking trails” to the public library?',
      });
      expect(within(dialog).getByText('Approved by creator')).toBeVisible();
      await app.user.click(
        within(dialog).getByRole('button', { name: 'Promote with creator approval' }),
      );

      expect(
        await screen.findByText('Promoted “Hiking trails”. Approved by creator.'),
      ).toBeVisible();
      expect(bodyOf(app.calls('POST /admin/library/promote')[0]!)).toEqual({
        requestId: '11',
        expectedVersion: '3',
      });
    });

    it('refetches and explains a promotion refused because the eligibility changed (409)', async () => {
      const server: LibraryServer = { cards: [chess], candidates: [approvedJazz] };
      const app = await openLibrary(server, {
        'POST /admin/library/promote': () => {
          server.candidates = [held('Jazz', '502', 'declined', { vetoed: true }, false)];
          return failure(409, 'CONFLICT', { sqlState: 'BZ409' });
        },
      });

      await app.user.click(within(article('Jazz')).getByRole('button', { name: 'Promote Jazz' }));
      const dialog = await screen.findByRole('dialog');
      await app.user.click(
        within(dialog).getByRole('button', { name: 'Promote after 30 days of inactivity' }),
      );

      expect(
        await screen.findByText(
          'The eligibility of this card changed, for example because the creator came back or declined. The list was refreshed; check the new state.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.calls('GET /admin/library/candidates')).toHaveLength(2);
      expect(within(article('Jazz')).getByText('Declined')).toBeVisible();
      expect(within(article('Jazz')).queryByRole('button', { name: 'Promote Jazz' })).toBeNull();
    });

    it('keeps the confirmation open with the error when the request itself failed', async () => {
      const app = await openLibrary(
        { cards: [chess], candidates: [approvedJazz] },
        { 'POST /admin/library/promote': () => failure(500, 'INTERNAL') },
      );

      await app.user.click(within(article('Jazz')).getByRole('button', { name: 'Promote Jazz' }));
      const dialog = await screen.findByRole('dialog');
      await app.user.click(
        within(dialog).getByRole('button', { name: 'Promote after 30 days of inactivity' }),
      );

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side.',
      );
      expect(screen.getByRole('dialog')).toBeVisible();
    });
  });

  describe('promotion requests', () => {
    const sailing = held('Sailing', '506', 'no_request', { topicIds: ['water'] }, false);

    it('asks for the exact listing and sends it for the original creator to answer', async () => {
      const app = await openLibrary(
        { cards: [chess], candidates: [sailing] },
        {
          'POST /admin/library/promotion-requests': () =>
            json(201, { request: makeRequest({ cardId: '506', cardTitle: 'Sailing' }) }),
        },
      );

      await app.user.click(
        within(article('Sailing')).getByRole('button', {
          name: 'Create promotion request for Sailing',
        }),
      );

      const dialog = await screen.findByRole('dialog', { name: 'Create promotion request' });
      expect(within(dialog).getByLabelText('Public title')).toHaveValue('Sailing');
      expect(within(dialog).getByLabelText('Topic ids (comma separated)')).toHaveValue('water');
      await app.user.type(within(dialog).getByLabelText('Slovak title (optional)'), 'Plachtenie');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create request' }));

      expect(await screen.findByText(/Request created/)).toBeVisible();
      const [request] = app.calls('POST /admin/library/promotion-requests');
      expect(bodyOf(request!)).toEqual({
        cardId: '506',
        title: 'Sailing',
        titleSk: 'Plachtenie',
        topicIds: ['water'],
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.calls('GET /admin/library/candidates')).toHaveLength(2);
    });

    it('sends the slug only when one was typed', async () => {
      const app = await openLibrary(
        { cards: [chess], candidates: [sailing] },
        {
          'POST /admin/library/promotion-requests': () =>
            json(201, { request: makeRequest({ cardId: '506', cardTitle: 'Sailing' }) }),
        },
      );

      await app.user.click(
        within(article('Sailing')).getByRole('button', {
          name: 'Create promotion request for Sailing',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      await app.user.type(within(dialog).getByLabelText('Slug (optional)'), 'sailing-boats');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create request' }));

      await screen.findByText(/Request created/);
      expect(bodyOf(app.calls('POST /admin/library/promotion-requests')[0]!)).toEqual({
        cardId: '506',
        title: 'Sailing',
        topicIds: ['water'],
        slug: 'sailing-boats',
      });
    });

    it('rejects an empty title and an invalid topic id before any request', async () => {
      const app = await openLibrary({ cards: [chess], candidates: [sailing] });
      await app.user.click(
        within(article('Sailing')).getByRole('button', {
          name: 'Create promotion request for Sailing',
        }),
      );
      const dialog = await screen.findByRole('dialog');

      await app.user.clear(within(dialog).getByLabelText('Public title'));
      await app.user.clear(within(dialog).getByLabelText('Topic ids (comma separated)'));
      await app.user.paste('Bad Topic');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create request' }));

      expect(within(dialog).getByLabelText('Public title')).toBeInvalid();
      expect(within(dialog).getByLabelText('Topic ids (comma separated)')).toBeInvalid();
      expect(app.calls('POST /admin/library/promotion-requests')).toHaveLength(0);
    });

    it.each([
      [
        409,
        'CONFLICT',
        { reason: 'insufficient_holders', holders: 2, min: 3 },
        'Only 2 readers hold this card; at least 3 are needed.',
      ],
      [
        409,
        'CONFLICT',
        { reason: 'not_shared' },
        'This card is not shared any more, so it cannot be proposed.',
      ],
      [
        400,
        'VALIDATION_FAILED',
        { field: 'topicIds', unknown: ['water'] },
        'Unknown topics: water.',
      ],
    ])('explains a refused request (%i %s)', async (status, code, details, message) => {
      const app = await openLibrary(
        { cards: [chess], candidates: [sailing] },
        { 'POST /admin/library/promotion-requests': () => failure(status, code, details) },
      );

      await app.user.click(
        within(article('Sailing')).getByRole('button', {
          name: 'Create promotion request for Sailing',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create request' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    });
  });

  describe('library cards', () => {
    it('creates a library card, sending only what was filled in', async () => {
      const created = makeLibraryCard({
        cardId: '399',
        slug: 'chess-openings',
        version: 1,
        title: 'Chess openings',
      });
      const app = await openLibrary(
        { cards: [chess], candidates: [] },
        { 'POST /admin/library': () => json(201, { card: created, idChange: null }) },
      );

      await app.user.click(screen.getByRole('button', { name: 'Create library card' }));
      const dialog = await screen.findByRole('dialog', { name: 'Create library card' });
      await app.user.type(within(dialog).getByLabelText('Slug'), 'chess-openings');
      await app.user.type(within(dialog).getByLabelText('Title'), 'Chess openings');
      await app.user.type(
        within(dialog).getByLabelText('Interest'),
        'Opening theory and repertoires',
      );
      await app.user.type(
        within(dialog).getByLabelText('Topic ids (comma separated)'),
        'games, strategy',
      );
      await app.user.click(within(dialog).getByRole('button', { name: 'Create card' }));

      expect(await screen.findByText('Library card created.')).toBeVisible();
      const [request] = app.calls('POST /admin/library');
      expect(bodyOf(request!)).toEqual({
        slug: 'chess-openings',
        title: 'Chess openings',
        interest: 'Opening theory and repertoires',
        topicIds: ['games', 'strategy'],
      });
      expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.calls('GET /admin/library')).toHaveLength(2);
    });

    it('sends the optional text, examples and Slovak texts when they are filled in', async () => {
      const app = await openLibrary(
        { cards: [chess], candidates: [] },
        { 'POST /admin/library': () => json(201, { card: chess, idChange: null }) },
      );

      await app.user.click(screen.getByRole('button', { name: 'Create library card' }));
      const dialog = await screen.findByRole('dialog');
      await app.user.type(within(dialog).getByLabelText('Slug'), 'jazz');
      await app.user.type(within(dialog).getByLabelText('Title'), 'Jazz');
      await app.user.type(within(dialog).getByLabelText('Interest'), 'Jazz history');
      await app.user.type(within(dialog).getByLabelText('But not (optional)'), 'Smooth jazz');
      await app.user.click(
        within(dialog).getByLabelText('Examples of what to show (one per line)'),
      );
      await app.user.paste('Miles Davis in Paris\nBlue Note records');
      await app.user.type(within(dialog).getByLabelText('Slovak title (optional)'), 'Džez');
      await app.user.type(
        within(dialog).getByLabelText('Slovak interest (optional)'),
        'Dejiny džezu',
      );
      await app.user.type(within(dialog).getByLabelText('Topic ids (comma separated)'), 'music');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create card' }));

      await screen.findByText('Library card created.');
      expect(bodyOf(app.calls('POST /admin/library')[0]!)).toEqual({
        slug: 'jazz',
        title: 'Jazz',
        interest: 'Jazz history',
        notFor: 'Smooth jazz',
        examplesYes: ['Miles Davis in Paris', 'Blue Note records'],
        topicIds: ['music'],
        i18n: { sk: { title: 'Džez', interest: 'Dejiny džezu' } },
      });
    });

    it('checks the fields before sending', async () => {
      const app = await openLibrary({ cards: [chess], candidates: [] });
      await app.user.click(screen.getByRole('button', { name: 'Create library card' }));
      const dialog = await screen.findByRole('dialog');

      await app.user.type(within(dialog).getByLabelText('Slug'), 'Not A Slug');
      await app.user.type(within(dialog).getByLabelText('Title'), 'x'.repeat(61));
      await app.user.type(within(dialog).getByLabelText('Interest'), 'ab');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create card' }));

      expect(within(dialog).getByLabelText('Slug')).toBeInvalid();
      expect(within(dialog).getByLabelText('Title')).toBeInvalid();
      expect(within(dialog).getByLabelText('Interest')).toBeInvalid();
      expect(app.calls('POST /admin/library')).toHaveLength(0);
    });

    it.each([
      ['slug_taken', 'This slug is already used by another library card.'],
      [
        'text_exists',
        'A card with this exact text already exists (a library card, a version or a shared card).',
      ],
    ])('explains a refused creation (409 %s)', async (reason, message) => {
      const app = await openLibrary(
        { cards: [chess], candidates: [] },
        { 'POST /admin/library': () => failure(409, 'CONFLICT', { reason }) },
      );

      await app.user.click(screen.getByRole('button', { name: 'Create library card' }));
      const dialog = await screen.findByRole('dialog');
      await app.user.type(within(dialog).getByLabelText('Slug'), 'chess');
      await app.user.type(within(dialog).getByLabelText('Title'), 'Chess');
      await app.user.type(within(dialog).getByLabelText('Interest'), 'Chess openings');
      await app.user.click(within(dialog).getByRole('button', { name: 'Create card' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    });

    it('edits display metadata in place, sending only what changed', async () => {
      const app = await openLibrary(
        { cards: [solar], candidates: [] },
        {
          'PATCH /admin/library/:id': () =>
            json(200, { card: { ...solar, title: 'Solar energy' }, idChange: null }),
        },
      );

      await app.user.click(
        within(article('Solar power')).getByRole('button', { name: 'Edit Solar power' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Edit Solar power (version 2)' });
      expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
      expect(within(dialog).getByText(/creates a new version/)).toBeVisible();
      await app.user.clear(within(dialog).getByLabelText('Title'));
      await app.user.type(within(dialog).getByLabelText('Title'), 'Solar energy');
      await app.user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText('Library card saved.')).toBeVisible();
      const [request] = app.calls('PATCH /admin/library/:id');
      expect(request!.pathname).toBe('/api/v1/admin/library/301');
      expect(bodyOf(request!)).toEqual({ title: 'Solar energy' });
      expect(app.calls('GET /admin/library')).toHaveLength(2);
    });

    it('says when an edit created a new version and what that means for holders', async () => {
      const app = await openLibrary(
        { cards: [solar], candidates: [] },
        {
          'PATCH /admin/library/:id': () =>
            json(200, {
              card: {
                ...solar,
                cardId: '320',
                version: 3,
                latestVersion: 3,
                interest: 'Solar panels for homes',
              },
              idChange: { from: '301', to: '320' },
            }),
        },
      );

      await app.user.click(
        within(article('Solar power')).getByRole('button', { name: 'Edit Solar power' }),
      );
      const dialog = await screen.findByRole('dialog');
      await app.user.clear(within(dialog).getByLabelText('Interest'));
      await app.user.type(within(dialog).getByLabelText('Interest'), 'Solar panels for homes');
      await app.user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      expect(
        await screen.findByText(
          'Saved as a new version (version 3). Readers who have the previous version keep it until they choose to update.',
        ),
      ).toBeVisible();
      expect(bodyOf(app.calls('PATCH /admin/library/:id')[0]!)).toEqual({
        interest: 'Solar panels for homes',
      });
    });

    it('retires a card and sends the topic ids and examples as lists', async () => {
      const app = await openLibrary(
        { cards: [solar], candidates: [] },
        { 'PATCH /admin/library/:id': () => json(200, { card: solar, idChange: null }) },
      );

      await app.user.click(
        within(article('Solar power')).getByRole('button', { name: 'Edit Solar power' }),
      );
      const dialog = await screen.findByRole('dialog');
      await app.user.click(within(dialog).getByLabelText('Retired'));
      await app.user.clear(within(dialog).getByLabelText('Topic ids (comma separated)'));
      await app.user.type(
        within(dialog).getByLabelText('Topic ids (comma separated)'),
        'energy, climate',
      );
      await app.user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      await screen.findByText('Library card saved.');
      expect(bodyOf(app.calls('PATCH /admin/library/:id')[0]!)).toEqual({
        retired: true,
        topicIds: ['energy', 'climate'],
      });
    });

    it('refetches and explains an edit of a version that is no longer the latest (409)', async () => {
      const app = await openLibrary(
        { cards: [solar], candidates: [] },
        {
          'PATCH /admin/library/:id': () =>
            failure(409, 'CONFLICT', { reason: 'not_latest_version' }),
        },
      );

      await app.user.click(
        within(article('Solar power')).getByRole('button', { name: 'Edit Solar power' }),
      );
      const dialog = await screen.findByRole('dialog');
      await app.user.clear(within(dialog).getByLabelText('Title'));
      await app.user.type(within(dialog).getByLabelText('Title'), 'Solar energy');
      await app.user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'A newer version of this card exists. The list was refreshed; edit the newest version.',
      );
      expect(app.calls('GET /admin/library')).toHaveLength(2);
    });
  });

  describe('lists', () => {
    it('searches the cards through the address and loads more pages', async () => {
      const seen: (string | null)[] = [];
      const app = await openLibrary(
        { cards: [solar], candidates: [] },
        {
          'GET /admin/library': (request) => {
            const cursor = request.query.get('cursor');
            seen.push(`${cursor ?? ''}|${request.query.get('q') ?? ''}`);
            return json(
              200,
              cursor === 'next'
                ? page([birds])
                : page([solar], request.query.get('q') === null ? 'next' : null),
            );
          },
        },
      );
      expect(screen.queryByText('Garden birds')).toBeNull();

      await app.user.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByText('Garden birds')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
      expect(seen).toEqual(['|', 'next|']);

      await app.user.type(
        screen.getByRole('searchbox', { name: 'Search library cards' }),
        'solar{Enter}',
      );

      await vi.waitFor(() => expect(seen.at(-1)).toBe('|solar'));
      expect(app.router.state.location.search).toEqual({ q: 'solar' });
      expect(screen.queryByText('Garden birds')).toBeNull();
    });

    it('shows empty states for both lists', async () => {
      await openLibrary({ cards: [], candidates: [] });

      expect(screen.getByText('No library cards match.')).toBeVisible();
      expect(screen.getByText('No shared cards have enough holders yet.')).toBeVisible();
    });

    it('shows the error state of the candidates without hiding the cards', async () => {
      await render({
        path: '/admin/library',
        server: {
          me: adminMe(),
          routes: adminRoutes({
            'GET /admin/library/candidates': () => failure(500, 'INTERNAL'),
          }),
        },
      });

      expect(await screen.findByText('Solar power')).toBeVisible();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side.',
      );
    });
  });
});
