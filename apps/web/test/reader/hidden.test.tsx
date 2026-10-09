import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { deferred } from '../article/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { acked } from './actions/fake-transport.js';
import { createReaderHarness, item, listQueries, rowTitles } from './support.js';
import { openMore, receipt, undoRoute } from './surfaces.js';

const { open } = createReaderHarness();

const UNHIDE = 'POST /articles/:id/unhide';
const HIDDEN_AT = '2026-05-30T09:00:00.000Z';

/** An article that a rule or a Never card hides: its lane is Hidden and its reason names the rule. */
function ruled(id: number, code: string, ruleId?: string): ArticleListItem {
  return item(id, {
    lane: 'hidden',
    tier: null,
    pLike: null,
    topReason: { kind: 'rule', code, ...(ruleId === undefined ? {} : { ruleId }) },
  });
}

const BY_YOU = item(1, { archivedAt: HIDDEN_AT });
const BY_RULE = ruled(2, 'mute_keyword:crypto', '9');
const BY_BOTH = { ...ruled(3, 'block_domain', '12'), archivedAt: HIDDEN_AT };
const ROWS = [BY_YOU, BY_RULE, BY_BOTH];

/** The causes listed under the row called `title`. */
const causesOf = (title: string) => screen.findByRole('list', { name: `Why “${title}” is hidden` });

/** `POST /articles/:id/unhide`, answered like the API: the article without its archive. */
function unhideRoute(rows: readonly ArticleListItem[]): Record<string, ApiRouteHandler> {
  return {
    [UNHIDE]: (_request, params) => {
      const row = rows.find((candidate) => candidate.id === params['id']) ?? rows[0]!;
      return json(200, { item: acked(row, { archivedAt: null }), mutationId: receipt(1) });
    },
  };
}

describe('the causes under a hidden article', () => {
  it.each([
    ['mute_keyword:crypto', 'Hidden by a rule: Muted keyword: “crypto”', 'Go to Rules', '/rules'],
    ['mute_story', 'Hidden by a rule: Muted story', 'Go to Rules', '/rules'],
    ['block_feed', 'Hidden by a rule: Blocked source', 'Go to Rules', '/rules'],
    ['block_domain', 'Hidden by a rule: Blocked website', 'Go to Rules', '/rules'],
    ['block_author', 'Hidden by a rule: Blocked author', 'Go to Rules', '/rules'],
    ['never:31', 'Hidden by a never-show interest', 'Go to Interests', '/interests'],
  ])('words the rule %s and links to where it is changed', async (code, sentence, link, href) => {
    await open({ path: '/read/hidden', items: [ruled(1, code)] });

    const causes = await causesOf('Article 1');

    expect(within(causes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(causes).getByText(sentence)).toBeVisible();
    expect(within(causes).getByRole('link', { name: link })).toHaveAttribute('href', href);
    expect(within(causes).queryByText('Hidden by you')).toBeNull();
    expect(within(causes).queryByRole('button', { name: 'Unhide' })).toBeNull();
  });

  it('says that the reader hid an article, with a way to unhide it and no link', async () => {
    await open({ path: '/read/hidden', items: [BY_YOU] });

    const causes = await causesOf('Article 1');

    expect(within(causes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(causes).getByText('Hidden by you')).toBeVisible();
    expect(within(causes).getByRole('button', { name: 'Unhide' })).toBeEnabled();
    expect(within(causes).queryByRole('link')).toBeNull();
    expect(within(causes).queryByText(/Hidden by a rule/)).toBeNull();
  });

  it('gives both causes of an article that the reader hid and a rule hides', async () => {
    await open({ path: '/read/hidden', items: [BY_BOTH] });

    const causes = await causesOf('Article 3');

    expect(within(causes).getAllByRole('listitem')).toHaveLength(2);
    expect(within(causes).getByText('Hidden by you')).toBeVisible();
    expect(within(causes).getByRole('button', { name: 'Unhide' })).toBeEnabled();
    expect(within(causes).getByText('Hidden by a rule: Blocked website')).toBeVisible();
    expect(within(causes).getByRole('link', { name: 'Go to Rules' })).toHaveAttribute(
      'href',
      '/rules',
    );
  });

  it('offers Unhide only under the articles that the reader hid', async () => {
    await open({ path: '/read/hidden', items: ROWS });

    const underYou = await causesOf('Article 1');
    const underRule = await causesOf('Article 2');
    const underBoth = await causesOf('Article 3');

    expect(screen.getAllByRole('button', { name: 'Unhide' })).toHaveLength(2);
    expect(within(underYou).getByRole('button', { name: 'Unhide' })).toBeVisible();
    expect(within(underRule).queryByRole('button', { name: 'Unhide' })).toBeNull();
    expect(within(underBoth).getByRole('button', { name: 'Unhide' })).toBeVisible();
  });

  it('says that a rule hides an article whose reason it cannot name', async () => {
    await open({
      path: '/read/hidden',
      items: [item(1, { lane: 'hidden', tier: null, pLike: null, topReason: null })],
    });

    const causes = await causesOf('Article 1');

    expect(within(causes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(causes).getByText('Hidden by a rule')).toBeVisible();
    expect(within(causes).getByRole('link', { name: 'Go to Rules' })).toHaveAttribute(
      'href',
      '/rules',
    );
  });

  it('has an accessible name, a 44 px target and a focus ring on every control', async () => {
    await open({ path: '/read/hidden', items: ROWS });
    await causesOf('Article 1');

    const controls = [
      ...screen.getAllByRole('button', { name: 'Unhide' }),
      ...screen.getAllByRole('link', { name: /^Go to / }),
    ];

    expect(controls).toHaveLength(4);
    for (const control of controls) {
      expect(control).toHaveAccessibleName();
      expect(control).toHaveClass('min-h-11');
      expect(control.className).toMatch(/focus-visible:outline/);
    }
  });
});

describe('Unhide', () => {
  it('sends one request with the fence of the article, for that article only', async () => {
    const { app } = await open({ path: '/read/hidden', items: ROWS, routes: unhideRoute(ROWS) });
    const causes = await causesOf('Article 1');

    await app.user.click(within(causes).getByRole('button', { name: 'Unhide' }));

    await waitFor(() => expect(app.calls(UNHIDE)).toHaveLength(1));
    const [request] = app.calls(UNHIDE);
    expect(request!.pathname).toBe('/api/v1/articles/1/unhide');
    expect(bodyOf(request!)).toEqual({ stateVersion: '4', contentRevision: '2' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await within(causes).findByText(/Not hidden any more/);
    expect(app.calls(UNHIDE)).toHaveLength(1);
  });

  it('keeps the row and says that it is not hidden any more when nothing else hides it', async () => {
    const { app } = await open({ path: '/read/hidden', items: ROWS, routes: unhideRoute(ROWS) });
    const causes = await causesOf('Article 1');

    await app.user.click(within(causes).getByRole('button', { name: 'Unhide' }));

    expect(
      await within(causes).findByText(
        'Not hidden any more. It leaves this list when the list is loaded again.',
      ),
    ).toBeVisible();
    expect(within(causes).queryByText('Hidden by you')).toBeNull();
    expect(within(causes).queryByRole('button', { name: 'Unhide' })).toBeNull();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(
      within(screen.getByRole('article', { name: 'Article 1' })).getByRole('button', {
        name: 'Article 1',
      }),
    ).toHaveFocus();
  });

  it('keeps the line of the rule under an article that a rule still hides', async () => {
    const { app } = await open({ path: '/read/hidden', items: ROWS, routes: unhideRoute(ROWS) });
    const causes = await causesOf('Article 3');

    await app.user.click(within(causes).getByRole('button', { name: 'Unhide' }));

    await waitFor(() => expect(app.calls(UNHIDE)).toHaveLength(1));
    expect(app.calls(UNHIDE)[0]!.pathname).toBe('/api/v1/articles/3/unhide');
    await waitFor(() => expect(within(causes).queryByText('Hidden by you')).toBeNull());
    expect(within(causes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(causes).getByText('Hidden by a rule: Blocked website')).toBeVisible();
    expect(within(causes).getByRole('link', { name: 'Go to Rules' })).toBeVisible();
    expect(within(causes).queryByText(/Not hidden any more/)).toBeNull();
    expect(within(causes).queryByRole('button', { name: 'Unhide' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Unhide' })).toHaveLength(1);
  });

  it('leaves the list when it is loaded again, and shows only what still hides the others', async () => {
    const { app, state } = await open({
      path: '/read/hidden',
      items: ROWS,
      routes: unhideRoute(ROWS),
    });
    await app.user.click(
      within(await causesOf('Article 1')).getByRole('button', { name: 'Unhide' }),
    );
    await app.user.click(
      within(await causesOf('Article 3')).getByRole('button', { name: 'Unhide' }),
    );
    await waitFor(() => expect(app.calls(UNHIDE)).toHaveLength(2));

    state.items = [BY_RULE, { ...BY_BOTH, archivedAt: null, stateVersion: '5' }];
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 2', 'Article 3']));
    expect(listQueries(app)).toHaveLength(2);
    const causes = await causesOf('Article 3');
    expect(within(causes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(causes).getByText('Hidden by a rule: Blocked website')).toBeVisible();
    expect(screen.queryByText('Hidden by you')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unhide' })).toBeNull();
  });

  it('is taken back from Recent actions: the line of the reader and its button come back', async () => {
    const { app } = await open({
      path: '/read/hidden',
      items: ROWS,
      routes: { ...unhideRoute(ROWS), ...undoRoute({ ...BY_YOU, stateVersion: '6' }) },
    });
    const causes = await causesOf('Article 1');
    await app.user.click(within(causes).getByRole('button', { name: 'Unhide' }));
    await within(causes).findByText(/Not hidden any more/);
    await openMore(app, 'Hidden');
    await app.user.click(await screen.findByRole('menuitem', { name: 'Recent actions' }));
    const sheet = await screen.findByRole('dialog', { name: 'Recent actions' });
    const [entry] = await within(sheet).findAllByRole('listitem');
    expect(within(entry!).getByText('Unhidden')).toBeVisible();
    expect(within(entry!).getByText('Article 1')).toBeVisible();

    await app.user.click(within(entry!).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(app.calls('POST /articles/undo')).toHaveLength(1));
    expect(bodyOf(app.calls('POST /articles/undo')[0]!)).toEqual({ mutationId: receipt(1) });
    await waitFor(() => expect(within(sheet).queryByRole('listitem')).toBeNull());
    await app.user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(causes).getByText('Hidden by you')).toBeVisible();
    expect(within(causes).getByRole('button', { name: 'Unhide' })).toBeEnabled();
    expect(within(causes).queryByText(/Not hidden any more/)).toBeNull();
  });

  it('puts the line back when the request is refused', async () => {
    const answer = deferred<Response>();
    const { app } = await open({
      path: '/read/hidden',
      items: [BY_YOU],
      routes: { [UNHIDE]: () => answer.promise },
    });
    const causes = await causesOf('Article 1');
    await app.user.click(within(causes).getByRole('button', { name: 'Unhide' }));
    await within(causes).findByText(/Not hidden any more/);
    expect(within(causes).queryByText('Hidden by you')).toBeNull();

    answer.resolve(failure(403, 'FORBIDDEN'));

    expect(await screen.findByText("Couldn't save — retry")).toBeVisible();
    await waitFor(() => expect(within(causes).getByText('Hidden by you')).toBeVisible());
    expect(within(causes).getByRole('button', { name: 'Unhide' })).toBeEnabled();
    expect(within(causes).queryByText(/Not hidden any more/)).toBeNull();
    expect(app.calls(UNHIDE)).toHaveLength(1);
  });
});

describe('the other views', () => {
  it('show no causes, however the articles they list are hidden', async () => {
    const { app } = await open({ path: '/read/hidden', items: ROWS });
    await causesOf('Article 1');
    expect(screen.getAllByRole('list', { name: /is hidden$/ })).toHaveLength(3);

    const views = [
      { to: '/read/$lane', params: { lane: 'for_you' }, title: 'For you' },
      { to: '/read/$lane', params: { lane: 'maybe' }, title: 'Maybe' },
      { to: '/read/$lane', params: { lane: 'everything' }, title: 'Everything else' },
      { to: '/read/$lane', params: { lane: 'new' }, title: 'New' },
      { to: '/read/$lane', params: { lane: 'bookmarks' }, title: 'Bookmarks' },
      { to: '/read/feed/$feedId', params: { feedId: '7' }, title: 'Feed' },
      { to: '/read/folder/$name', params: { name: 'News' }, title: 'News' },
    ] as const;
    for (const { to, params, title } of views) {
      await act(async () => {
        await app.router.navigate({ to, params } as never);
      });
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
      await screen.findByRole('article', { name: 'Article 1' });
      expect(screen.queryByRole('list', { name: /is hidden$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Unhide' })).toBeNull();
      expect(screen.queryByText(/^Hidden by/)).toBeNull();
      expect(screen.queryByRole('link', { name: /^Go to / })).toBeNull();
    }
  });
});

describe('in Slovak', () => {
  it('words the causes and the controls', async () => {
    await open({
      path: '/read/hidden',
      me: makeMe({ locale: 'sk' }),
      items: [BY_BOTH, ruled(4, 'never:31')],
    });

    const both = await screen.findByRole('list', { name: 'Prečo je článok „Article 3“ skrytý' });
    const never = await screen.findByRole('list', { name: 'Prečo je článok „Article 4“ skrytý' });

    expect(within(both).getByText('Skryté vami')).toBeVisible();
    expect(within(both).getByRole('button', { name: 'Zrušiť skrytie' })).toBeVisible();
    expect(within(both).getByText('Skryté pravidlom: Blokovaný web')).toBeVisible();
    expect(within(both).getByRole('link', { name: 'Prejsť na Pravidlá' })).toHaveAttribute(
      'href',
      '/rules',
    );
    expect(within(never).getByText('Skryté záujmom „nikdy nezobrazovať“')).toBeVisible();
    expect(within(never).getByRole('link', { name: 'Prejsť na Záujmy' })).toHaveAttribute(
      'href',
      '/interests',
    );
  });
});
