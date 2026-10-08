import { describe, expect, it } from 'vitest';

import {
  displayTitle,
  groupByFolder,
  moveFolderBy,
  moveFolderTo,
} from '../../src/features/feeds/folders.js';
import { feedIn, makeSubscription } from './support.js';

const names = (groups: ReturnType<typeof groupByFolder>) => groups.map((group) => group.name);

describe('groupByFolder', () => {
  it('returns no groups for no subscriptions', () => {
    expect(groupByFolder([], ['A'], 'en')).toEqual([]);
  });

  it('puts the folders of the saved order first, in that order', () => {
    const groups = groupByFolder(
      [feedIn('A', 'a', '1'), feedIn('B', 'b', '2'), feedIn('C', 'c', '3')],
      ['C', 'A', 'B'],
      'en',
    );

    expect(names(groups)).toEqual(['C', 'A', 'B']);
  });

  it('skips saved names without feeds and saved names that are repeated', () => {
    const groups = groupByFolder(
      [feedIn('A', 'a', '1'), feedIn('B', 'b', '2')],
      ['Gone', 'B', 'A', 'B', 'Gone'],
      'en',
    );

    expect(names(groups)).toEqual(['B', 'A']);
  });

  it('sorts folders that are not in the saved order alphabetically, ignoring case', () => {
    const groups = groupByFolder(
      [feedIn('Zeta', 'z', '1'), feedIn('alpha', 'a', '2'), feedIn('Beta', 'b', '3')],
      [],
      'en',
    );

    expect(names(groups)).toEqual(['alpha', 'Beta', 'Zeta']);
  });

  it('sorts them in the order of the language', () => {
    const subscriptions = [
      feedIn('Ibis', 'i', '1'),
      feedIn('Chlieb', 'c', '2'),
      feedIn('Hrad', 'h', '3'),
    ];

    expect(names(groupByFolder(subscriptions, [], 'en'))).toEqual(['Chlieb', 'Hrad', 'Ibis']);
    expect(names(groupByFolder(subscriptions, [], 'sk'))).toEqual(['Hrad', 'Chlieb', 'Ibis']);
  });

  it('puts the saved folders before the others and feeds without a folder last', () => {
    const groups = groupByFolder(
      [feedIn(null, 'loose', '1'), feedIn('Other', 'o', '2'), feedIn('Saved', 's', '3')],
      ['Saved'],
      'en',
    );

    expect(names(groups)).toEqual(['Saved', 'Other', null]);
    expect(groups[2]?.feeds.map((sub) => sub.feed.id)).toEqual(['1']);
  });

  it('sorts the feeds of a group by the title they are shown with', () => {
    const groups = groupByFolder(
      [
        makeSubscription({ feed: { id: '1', title: 'Zebra' }, folder: 'A' }),
        makeSubscription({ feed: { id: '2', title: 'Yak' }, folder: 'A', titleOverride: 'Ant' }),
        makeSubscription({ feed: { id: '3', title: 'bee' }, folder: 'A' }),
      ],
      [],
      'en',
    );

    expect(groups[0]?.feeds.map((sub) => sub.feed.id)).toEqual(['2', '3', '1']);
  });
});

describe('displayTitle', () => {
  it('prefers the override, then the feed title, then the address', () => {
    const feed = { id: '1', title: 'Feed', url: 'https://example.com/rss' };

    expect(displayTitle(makeSubscription({ feed, titleOverride: 'Mine' }))).toBe('Mine');
    expect(displayTitle(makeSubscription({ feed }))).toBe('Feed');
    expect(displayTitle(makeSubscription({ feed: { ...feed, title: null } }))).toBe(
      'https://example.com/rss',
    );
    expect(displayTitle(makeSubscription({ feed: { ...feed, title: '  ' } }))).toBe(
      'https://example.com/rss',
    );
  });
});

describe('moveFolderTo', () => {
  it.each([
    ['down the list', 'A', 'C', ['B', 'C', 'A']],
    ['up the list', 'C', 'A', ['C', 'A', 'B']],
    ['to the next place', 'A', 'B', ['B', 'A', 'C']],
    ['to the previous place', 'C', 'B', ['A', 'C', 'B']],
  ])('moves a folder %s to the place of the target', (_name, from, to, expected) => {
    expect(moveFolderTo(['A', 'B', 'C'], from as string, to as string)).toEqual(expected);
  });

  it('leaves the order alone for the same folder or an unknown one', () => {
    expect(moveFolderTo(['A', 'B'], 'A', 'A')).toEqual(['A', 'B']);
    expect(moveFolderTo(['A', 'B'], 'A', 'X')).toEqual(['A', 'B']);
    expect(moveFolderTo(['A', 'B'], 'X', 'A')).toEqual(['A', 'B']);
  });

  it('does not change the list it is given', () => {
    const order = ['A', 'B', 'C'];
    moveFolderTo(order, 'A', 'C');
    expect(order).toEqual(['A', 'B', 'C']);
  });
});

describe('moveFolderBy', () => {
  it('moves one place up or down', () => {
    expect(moveFolderBy(['A', 'B', 'C'], 'B', -1)).toEqual(['B', 'A', 'C']);
    expect(moveFolderBy(['A', 'B', 'C'], 'B', 1)).toEqual(['A', 'C', 'B']);
  });

  it('stays put at the ends of the list', () => {
    expect(moveFolderBy(['A', 'B', 'C'], 'A', -1)).toEqual(['A', 'B', 'C']);
    expect(moveFolderBy(['A', 'B', 'C'], 'C', 1)).toEqual(['A', 'B', 'C']);
  });
});
