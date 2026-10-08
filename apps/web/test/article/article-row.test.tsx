import type { ArticleListItem, TopReason } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { failure } from '../api/fake-fetch.js';
import { acked } from '../reader/actions/fake-transport.js';
import {
  actionResponse,
  bodyOf,
  deferred,
  findToast,
  labelRoute,
  makeItem,
  makeLabel,
  ratingResponse,
  renderReader,
  type ReaderHarnessOptions,
} from './harness.js';

const TITLE = 'Solid-state batteries reach the pilot line';
const NOW = new Date('2026-05-31T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

function renderRow(
  item: ArticleListItem,
  props: Partial<ComponentProps<typeof ArticleRow>> = {},
  options: ReaderHarnessOptions = {},
) {
  const onToggleExpand = vi.fn();
  const view = renderReader(
    <ArticleRow
      item={item}
      expanded={false}
      onToggleExpand={onToggleExpand}
      simple={false}
      {...props}
    />,
    options,
  );
  return { ...view, onToggleExpand };
}

const row = () => screen.getByRole('article', { name: TITLE });

describe('ArticleRow content', () => {
  it('shows the title, the feed, the relative time and the excerpt', () => {
    renderRow(makeItem());
    expect(within(row()).getByText('Example Weekly')).toBeInTheDocument();
    const time = within(row()).getByText('2 hours ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-05-31T08:00:00.000Z');
    expect(within(row()).getByText('A short excerpt.')).toBeInTheDocument();
  });

  it('falls back to the arrival time of an article without a publication date', () => {
    renderRow(makeItem({ publishedAt: null, firstSeenAt: '2026-05-31T09:30:00.000Z' }));
    const time = within(row()).getByText('30 minutes ago');
    expect(time).toHaveAttribute('datetime', '2026-05-31T09:30:00.000Z');
  });

  it('shows a row without excerpt, author or feed without broken pieces', () => {
    renderRow(makeItem({ excerpt: null, author: null, feed: null, url: null }));
    expect(within(row()).getByRole('button', { name: TITLE })).toBeInTheDocument();
    expect(within(row()).queryByRole('link')).toBeNull();
    expect(within(row()).getByText('2 hours ago')).toBeInTheDocument();
  });

  it('hides the excerpt in Simple mode and keeps the rest', () => {
    renderRow(makeItem(), { simple: true });
    expect(screen.queryByText('A short excerpt.')).toBeNull();
    expect(within(row()).getByText('Example Weekly')).toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Like' })).toBeInTheDocument();
  });

  it('marks unread and read rows with text, not only with colour', () => {
    const unread = renderRow(makeItem());
    expect(within(row()).getByText('Unread')).toBeInTheDocument();
    expect(within(row()).queryByText('Read')).toBeNull();
    unread.unmount();

    renderRow(makeItem({ readAt: '2026-05-31T09:00:00.000Z' }));
    expect(within(row()).getByText('Read')).toBeInTheDocument();
    expect(within(row()).queryByText('Unread')).toBeNull();
  });

  it('marks translated articles', () => {
    const plain = renderRow(makeItem());
    expect(screen.queryByText('Translated')).toBeNull();
    plain.unmount();

    renderRow(makeItem({ translationAvailable: true }));
    expect(screen.getByText('Translated')).toBeInTheDocument();
  });

  it.each([
    ['not_requested', true],
    ['pending', false],
    ['running', false],
    ['complete', false],
    ['failed', false],
    ['cancelled', false],
  ] as const)('analysis status %s shows "Not analyzed": %s', (status, shown) => {
    renderRow(makeItem({ analysis: { mode: 'off', status, requestId: null } }));
    expect(screen.queryByText('Not analyzed') !== null).toBe(shown);
  });

  it('asks to toggle when the title is pressed', async () => {
    const { user, onToggleExpand } = renderRow(makeItem());
    const title = screen.getByRole('button', { name: TITLE });
    expect(title).toHaveAttribute('aria-expanded', 'false');
    await user.click(title);
    expect(onToggleExpand).toHaveBeenCalledOnce();
  });

  it('exposes the expanded state', () => {
    renderRow(makeItem(), { expanded: true });
    expect(screen.getByRole('button', { name: TITLE })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a selection checkbox only when one is given', async () => {
    const without = renderRow(makeItem());
    expect(screen.queryByRole('checkbox')).toBeNull();
    without.unmount();

    const onChange = vi.fn();
    const { user } = renderRow(makeItem(), { selection: { selected: false, onChange } });
    const box = screen.getByRole('checkbox', { name: `Select ${TITLE}` });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('shows a selected row as checked', () => {
    renderRow(makeItem(), { selection: { selected: true, onChange: vi.fn() } });
    expect(screen.getByRole('checkbox', { name: `Select ${TITLE}` })).toBeChecked();
  });
});

describe('ArticleRow images', () => {
  const allowed = {
    effectiveImagesAllowed: true,
    imageUrl: 'https://cdn.test/thumb.jpg',
    feed: { id: '7', title: 'Example Weekly', iconUrl: 'https://cdn.test/icon.png' },
  } as const;

  it('requests no image while images are not allowed', () => {
    renderRow(makeItem({ ...allowed, effectiveImagesAllowed: false }));
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows a lazy thumbnail and the feed icon once they are allowed', () => {
    renderRow(makeItem(allowed));
    for (const src of ['https://cdn.test/thumb.jpg', 'https://cdn.test/icon.png']) {
      const image = document.querySelector(`img[src="${src}"]`);
      expect(image, src).not.toBeNull();
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(image).toHaveAttribute('alt', '');
    }
  });

  it('shows neither when the article has no image and the feed no icon', () => {
    renderRow(
      makeItem({
        effectiveImagesAllowed: true,
        imageUrl: null,
        feed: { id: '7', title: 'Example Weekly', iconUrl: null },
      }),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(within(row()).getByText('Example Weekly')).toBeInTheDocument();
  });

  it.each(['data:image/png;base64,AAAA', 'javascript:alert(1)', '/thumb.jpg', '//cdn.test/t.jpg'])(
    'does not load the image address %s',
    (imageUrl) => {
      renderRow(makeItem({ ...allowed, imageUrl, feed: null }));
      expect(document.querySelector('img')).toBeNull();
    },
  );
});

const RULES: [string, string, string][] = [
  ['must:31', 'Matches a must-see interest', 'Zhoduje sa so záujmom „musím vidieť“'],
  ['never:31', 'Hidden by a never-show interest', 'Skryté záujmom „nikdy nezobrazovať“'],
  ['never_soft:31', 'Held back by a never-show interest', 'Potlačené záujmom „nikdy nezobrazovať“'],
  ['mute_keyword:tariffs', 'Muted keyword: “tariffs”', 'Stlmené kľúčové slovo: „tariffs“'],
  ['mute_story', 'Muted story', 'Stlmený príbeh'],
  ['block_feed', 'Blocked source', 'Blokovaný zdroj'],
  ['block_domain', 'Blocked website', 'Blokovaný web'],
  ['block_author', 'Blocked author', 'Blokovaný autor'],
  ['boost_feed', 'Boosted source', 'Uprednostnený zdroj'],
  ['boost_domain', 'Boosted website', 'Uprednostnený web'],
  ['demote:clickbait', 'Demoted: clickbait', 'Znížená priorita: klikbajt'],
  ['demote:promotional', 'Demoted: promotional', 'Znížená priorita: reklama'],
  ['demote:shallow', 'Demoted: shallow', 'Znížená priorita: povrchné'],
  ['demote:stale', 'Demoted: outdated', 'Znížená priorita: zastarané'],
  [
    'degraded',
    'Keyword match (model unavailable)',
    'Zhoda s kľúčovými slovami (model nie je dostupný)',
  ],
  ['llm_answer', 'Judged by AI', 'Posúdené umelou inteligenciou'],
  ['seen_story', 'Story already seen', 'Príbeh ste už videli'],
  ['pending_cards', 'Interests still being matched', 'Záujmy sa ešte vyhodnocujú'],
  ['inference_not_requested', 'Not analyzed', 'Neanalyzované'],
  ['something_new', 'Ranking rule', 'Pravidlo zoradenia'],
];

const REASONS: [string, TopReason, string, string][] = [
  [
    'card',
    { kind: 'card', cardId: '31', title: 'EV battery tech', p: 0.91 },
    'EV battery tech · 0.91',
    'EV battery tech · 0,91',
  ],
  [
    'card with a round probability',
    { kind: 'card', cardId: '31', title: 'Space', p: 0.9 },
    'Space · 0.90',
    'Space · 0,90',
  ],
  [
    'model',
    { kind: 'model', feature: 'tok:battery', label: 'battery' },
    'Model: battery',
    'Model: battery',
  ],
  [
    'keyword',
    { kind: 'keyword' },
    'Keyword match (model unavailable)',
    'Zhoda s kľúčovými slovami (model nie je dostupný)',
  ],
  ...RULES.map(([code, en, sk]): [string, TopReason, string, string] => [
    `rule ${code}`,
    { kind: 'rule', code },
    en,
    sk,
  ]),
  [
    'rule with a rule id',
    { kind: 'rule', code: 'block_feed', ruleId: '55' },
    'Blocked source',
    'Blokovaný zdroj',
  ],
];

describe.each(['en', 'sk'] as const)('ArticleRow reason chip in %s', (language) => {
  it.each(REASONS)('renders the reason: %s', (_name, topReason, en, sk) => {
    renderRow(
      makeItem({ topReason, analysis: { mode: 'active', status: 'complete', requestId: null } }),
      {},
      { language },
    );
    expect(screen.getByText(language === 'en' ? en : sk)).toBeInTheDocument();
  });
});

describe('ArticleRow reason chip', () => {
  it('is plain text without a "Why this?" handler and a button with one', async () => {
    const plain = renderRow(makeItem());
    expect(screen.getByText('EV battery tech · 0.82')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'EV battery tech · 0.82' })).toBeNull();
    plain.unmount();

    const onWhyThis = vi.fn();
    const { user } = renderRow(makeItem(), { onWhyThis });
    await user.click(screen.getByRole('button', { name: 'EV battery tech · 0.82' }));
    expect(onWhyThis).toHaveBeenCalledOnce();
  });

  it('is absent for an article without a reason', () => {
    renderRow(makeItem({ topReason: null, pLike: null, tier: null, lane: 'new' }), {
      onWhyThis: vi.fn(),
    });
    expect(screen.queryByText(/·/)).toBeNull();
  });
});

describe('ArticleRow labels', () => {
  const labels = [
    makeLabel('11', 'Politics', '#ef4444'),
    makeLabel('12', 'Sports'),
    makeLabel('13', 'Science'),
  ];

  it('lists the labels of the article and offers the suggested ones as chips', async () => {
    renderRow(
      makeItem({ labelIds: ['11'], labelSuggestions: ['12', '11', '99'] }),
      {},
      {
        routes: labelRoute(...labels),
      },
    );
    const list = await screen.findByRole('list', { name: 'Labels' });
    expect(within(list).getByText('Politics')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Add label Sports' })).toBeInTheDocument();
    expect(within(list).queryByText('Science')).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Add label Politics' })).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows no label list without labels or suggestions', () => {
    renderRow(makeItem(), {}, { routes: labelRoute(...labels) });
    expect(screen.queryByRole('list', { name: 'Labels' })).toBeNull();
  });

  it('asks for the labels only when an article has labels or suggestions', async () => {
    const none = renderRow(makeItem(), {}, { routes: labelRoute(...labels) });
    await none.user.click(screen.getByRole('button', { name: 'Like' }));
    expect(none.calls('GET', '/labels')).toHaveLength(0);
  });

  it('adds the label at once when a suggestion is tapped', async () => {
    const item = makeItem({ labelSuggestions: ['12'] });
    const answer = deferred<Response>();
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: { ...labelRoute(...labels), 'POST /articles/:id/labels': () => answer.promise },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Add label Sports' }));

    expect(bodyOf(calls('POST', '/articles/101/labels')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      labelId: '12',
    });
    expect(screen.queryByRole('button', { name: 'Add label Sports' })).toBeNull();
    expect(
      within(screen.getByRole('list', { name: 'Labels' })).getByText('Sports'),
    ).toBeInTheDocument();

    answer.resolve(actionResponse(acked(item, { labelIds: ['12'] })));
    await waitFor(() => expect(screen.getByText('Sports')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Add label Sports' })).toBeNull();
  });
});

describe('ArticleRow cluster badge', () => {
  it('counts the other sources and expands to name them', async () => {
    const cluster = { id: '9', size: 4, otherFeeds: ['Feed A', 'Feed B', 'Feed C'] };
    const { user } = renderRow(makeItem({ cluster }));
    const badge = screen.getByRole('button', { name: '+3 sources' });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Feed A')).toBeNull();

    await user.click(badge);

    expect(badge).toHaveAttribute('aria-expanded', 'true');
    const feeds = screen.getByRole('list', { name: 'Also reported by' });
    expect(
      within(feeds)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Feed A', 'Feed B', 'Feed C']);

    await user.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Feed A')).toBeNull();
  });

  it('uses the singular for one other source', () => {
    renderRow(makeItem({ cluster: { id: '9', size: 2, otherFeeds: ['Feed A'] } }));
    expect(screen.getByRole('button', { name: '+1 source' })).toBeInTheDocument();
  });

  it('has no badge for an article that is not clustered', () => {
    renderRow(makeItem({ cluster: null }));
    expect(screen.queryByRole('button', { name: /source/ })).toBeNull();
  });

  it.each([
    [2, '+1 zdroj'],
    [4, '+3 zdroje'],
    [6, '+5 zdrojov'],
  ])('uses the Slovak plural for a cluster of %s', (size, name) => {
    renderRow(
      makeItem({ cluster: { id: '9', size, otherFeeds: ['Feed A'] } }),
      {},
      {
        language: 'sk',
      },
    );
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });
});

describe('ArticleRow rating and bookmark', () => {
  it.each([
    [null, 'false', 'false'],
    [1, 'true', 'false'],
    [-1, 'false', 'true'],
  ] as const)('shows rating %s as pressed buttons', (rating, like, dislike) => {
    renderRow(makeItem({ rating }));
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', like);
    expect(screen.getByRole('button', { name: 'Dislike' })).toHaveAttribute(
      'aria-pressed',
      dislike,
    );
  });

  it('shows a bookmarked article as pressed', () => {
    const plain = renderRow(makeItem());
    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    plain.unmount();

    renderRow(makeItem({ bookmarkedAt: '2026-05-31T09:00:00.000Z' }));
    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('likes at once, with the fence of the displayed state', async () => {
    const item = makeItem();
    const answer = deferred<Response>();
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: { 'POST /articles/:id/rating': () => answer.promise },
      },
    );

    await user.click(screen.getByRole('button', { name: 'Like' }));

    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
    });

    answer.resolve(ratingResponse(acked(item, { rating: 1, readAt: '2026-05-31T10:00:00.000Z' })));
    await findToast('Marked as liked');
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('dislikes without a reason', async () => {
    const item = makeItem();
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: -1 })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Dislike' }));
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
    });
    expect(screen.getByRole('button', { name: 'Dislike' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('un-rates when the same direction is pressed again', async () => {
    const item = makeItem({ rating: 1 });
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: null })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Like' }));
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false');
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: null,
    });
  });

  it('sends the analysis request of the article with a rating', async () => {
    const requestId = '3f1c2b64-8a5e-4c63-9f0e-5d7a9b1c2e30';
    const item = makeItem({ analysis: { mode: 'training', status: 'pending', requestId } });
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: 1 })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Like' }));
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
      analysisRequestId: requestId,
    });
  });

  it('bookmarks into the feed the reader is looking at', async () => {
    const item = makeItem();
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/bookmark': () =>
            actionResponse(acked(item, { bookmarkedAt: '2026-05-31T10:00:00.000Z' })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(bodyOf(calls('POST', '/articles/101/bookmark')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      mediaPolicyFeedId: '7',
    });
  });

  it('bookmarks without a feed when the article has none', async () => {
    const item = makeItem({ feed: null });
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/bookmark': () =>
            actionResponse(acked(item, { bookmarkedAt: '2026-05-31T10:00:00.000Z' })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    expect(bodyOf(calls('POST', '/articles/101/bookmark')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
    });
  });

  it('removes a bookmark with the fence in the query string', async () => {
    const item = makeItem({ bookmarkedAt: '2026-05-30T09:00:00.000Z' });
    const { user, calls } = renderRow(
      item,
      {},
      {
        routes: {
          'DELETE /articles/:id/bookmark': () =>
            actionResponse(acked(item, { bookmarkedAt: null })),
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(Object.fromEntries(calls('DELETE', '/articles/101/bookmark')[0]!.query)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
    });
  });

  it('rolls a rating the server refused back and offers a retry', async () => {
    const { user } = renderRow(
      makeItem(),
      {},
      {
        routes: { 'POST /articles/:id/rating': () => failure(400, 'VALIDATION_FAILED') },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Like' }));

    const toast = await findToast("Couldn't save — retry");
    expect(within(toast).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Unread')).toBeInTheDocument();
  });
});

describe('ArticleRow in Slovak', () => {
  it('speaks Slovak', () => {
    renderRow(makeItem({ translationAvailable: true }), {}, { language: 'sk' });
    expect(screen.getByRole('button', { name: 'Páči sa mi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nepáči sa mi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Záložka' })).toBeInTheDocument();
    expect(screen.getByText('pred 2 hodinami')).toBeInTheDocument();
    expect(screen.getByText('Neprečítané')).toBeInTheDocument();
    expect(screen.getByText('Preložené')).toBeInTheDocument();
    expect(screen.getByText('Neanalyzované')).toBeInTheDocument();
  });

  it('names a suggested label in Slovak', async () => {
    renderRow(
      makeItem({ labelSuggestions: ['12'] }),
      {},
      {
        language: 'sk',
        routes: labelRoute(makeLabel('12', 'Šport')),
      },
    );
    expect(await screen.findByRole('button', { name: 'Pridať štítok Šport' })).toBeInTheDocument();
  });
});
