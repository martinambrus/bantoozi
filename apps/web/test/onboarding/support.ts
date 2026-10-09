import type {
  AnalyzeBody,
  AnalyzeResponse,
  ArticleCounts,
  ArticleListItem,
  CardDto,
  InferenceChange,
  LibraryCardDto,
  Me,
  Subscription,
} from '@bantoozi/shared';
import { screen } from '@testing-library/react';
import { expect } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { failure, json, noContent } from '../api/fake-fetch.js';
import { makeItem, ratingResponse } from '../article/harness.js';
import { READER_READS } from '../auth/harness.js';
import {
  makeSubscription,
  patchMeLikeTheApi,
  type SubscriptionOverrides,
} from '../feeds/support.js';
import { TOPICS, cardResult, makeCard, makeLibraryCard } from '../interests/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler, type FakeServer } from '../support/app.js';

export const NOW = '2026-10-08T12:00:00.000Z';

/** An account that has not finished the wizard. */
export function newcomer(): Me {
  return makeMe({ preferences: { onboardingCompletedAt: null } });
}

export function feed(
  id: string,
  title: string,
  overrides: SubscriptionOverrides = {},
): Subscription {
  return makeSubscription({ ...overrides, feed: { id, title, ...overrides.feed } });
}

/** A neutral article of the feed shown in the lists: new, unscored and not requested. */
export function article(
  id: string,
  title: string,
  overrides: Partial<ArticleListItem> = {},
): ArticleListItem {
  return makeItem({
    id,
    title,
    url: `https://example.test/articles/${id}`,
    feed: { id: '1', title: 'Feed 1', iconUrl: null },
    lane: 'new',
    tier: null,
    pLike: null,
    topReason: null,
    stateVersion: '0',
    contentRevision: '1',
    analysis: { mode: 'off', status: 'not_requested', requestId: null },
    ...overrides,
  });
}

/** Articles `from`…`to` titled "Article n". */
export function articles(from: number, to: number): ArticleListItem[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) =>
    article(String(from + index), `Article ${from + index}`),
  );
}

export function counts(overrides: Partial<ArticleCounts> = {}): ArticleCounts {
  return {
    forYou: 0,
    maybe: 0,
    everything: 0,
    new: 0,
    bookmarks: 0,
    hidden: 0,
    scored: 0,
    total: 0,
    asOf: NOW,
    datasetVersion: 'd1',
    rankingPending: false,
    ...overrides,
  };
}

/** A request id the fake API gives to the n-th analysis request. */
export function requestId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const battery = makeLibraryCard();
export const rust = makeLibraryCard({
  id: '502',
  slug: 'rust-lang',
  title: 'Rust programming',
  interest: 'The Rust programming language',
  notFor: null,
  topicIds: ['technology.software_dev'],
  l1TopicId: 'technology',
});
export const space = makeLibraryCard({
  id: '503',
  slug: 'space-launches',
  title: 'Space launches',
  interest: 'Rocket launches and spacecraft missions',
  notFor: null,
  topicIds: [],
  l1TopicId: 'science',
});

export type RequestStatus = AnalyzeResponse['requests'][number]['status'];

export interface WizardState {
  subscriptions: Subscription[];
  cards: CardDto[];
  library: LibraryCardDto[];
  /** What `GET /articles?feedId=` answers, by feed id. */
  articles: Record<string, ArticleListItem[]>;
  /** What `GET /articles/counts` answers without a `feedId`. */
  counts: ArticleCounts;
  /** What `GET /articles/counts?feedId=` answers, by feed id. */
  feedCounts: Record<string, ArticleCounts>;
  /** What `GET /articles/calibration` answers. */
  calibration: ArticleListItem[];
  /** The status the fake API gives an analysis request when it is made. */
  requestStatus: RequestStatus;
}

export interface WizardOptions extends Partial<WizardState> {
  me?: Me;
  routes?: Record<string, ApiRouteHandler>;
}

/** The article with this analysis status, requested by `requestId` unless it has none. */
export function withAnalysis(
  item: ArticleListItem,
  mode: ArticleListItem['analysis']['mode'],
  status: ArticleListItem['analysis']['status'],
  request: string | null = null,
): ArticleListItem {
  return makeItem({ ...item, analysis: { mode, status, requestId: request } });
}

/** The answer of `GET /articles` with these items on its only page. */
export function listResponse(items: ArticleListItem[]) {
  return json(200, {
    items,
    nextCursor: null,
    asOf: NOW,
    datasetVersion: 'd1',
    rankingPending: false,
  });
}

/** The subscription of `feedId` in another classification mode, at the next inference version. */
export function switchMode(
  state: WizardState,
  feedId: string,
  mode: Subscription['inferenceMode'],
): Subscription | undefined {
  const index = state.subscriptions.findIndex((candidate) => candidate.feed.id === feedId);
  const current = state.subscriptions[index];
  if (current === undefined) return undefined;
  const next: Subscription = {
    ...current,
    inferenceMode: mode,
    inferenceVersion: String(BigInt(current.inferenceVersion) + 1n),
  };
  state.subscriptions[index] = next;
  return next;
}

/** Gives the articles `ids` of the feed this analysis status, as the worker does while it runs. */
export function setStatus(
  state: WizardState,
  feedId: string,
  ids: readonly string[],
  status: RequestStatus,
): void {
  const mode = state.subscriptions.find((candidate) => candidate.feed.id === feedId)?.inferenceMode;
  state.articles[feedId] = (state.articles[feedId] ?? []).map((item) =>
    ids.includes(item.id)
      ? withAnalysis(item, mode ?? 'training', status, requestId(Number(item.id)))
      : item,
  );
}

/**
 * `POST /subscriptions/:feedId/analyze` as the API does it: an off feed turns to training with
 * `startTraining`, and the selected articles of the feed take the status `state.requestStatus`.
 */
function analyzeRoute(state: WizardState): ApiRouteHandler {
  return (request, params) => {
    const body = bodyOf(request) as AnalyzeBody;
    const feedId = params['feedId'] ?? '';
    const subscription = state.subscriptions.find((candidate) => candidate.feed.id === feedId);
    if (subscription === undefined) return failure(404, 'NOT_FOUND');
    if (body.startTraining === true && subscription.inferenceMode === 'off') {
      switchMode(state, feedId, 'training');
    }
    const status = state.requestStatus;
    setStatus(
      state,
      feedId,
      body.articles.map((selected) => selected.id),
      status,
    );
    return json(202, {
      requests: body.articles.map((selected) => ({
        id: requestId(Number(selected.id)),
        articleId: selected.id,
        status,
      })),
    });
  };
}

/** `POST /subscriptions/:feedId/inference`: the mode changes and the inference version moves on. */
function inferenceRoute(state: WizardState): ApiRouteHandler {
  return (request, params) => {
    const { mode } = bodyOf(request) as InferenceChange;
    const subscription = switchMode(state, params['feedId'] ?? '', mode);
    return subscription === undefined ? failure(404, 'NOT_FOUND') : json(200, { subscription });
  };
}

/**
 * A fake API for the wizard. `state` is what the reads answer, so a handler (or a test) that changes
 * it changes the next answer; `routes` adds or replaces operations.
 */
export function wizardServer(options: WizardOptions = {}) {
  const state: WizardState = {
    subscriptions: options.subscriptions ?? [],
    cards: options.cards ?? [],
    library: options.library ?? [],
    articles: options.articles ?? {},
    counts: options.counts ?? counts(),
    feedCounts: options.feedCounts ?? {},
    calibration: options.calibration ?? [],
    requestStatus: options.requestStatus ?? 'pending',
  };
  const server: FakeServer = { me: options.me ?? newcomer(), routes: {} };
  let nextFeed = 100;
  let nextCard = 900;

  server.routes = {
    // The wizard ends on the reader, which reads its own data.
    ...READER_READS,
    'GET /subscriptions': () => json(200, state.subscriptions),
    'POST /subscriptions': (request) => {
      const { url } = bodyOf(request) as { url: string };
      const existing = state.subscriptions.find((subscription) => subscription.feed.url === url);
      if (existing !== undefined) return json(200, { subscription: existing });
      nextFeed += 1;
      const subscription = makeSubscription({
        feed: { id: String(nextFeed), url, title: new URL(url).hostname },
      });
      state.subscriptions.push(subscription);
      return json(201, { subscription });
    },
    'GET /cards': () => json(200, state.cards),
    'GET /topics': () => json(200, TOPICS),
    'GET /library': () =>
      json(200, {
        items: state.library.map((card) => ({
          ...card,
          held: state.cards.some((held) => held.id === card.id),
        })),
        nextCursor: null,
      }),
    'POST /library/:id/adopt': (request, params) => {
      const { strength } = bodyOf(request) as { strength: CardDto['strength'] };
      const library = state.library.find((card) => card.id === params['id']);
      if (library === undefined) return failure(404, 'NOT_FOUND');
      if (state.cards.some((held) => held.id === library.id)) {
        return failure(409, 'CONFLICT', { reason: 'already_held' });
      }
      const card = makeCard({
        id: library.id,
        title: library.title,
        interest: library.interest,
        strength,
        origin: 'library',
        librarySlug: library.slug,
        topicIds: library.topicIds,
      });
      state.cards.push(card);
      return json(200, cardResult(card));
    },
    'DELETE /cards/:id': (_request, params) => {
      state.cards = state.cards.filter((card) => card.id !== params['id']);
      return noContent();
    },
    'POST /cards': (request) => {
      const body = bodyOf(request) as { interest: string; strength: CardDto['strength'] };
      nextCard += 1;
      const card = makeCard({
        id: String(nextCard),
        title: body.interest,
        interest: body.interest,
        strength: body.strength,
      });
      state.cards.push(card);
      return json(201, cardResult(card));
    },
    'PATCH /me': patchMeLikeTheApi(server),
    'GET /articles': (request) =>
      listResponse(state.articles[request.query.get('feedId') ?? ''] ?? []),
    'GET /articles/counts': (request) => {
      const feedId = request.query.get('feedId');
      return json(200, feedId === null ? state.counts : (state.feedCounts[feedId] ?? state.counts));
    },
    'POST /subscriptions/:feedId/analyze': analyzeRoute(state),
    'POST /subscriptions/:feedId/inference': inferenceRoute(state),
    'GET /articles/calibration': () => json(200, { items: state.calibration }),
    'POST /articles/:id/rating': (request, params) => {
      const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
      const item = state.calibration.find((candidate) => candidate.id === params['id']);
      if (item === undefined) return failure(404, 'NOT_FOUND');
      return ratingResponse(
        makeItem({ ...item, rating, stateVersion: String(BigInt(item.stateVersion) + 1n) }),
      );
    },
    ...options.routes,
  };
  return { server, state };
}

function expectUsable(control: HTMLElement, target: HTMLElement = control) {
  expect(control).toHaveAccessibleName();
  expect(target.className, control.outerHTML.slice(0, 120)).toContain('min-h-11');
  for (const token of FOCUS_RING.split(' ')) {
    expect(control.className, control.outerHTML.slice(0, 120)).toContain(token);
  }
}

/**
 * Every control on the screen has an accessible name, a 44 px target and a focus ring (spec 09 §1).
 * Answers how many controls it looked at, so a test can tell the screen was not empty.
 */
export function expectUsableControls(): number {
  const controls = [
    ...screen.queryAllByRole('button'),
    ...screen.queryAllByRole('link'),
    ...screen.queryAllByRole('combobox'),
    ...screen.queryAllByRole('textbox'),
  ];
  for (const control of controls) expectUsable(control);
  const boxes = screen.queryAllByRole('checkbox');
  for (const box of boxes) expectUsable(box, box.closest('label') ?? box);
  return controls.length + boxes.length;
}
