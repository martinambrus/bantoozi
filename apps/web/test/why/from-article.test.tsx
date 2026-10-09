import { CARD_LIMITS, type CardDto } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CardEditor } from '../../src/features/interests/card-editor.js';
import { cardsKey } from '../../src/features/interests/queries.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, renderReader } from '../article/harness.js';
import { cardResult, makeCard, makeSubscription } from '../interests/support.js';
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

    expect(form.getByLabelText(LABELS.interest)).toHaveValue(ARTICLE.title);
    expect(form.getByLabelText(LABELS.name)).toHaveValue('');
    expect(form.getByLabelText(LABELS.notFor)).toHaveValue('');
    expect(form.getByRole('radio', { name: 'Like' })).toBeChecked();
    expect(dialog).toHaveAccessibleDescription(
      'Starts from the title of this article, which is kept as the first example of what you want to read.',
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

  it('asks for a description before sending anything, as it does for any card', async () => {
    const { app, form } = await openEditor();
    const interest = form.getByLabelText(LABELS.interest);

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
