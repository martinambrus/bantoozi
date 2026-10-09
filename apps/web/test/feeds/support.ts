import type { Me, Subscription } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';

import { json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler, type FakeServer } from '../support/app.js';

export const LIST = 'GET /subscriptions';
export const UPDATE_ME = 'PATCH /me';
export const RENAME = 'POST /subscriptions/folders/rename';
export const UPDATE_FEED = 'PATCH /subscriptions/:feedId';
export const SET_INFERENCE = 'POST /subscriptions/:feedId/inference';
export const DELETE_FEED = 'DELETE /subscriptions/:feedId';
export const CREATE = 'POST /subscriptions';
export const IMPORT_OPML = 'POST /subscriptions/import-opml';

export const HOUR_MS = 3_600_000;
export const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

type FeedOverrides = Partial<Subscription['feed']>;
export type SubscriptionOverrides = Partial<Omit<Subscription, 'feed'>> & {
  feed?: FeedOverrides;
};

/** A complete, schema-valid subscription; `feed.id` and the fields to look at are overridden. */
export function makeSubscription(overrides: SubscriptionOverrides = {}): Subscription {
  const { feed, ...rest } = overrides;
  const id = feed?.id ?? '1';
  return {
    feed: {
      id,
      url: `https://example.com/${id}.xml`,
      siteUrl: `https://example.com/${id}`,
      title: `Feed ${id}`,
      iconUrl: null,
      status: 'active',
      lastSuccessAt: ago(3 * HOUR_MS),
      lastErrorCode: null,
      lastErrorAt: null,
      ...feed,
    },
    titleOverride: null,
    folder: null,
    allowDuplicates: false,
    hidden: false,
    inferenceMode: 'off',
    inferenceVersion: '1',
    inferenceActivatedAt: null,
    imagePolicy: 'inherit',
    effectiveImagesAllowed: false,
    unread: { forYou: 0, maybe: 0, everything: 0, new: 0 },
    ...rest,
  };
}

/** A subscription named `title` in `folder`: the shape most tests need. */
export function feedIn(folder: string | null, title: string, id: string): Subscription {
  return makeSubscription({ feed: { id, title }, folder });
}

export interface FeedsServerOptions {
  subscriptions?: Subscription[];
  me?: Me;
  routes?: Record<string, ApiRouteHandler>;
}

/**
 * A fake API for the feeds screen. `state.subscriptions` is what `GET /subscriptions` answers, so a
 * handler that changes it makes the refetch after a mutation see the change.
 */
export function feedsServer(options: FeedsServerOptions = {}) {
  const state = { subscriptions: options.subscriptions ?? [] };
  const server: FakeServer = {
    me: options.me ?? makeMe(),
    routes: { [LIST]: () => json(200, state.subscriptions), ...options.routes },
  };
  return { server, state };
}

/** `PATCH /me` as the API does it: preference leaves are merged, the `folderOrder` array replaced. */
export function patchMeLikeTheApi(server: FakeServer): ApiRouteHandler {
  return (request) => {
    const { preferences } = bodyOf(request) as { preferences: Partial<Me['preferences']> };
    if (server.me === null) throw new Error('signed out');
    server.me = { ...server.me, preferences: { ...server.me.preferences, ...preferences } };
    return json(200, server.me);
  };
}

/** The folder names in the order the screen shows them. */
export function folderNames(): string[] {
  const list = screen.getByRole('list', { name: 'Folders' });
  return within(list)
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent ?? '');
}

/** The row of the feed shown as `title`. */
export function rowOf(title: string): HTMLElement {
  const row = screen.getByRole('heading', { level: 3, name: title }).closest('li');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
}

/** Waits for the list to load, then returns the row of the feed shown as `title`. */
export async function findRow(title: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 3, name: title });
  return rowOf(title);
}

/** Keys the screen keeps in localStorage for dismissed dead-feed notices. */
export function dismissalKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.includes('dead-feed'));
}
