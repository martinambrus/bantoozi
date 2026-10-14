import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArticleDetail } from '../../src/features/article/article-detail.js';
import { json } from '../api/fake-fetch.js';
import { TOPICS, cardDraftRoutes } from '../interests/support.js';
import type { ApiRouteHandler } from '../support/app.js';
import { bodyOf, detailRoute, findToast, makeItem, makeRule, renderReader } from './harness.js';

const ITEM = makeItem({ title: 'Batteries and solar power' });

function renderPane(
  rules: unknown[] | (() => unknown[]),
  routes: Record<string, ApiRouteHandler> = {},
) {
  return renderReader(<ArticleDetail item={ITEM} />, {
    routes: {
      ...detailRoute(ITEM),
      'GET /rules': () => json(200, typeof rules === 'function' ? rules() : rules),
      'GET /cards': () => json(200, []),
      'GET /topics': () => json(200, TOPICS),
      'GET /subscriptions': () => json(200, []),
      ...cardDraftRoutes(),
      ...routes,
    },
  });
}

async function offered(app: ReturnType<typeof renderPane>) {
  await app.user.click(await screen.findByRole('button', { name: 'Mute a keyword' }));
  return within(await screen.findByRole('menu', { name: 'Mute a keyword' }))
    .getAllByRole('menuitem')
    .map((item) => item.textContent);
}

describe('the reading pane card and keyword actions', () => {
  it('offers every title word when nothing is muted', async () => {
    const app = renderPane([]);
    expect(await offered(app)).toEqual(['Batteries', 'and', 'solar', 'power']);
    expect(screen.getByRole('button', { name: 'Make a card from this' })).toBeInTheDocument();
  });

  it('opens the drafted card editor and gives the focus back to its button', async () => {
    const app = renderPane([]);
    const button = await screen.findByRole('button', { name: 'Make a card from this' });
    await app.user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'New card from this article' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('leaves out words an active keyword rule mutes, however they are written', async () => {
    const app = renderPane([
      makeRule('1', 'mute_keyword', 'solar'),
      makeRule('2', 'mute_keyword', 'BATTERIES'),
      makeRule('3', 'block_domain', 'power'),
    ]);
    expect(await offered(app)).toEqual(['and', 'power']);
  });

  it('shows no keyword menu when every word is muted', async () => {
    renderPane(
      ['batteries', 'and', 'solar', 'power'].map((w, i) => makeRule(`${i + 1}`, 'mute_keyword', w)),
    );
    await screen.findByRole('button', { name: 'Make a card from this' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mute a keyword' })).toBeNull(),
    );
  });

  it('drops a word from the menu once it is muted, and brings it back with the undo', async () => {
    const rules: ReturnType<typeof makeRule>[] = [];
    const app = renderPane(() => rules, {
      'POST /rules': (request) => {
        const { value } = bodyOf(request) as { value: string };
        const rule = makeRule('77', 'mute_keyword', value);
        rules.push(rule);
        return json(201, { rule });
      },
      'DELETE /rules/:id': () => {
        rules.length = 0;
        return new Response(null, { status: 204 });
      },
    });
    await offered(app);
    await app.user.click(screen.getByRole('menuitem', { name: 'solar' }));
    const toast = await findToast('Muted keyword: “solar”');
    expect(await offered(app)).toEqual(['Batteries', 'and', 'power']);
    await app.user.keyboard('{Escape}');

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/77')).toHaveLength(1));
    await waitFor(() => expect(rules).toHaveLength(0));
    expect(await offered(app)).toEqual(['Batteries', 'and', 'solar', 'power']);
  });
});
