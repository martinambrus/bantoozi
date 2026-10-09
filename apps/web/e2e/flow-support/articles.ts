import type { APIRequestContext } from '@playwright/test';

import { callJson } from '../support/api.js';

/**
 * What the HTTP API says about an account's articles once it has rated, bookmarked or analyzed them
 * (spec 08 §5.1). The scenarios check the screen against it, so both are looked at after every step.
 */

export interface ArticleState {
  id: string;
  title: string;
  lane: string;
  rating: 1 | -1 | null;
  reason: string | null;
  readAt: string | null;
  bookmarkedAt: string | null;
  archivedAt: string | null;
  analysis: {
    mode: 'off' | 'training' | 'active';
    status: 'not_requested' | 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
    requestId: string | null;
  };
}

/** Every article of the account the reader lists, read or not (`lane=all` leaves hidden ones out). */
export async function articleStates(user: APIRequestContext): Promise<ArticleState[]> {
  const list = await callJson<{ items: ArticleState[] }>(user, 'GET', '/api/v1/articles', {
    params: { lane: 'all', status: 'all', limit: 100 },
  });
  return list.items;
}

/** One article of the account, found by its exact title. */
export async function stateOf(user: APIRequestContext, title: string): Promise<ArticleState> {
  const found = (await articleStates(user)).find((item) => item.title === title);
  if (found === undefined) throw new Error(`"${title}" is not among the account's articles`);
  return found;
}

/** The titles of the articles in an unread lane, in the order the API lists them. */
export async function unreadTitles(user: APIRequestContext, lane: string): Promise<string[]> {
  const list = await callJson<{ items: Array<{ title: string }> }>(
    user,
    'GET',
    '/api/v1/articles',
    {
      params: { lane, status: 'unread', limit: 100 },
    },
  );
  return list.items.map((item) => item.title);
}
