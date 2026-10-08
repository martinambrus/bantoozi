import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { accountKey } from '../../src/api/query-keys.js';
import { makeSubscription, type SubscriptionOverrides } from '../feeds/support.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { createKeysHarness } from './key-support.js';
import { sidebar } from './support.js';

const { open } = createKeysHarness();

function feed(
  id: string,
  title: string,
  folder: string | null = null,
  overrides: SubscriptionOverrides = {},
) {
  return makeSubscription({ ...overrides, feed: { id, title, ...overrides.feed }, folder });
}

const FEEDS = [
  feed('1', 'The Verge', 'Tech'),
  feed('2', 'Wired', 'Tech'),
  feed('3', 'Ars Technica'),
  feed('4', 'Správy SME', 'News'),
  feed('5', 'BBC World', 'News', { titleOverride: 'Svet podľa BBC' }),
];
const EVERYTHING = [
  'News',
  'Správy SME',
  'Svet podľa BBC',
  'Tech',
  'The Verge',
  'Wired',
  'Ars Technica',
];

const filter = () => screen.getByRole('textbox', { name: 'Filter feeds' });
const feedsList = () => screen.queryByRole('list', { name: 'Feeds' });
const shown = () => {
  const list = feedsList();
  return list === null
    ? []
    : within(list)
        .queryAllByRole('link')
        .map((link) => link.textContent);
};

async function openFeeds(subscriptions = FEEDS, options: { language?: 'sk'; path?: string } = {}) {
  const { app, state } = await open({
    path: options.path ?? '/read/for_you',
    subscriptions,
    ...(options.language === 'sk' ? { language: 'sk' as const, me: makeMe({ locale: 'sk' }) } : {}),
  });
  await screen.findByRole('textbox', {
    name: options.language === 'sk' ? 'Filtrovať zdroje' : 'Filter feeds',
  });
  return { app, state };
}

describe('the feed filter', () => {
  it('is a labelled text field between the heading of the feeds and their list', async () => {
    await openFeeds();

    const field = filter();

    expect(sidebar()).toContainElement(field);
    expect(field).toHaveAttribute('aria-keyshortcuts', '/');
    expect(field.className).toContain('min-h-11');
    expect(field.className).toContain('focus-visible:outline-2');
    const heading = within(sidebar()).getByRole('heading', { level: 2, name: 'Feeds' });
    expect(heading.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      field.compareDocumentPosition(feedsList()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(field).toHaveValue('');
    expect(shown()).toEqual(EVERYTHING);
  });

  it('narrows the feeds as it is typed, whatever the case, without asking the server', async () => {
    const { app } = await openFeeds();
    const before = app.requests.length;

    await app.user.type(filter(), 'VeRg');

    expect(shown()).toEqual(['Tech', 'The Verge']);
    expect(screen.queryByRole('link', { name: 'Wired' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'News' })).toBeNull();
    expect(app.requests.length).toBe(before);

    await app.user.clear(filter());
    await app.user.type(filter(), 'ars');

    expect(shown()).toEqual(['Ars Technica']);
  });

  it('ignores accents, in what is typed and in the titles', async () => {
    const { app } = await openFeeds();

    await app.user.type(filter(), 'spravy');
    expect(shown()).toEqual(['News', 'Správy SME']);

    await app.user.clear(filter());
    await app.user.type(filter(), 'SPRÁVY');
    expect(shown()).toEqual(['News', 'Správy SME']);

    await app.user.clear(filter());
    await app.user.type(filter(), 'podla');
    expect(shown()).toEqual(['News', 'Svet podľa BBC']);
  });

  it('goes by the title a feed is shown with, and by a word anywhere in it', async () => {
    const { app } = await openFeeds();

    await app.user.type(filter(), 'world');
    expect(shown()).toEqual([]);

    await app.user.clear(filter());
    await app.user.type(filter(), '  the  verge ');
    expect(shown()).toEqual(['Tech', 'The Verge']);

    await app.user.clear(filter());
    await app.user.type(filter(), 'tech');
    expect(shown()).toEqual(['Ars Technica']);
  });

  it('shows all the feeds for a filter that holds nothing to match', async () => {
    const { app } = await openFeeds();

    await app.user.type(filter(), '   ');
    expect(shown()).toEqual(EVERYTHING);

    await app.user.clear(filter());
    await app.user.type(filter(), '...');
    expect(shown()).toEqual(EVERYTHING);
  });

  it('keeps the unread number of a folder whole while only some of its feeds are shown', async () => {
    const { app } = await openFeeds([
      feed('1', 'The Verge', 'Tech', { unread: { forYou: 1, maybe: 2, everything: 3, new: 4 } }),
      feed('2', 'Wired', 'Tech', { unread: { forYou: 5, maybe: 0, everything: 0, new: 0 } }),
    ]);
    expect(shown()).toEqual(['Tech Unread: 15', 'The Verge Unread: 10', 'Wired Unread: 5']);

    await app.user.type(filter(), 'wired');

    expect(shown()).toEqual(['Tech Unread: 15', 'Wired Unread: 5']);
  });

  it('says when no feed matches, where it is read out, and the feeds return with the field empty', async () => {
    const { app } = await openFeeds();
    const note = within(sidebar()).getByRole('status');
    expect(note).toBeEmptyDOMElement();

    await app.user.type(filter(), 'zzz');

    expect(within(sidebar()).getByRole('status')).toBe(note);
    expect(note).toHaveTextContent('No feeds match your filter.');
    expect(feedsList()).toBeNull();
    expect(within(sidebar()).queryByText('No feeds yet.')).toBeNull();
    expect(filter()).toHaveValue('zzz');

    await app.user.clear(filter());

    expect(note).toBeEmptyDOMElement();
    expect(shown()).toEqual(EVERYTHING);
  });

  it('is cleared by Escape, and the focus stays in the field', async () => {
    const { app } = await openFeeds();
    await app.user.type(filter(), 'zzz');
    expect(within(sidebar()).getByRole('status')).toHaveTextContent('No feeds match');

    await app.user.keyboard('{Escape}');

    expect(filter()).toHaveValue('');
    expect(filter()).toHaveFocus();
    expect(within(sidebar()).getByRole('status')).toBeEmptyDOMElement();
    expect(shown()).toEqual(EVERYTHING);
  });

  it('leaves Escape alone when there is nothing to clear', async () => {
    const { app } = await openFeeds();
    await app.user.click(filter());

    expect(fireEvent.keyDown(filter(), { key: 'Escape' })).toBe(true);

    expect(filter()).toHaveFocus();
  });

  it('is still there, with what was typed, when the reader goes to a feed', async () => {
    const { app } = await openFeeds();
    await app.user.type(filter(), 'verge');

    await app.user.click(screen.getByRole('link', { name: 'The Verge' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/feed/1'));
    expect(await screen.findByRole('textbox', { name: 'Filter feeds' })).toHaveValue('verge');
    expect(shown()).toEqual(['Tech', 'The Verge']);
  });

  it('is not offered when there are no feeds, and then the / key is left to the browser', async () => {
    const { app, state } = await openFeeds([feed('1', 'Verge')]);
    expect(filter()).toBeInTheDocument();

    state.subscriptions = [];
    await app.queryClient.invalidateQueries({ queryKey: accountKey(USER_A_ID, 'subscriptions') });

    expect(await within(sidebar()).findByText('No feeds yet.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Filter feeds' })).toBeNull();
    expect(fireEvent.keyDown(document.body, { key: '/' })).toBe(true);
  });

  it('is in Slovak for a Slovak reader', async () => {
    const { app } = await openFeeds(FEEDS, { language: 'sk' });
    const field = screen.getByRole('textbox', { name: 'Filtrovať zdroje' });
    expect(field).toHaveAttribute('aria-keyshortcuts', '/');

    await app.user.type(field, 'zzz');

    const navigation = screen.getByRole('navigation', { name: 'Navigácia čítačky' });
    expect(within(navigation).getByRole('status')).toHaveTextContent(
      'Filtru nezodpovedá žiadny zdroj.',
    );
    await app.user.clear(field);
    await app.user.type(field, 'SPRAVY');
    expect(
      within(screen.getByRole('list', { name: 'Zdroje' }))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['News', 'Správy SME']);
  });
});
