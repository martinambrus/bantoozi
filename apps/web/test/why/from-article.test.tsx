import { CARD_LIMITS, type CardDto } from '@bantoozi/shared';
import { configure, getConfig, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CardEditor } from '../../src/features/interests/card-editor.js';
import { learningKey } from '../../src/features/learning/use-learning.js';
import { cardsKey } from '../../src/features/interests/queries.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, renderReader } from '../article/harness.js';
import {
  DRAFT_ID,
  cardDraftRoutes,
  cardResult,
  makeCard,
  makeSubscription,
} from '../interests/support.js';
import type { ApiRouteHandler } from '../support/app.js';
import { USER_A_ID } from '../session/fixtures.js';
import { HELD, checkUnhandled, track } from './support.js';

checkUnhandled();

const ARTICLE = { id: '101', title: 'Solid-state batteries reach the pilot line' };

const LABELS = {
  name: 'Name (optional)',
  interest: 'I want to read about…',
  notFor: '…but not about',
  scope: 'Applies to',
};

const CREATED = makeCard({
  id: '41',
  title: ARTICLE.title,
  interest: ARTICLE.title,
  origin: 'fork',
  isPrivateFork: true,
  examplesYes: [ARTICLE.title],
});

async function openEditor(routes: Record<string, ApiRouteHandler> = {}) {
  const onClose = vi.fn();
  const app = track(
    renderReader(<CardEditor fromArticle={ARTICLE} onClose={onClose} />, {
      routes: {
        'GET /subscriptions': () => json(200, [makeSubscription('11', 'Hacker News')]),
        ...cardDraftRoutes(),
        ...routes,
      },
    }),
  );
  app.queryClient.setQueryData<CardDto[]>(cardsKey(USER_A_ID), HELD);
  const dialog = await screen.findByRole('dialog', { name: 'New card from this article' });
  return { app, onClose, dialog, form: within(dialog) };
}

describe('the card editor made from an article', () => {
  it('starts the interest from the title of the article and explains where the example comes from', async () => {
    const { dialog, form } = await openEditor();

    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title));
    expect(form.getByLabelText(LABELS.name)).toHaveValue('');
    expect(form.getByLabelText(LABELS.notFor)).toHaveValue('');
    expect(form.getByRole('radio', { name: 'Like' })).toBeChecked();
    expect(dialog).toHaveAccessibleDescription(
      'Keeps the title of this article as the first example of what you want to read.',
    );
  });

  it('offers no scope, because a card made from an article applies to all feeds', async () => {
    const { form } = await openEditor();

    expect(form.queryByLabelText(LABELS.scope)).toBeNull();
  });

  it('creates the card from the article with the name, the text and the strength typed', async () => {
    const { app, form, onClose } = await openEditor({
      'POST /cards/from-article': () => json(201, cardResult(CREATED)),
    });
    const interest = form.getByLabelText(LABELS.interest);
    await waitFor(() => expect(interest).toHaveValue(ARTICLE.title));

    await app.user.clear(interest);
    await app.user.type(interest, '  Solid-state batteries ');
    await app.user.type(form.getByLabelText(LABELS.name), 'Batteries');
    await app.user.type(form.getByLabelText(LABELS.notFor), 'Stock-price moves');
    await app.user.click(form.getByRole('radio', { name: 'Love' }));
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const requests = app.calls('POST', '/cards/from-article');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({
      articleId: '101',
      interest: 'Solid-state batteries',
      title: 'Batteries',
      notFor: 'Stock-price moves',
      strength: 'love',
    });
    expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.calls('POST', '/cards')).toHaveLength(0);
    expect(
      app.queryClient.getQueryData<CardDto[]>(cardsKey(USER_A_ID))?.map((card) => card.id),
    ).toEqual(['31', '32', '33', '41']);
  });

  it('keeps the editor and what was typed when the card cannot be created, and says why', async () => {
    const { app, form, onClose } = await openEditor({
      'POST /cards/from-article': () => failure(409, 'CONFLICT', { reason: 'already_held' }),
    });
    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title));
    await app.user.type(form.getByLabelText(LABELS.name), 'Batteries');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'You already have a card with this text, with a different strength, scope or name. Find it in My interests to change it.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(form.getByLabelText(LABELS.name)).toHaveValue('Batteries');
    expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title);
    expect(form.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('offers to replace a held card at the card limit and resends with the chosen one', async () => {
    const { app, form, onClose } = await openEditor({
      'GET /cards': () => json(200, HELD),
      'GET /cards/usage': () =>
        json(200, [
          { cardId: '31', likedMatches: 4 },
          { cardId: '32', likedMatches: 2 },
          { cardId: '33', likedMatches: 0 },
        ]),
      'POST /cards/from-article': (request) =>
        (bodyOf(request) as { replaceCardId?: string }).replaceCardId === undefined
          ? failure(409, 'QUOTA_EXCEEDED', { limit: 'maxCards', used: 3, max: 3 })
          : json(201, cardResult(CREATED)),
    });
    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title));
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    const group = await form.findByRole('group', { name: 'Replace a card to make room' });
    const radios = await within(group).findAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual(['33', '32', '31']);

    await app.user.click(within(group).getByRole('radio', { name: /Solar power/ }));
    await app.user.click(form.getByRole('button', { name: 'Replace and save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(app.calls('POST', '/cards/from-article').map(bodyOf)).toEqual([
      { articleId: '101', interest: ARTICLE.title, strength: 'like' },
      { articleId: '101', interest: ARTICLE.title, strength: 'like', replaceCardId: '32' },
    ]);
    expect(
      app.queryClient.getQueryData<CardDto[]>(cardsKey(USER_A_ID))?.map((card) => card.id),
    ).toEqual(['31', '33', '41']);
  });

  it('asks for a description before sending anything, as it does for any card', async () => {
    const { app, form } = await openEditor();
    const interest = form.getByLabelText(LABELS.interest);
    await waitFor(() => expect(interest).toHaveValue(ARTICLE.title));

    await app.user.clear(interest);
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(interest).toBeInvalid();
    expect(interest).toHaveAccessibleDescription(
      `0 / ${CARD_LIMITS.interestMax} Describe what you want to read about.`,
    );
    expect(app.calls('POST', '/cards/from-article')).toHaveLength(0);
  });

  it('closes with Cancel and sends nothing', async () => {
    const { app, form, onClose } = await openEditor();

    await app.user.click(form.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(app.calls('POST', '/cards/from-article')).toHaveLength(0);
  });
});

describe('the card editor while the draft is written', () => {
  it('shows empty fields with a Loading placeholder, then the article title when no draft comes', async () => {
    let answer: Record<string, unknown> = { status: 'pending' };
    const { form } = await openEditor({
      'GET /cards/drafts/:id': () =>
        json(200, { id: DRAFT_ID, title: null, interest: null, source: null, ...answer }),
    });
    const interest = form.getByLabelText(LABELS.interest);
    const name = form.getByLabelText(LABELS.name);
    expect(interest).toHaveValue('');
    expect(interest).toHaveAttribute('placeholder', 'Loading…');
    expect(name).toHaveValue('');
    expect(name).toHaveAttribute('placeholder', 'Loading…');
    expect(form.getByLabelText(LABELS.notFor)).not.toHaveAttribute('placeholder');

    answer = { status: 'failed' };
    await waitFor(() => expect(interest).toHaveValue(ARTICLE.title), { timeout: 3_000 });
    expect(name).toHaveValue('');
    expect(name).not.toHaveAttribute('placeholder');
  });

  it('keeps what was typed while the draft is pending', async () => {
    const { app, form } = await openEditor({
      'GET /cards/drafts/:id': () =>
        json(200, { id: DRAFT_ID, title: null, interest: null, source: null, status: 'pending' }),
    });
    await app.user.type(form.getByLabelText(LABELS.interest), 'Batteries and cells');

    expect(form.getByLabelText(LABELS.interest)).toHaveValue('Batteries and cells');
    expect(form.getByLabelText(LABELS.interest)).not.toHaveAttribute('placeholder');
  });

  it('marks the learning status stale once the card is saved', async () => {
    const { app, form, onClose } = await openEditor({
      'POST /cards/from-article': () => json(201, cardResult(CREATED)),
    });
    app.queryClient.setQueryData(learningKey(USER_A_ID), { feeds: [] });
    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title));
    expect(app.queryClient.getQueryState(learningKey(USER_A_ID))?.isInvalidated).toBe(false);

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(app.queryClient.getQueryState(learningKey(USER_A_ID))?.isInvalidated).toBe(true);
  });
});

describe('the drafted name and interest (D-240)', () => {
  const DRAFTED = {
    status: 'complete' as const,
    title: 'Battery technology',
    interest: 'New battery chemistries and how they reach production.',
    source: 'llm' as const,
  };

  it('asks for a draft of the article and fills the name and the interest with it', async () => {
    const { app, form, dialog } = await openEditor(cardDraftRoutes(DRAFTED));

    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(DRAFTED.interest));
    expect(form.getByLabelText(LABELS.name)).toHaveValue(DRAFTED.title);
    expect(
      within(dialog).getByText(
        'Name and description drafted from the article. Check them and change anything before saving.',
      ),
    ).toHaveAttribute('role', 'status');
    expect(app.calls('POST', '/cards/drafts').map(bodyOf)).toEqual([
      { articleIds: ['101'], kind: 'interest' },
    ]);
  });

  it('fills the fields under StrictMode, whose second effect run must not lose the draft', async () => {
    const strict = getConfig().reactStrictMode;
    configure({ reactStrictMode: true });
    try {
      const onClose = vi.fn();
      const app = track(
        renderReader(<CardEditor fromArticle={ARTICLE} onClose={onClose} />, {
          routes: { 'GET /subscriptions': () => json(200, []), ...cardDraftRoutes(DRAFTED) },
        }),
      );
      app.queryClient.setQueryData<CardDto[]>(cardsKey(USER_A_ID), HELD);
      const dialog = await screen.findByRole('dialog', { name: 'New card from this article' });
      await waitFor(() =>
        expect(within(dialog).getByLabelText(LABELS.interest)).toHaveValue(DRAFTED.interest),
      );
      expect(app.calls('POST', '/cards/drafts')).toHaveLength(1);
    } finally {
      configure({ reactStrictMode: strict });
    }
  });

  it('never overwrites what the person typed before the draft came', async () => {
    let answer: Record<string, unknown> = { status: 'pending' };
    const routes = cardDraftRoutes();
    const { app, form } = await openEditor({
      ...routes,
      'GET /cards/drafts/:id': () =>
        json(200, { id: DRAFT_ID, title: null, interest: null, source: null, ...answer }),
    });
    expect(await form.findByText('Writing a name and description from the article…')).toBeVisible();
    await app.user.type(form.getByLabelText(LABELS.name), 'Mine');
    answer = DRAFTED;

    await waitFor(
      () => expect(form.getByLabelText(LABELS.interest)).toHaveValue(DRAFTED.interest),
      {
        timeout: 3_000,
      },
    );
    expect(form.getByLabelText(LABELS.name)).toHaveValue('Mine');
  });

  it('makes one card from several articles, every title an example', async () => {
    const onClose = vi.fn();
    const articles = [ARTICLE, { id: '102', title: 'Sodium-ion cells go on sale' }];
    const app = track(
      renderReader(<CardEditor fromArticles={articles} onClose={onClose} />, {
        routes: {
          'GET /subscriptions': () => json(200, []),
          ...cardDraftRoutes(DRAFTED),
          'POST /cards/from-article': () => json(201, cardResult(CREATED)),
        },
      }),
    );
    app.queryClient.setQueryData<CardDto[]>(cardsKey(USER_A_ID), HELD);
    const dialog = await screen.findByRole('dialog', { name: 'New card from these articles' });
    const form = within(dialog);
    await waitFor(() => expect(form.getByLabelText(LABELS.interest)).toHaveValue(DRAFTED.interest));
    expect(app.calls('POST', '/cards/drafts').map(bodyOf)).toEqual([
      { articleIds: ['101', '102'], kind: 'interest' },
    ]);

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(bodyOf(app.calls('POST', '/cards/from-article')[0]!)).toEqual({
      articleId: '101',
      moreArticleIds: ['102'],
      interest: DRAFTED.interest,
      title: DRAFTED.title,
      strength: 'like',
    });
  });
});
