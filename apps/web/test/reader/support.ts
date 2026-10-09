import type {
  ArticleCounts,
  ArticleListItem,
  ArticleListResponse,
  LabelDto,
  Me,
  Subscription,
} from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { actionResponse, makeDetail, ratingResponse } from '../article/harness.js';
import { createHarness } from '../auth/harness.js';
import { patchMeLikeTheApi } from '../feeds/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler, type FakeServer } from '../support/app.js';
import { acked, makeItem } from './actions/fake-transport.js';

export const AS_OF = '2026-05-31T10:00:00.000Z';

export const COUNTS: ArticleCounts = {
  forYou: 3,
  maybe: 4,
  everything: 12,
  new: 5,
  bookmarks: 2,
  hidden: 1,
  scored: 19,
  total: 24,
  asOf: AS_OF,
  datasetVersion: 'd-counts',
  rankingPending: false,
};

/** An unread article whose id and title name it: "Article 7". */
export function item(id: number | string, overrides: Partial<ArticleListItem> = {}) {
  return makeItem({
    id: String(id),
    title: `Article ${id}`,
    url: `https://example.test/articles/${id}`,
    excerpt: `Excerpt of article ${id}`,
    ...overrides,
  });
}

export function page(
  items: readonly ArticleListItem[],
  overrides: Partial<ArticleListResponse> = {},
): ArticleListResponse {
  return {
    items: [...items],
    nextCursor: null,
    asOf: AS_OF,
    datasetVersion: 'd-list',
    rankingPending: false,
    ...overrides,
  };
}

export interface ReaderState {
  counts: ArticleCounts;
  items: ArticleListItem[];
  subscriptions: Subscription[];
  labels: LabelDto[];
}

export interface ReaderOptions {
  path: string;
  me?: Me;
  /** Whether the viewport is 1024 px or wider; the default. */
  desktop?: boolean;
  counts?: Partial<ArticleCounts>;
  /** What `GET /articles` answers as its one and only page. */
  items?: ArticleListItem[];
  subscriptions?: Subscription[];
  labels?: LabelDto[];
  /** Replaces `GET /articles`. */
  list?: ApiRouteHandler;
  /** Replaces or adds operations. */
  routes?: Record<string, ApiRouteHandler>;
}

/**
 * A fake API for the reader. `state` is what the default handlers answer with, so a test can change
 * the answer of the next request by changing it. Operations are keyed so that `GET /articles/counts`
 * is tried before `GET /articles/:id`.
 */
export function readerServer(options: ReaderOptions) {
  const state: ReaderState = {
    counts: { ...COUNTS, ...options.counts },
    items: options.items ?? [],
    subscriptions: options.subscriptions ?? [],
    labels: options.labels ?? [],
  };
  /** The articles a write touched, as the server now holds them. */
  const written = new Map<string, ArticleListItem>();
  const known = (id: string | undefined) =>
    written.get(id ?? '') ??
    state.items.find((candidate) => candidate.id === id) ??
    item(id ?? '0');
  const write = (id: string | undefined, patch: Partial<ArticleListItem>) => {
    const next = acked(known(id), patch);
    written.set(next.id, next);
    return next;
  };
  const server: FakeServer = { me: options.me ?? makeMe(), routes: {} };
  server.routes = {
    'GET /articles/counts': (request) => {
      const asOf = request.query.get('asOf');
      return json(200, { ...state.counts, ...(asOf === null ? {} : { asOf }) });
    },
    'GET /articles': options.list ?? (() => json(200, page(state.items))),
    'GET /articles/:id': (_request, params) => json(200, makeDetail(known(params['id']))),
    'GET /subscriptions': () => json(200, state.subscriptions),
    'GET /labels': () => json(200, state.labels),
    'PATCH /me': patchMeLikeTheApi(server),
    'POST /articles/:id/read': (_request, params) =>
      actionResponse(write(params['id'], { readAt: AS_OF })),
    'POST /articles/:id/rating': (request, params) => {
      const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
      return ratingResponse(write(params['id'], { rating, readAt: AS_OF }));
    },
    ...options.routes,
  };
  return { server, state };
}

/** Makes `(min-width: 1024px)` match, or not; the app's other media queries never match. */
export function setDesktop(desktop: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: desktop && /min-width:\s*1024px/.test(query),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
}

/**
 * Boots the app on a reader route against `readerServer`, and, after each test, checks that the
 * reader asked for nothing the fake API does not handle. Call it once at the top of a test file.
 */
export function createReaderHarness() {
  const harness = createHarness();
  return {
    async open(options: ReaderOptions) {
      const { server, state } = readerServer(options);
      setDesktop(options.desktop ?? true);
      const app = await harness.open({ path: options.path, server });
      return { app, state, server };
    },
  };
}

type App = Awaited<ReturnType<ReturnType<typeof createReaderHarness>['open']>>['app'];

/** The query strings of the requests of one operation, oldest first. */
export function queriesOf(app: App, operation: string): Record<string, string>[] {
  return app.calls(operation).map((request) => Object.fromEntries(request.query));
}

export const listQueries = (app: App) => queriesOf(app, 'GET /articles');
export const countsQueries = (app: App) => queriesOf(app, 'GET /articles/counts');

/** The requests for the detail of one article; `/articles/:id` also matches `/articles/counts`. */
export const detailCalls = (app: App) =>
  app.calls('GET /articles/:id').filter((request) => !request.pathname.endsWith('/counts'));

/** The titles of the rows of the list, top to bottom. */
export function rowTitles(): string[] {
  return screen
    .queryAllByRole('article')
    .map((row) => within(row).getByRole('heading', { level: 3 }).textContent ?? '');
}

/** The row showing `title`. */
export function rowOf(title: string): HTMLElement {
  return screen.getByRole('article', { name: title });
}

export const sidebar = () => screen.getByRole('navigation', { name: 'Reader navigation' });
