import type { APIRequestContext } from '@playwright/test';

import { subscriptionsOf, type SubscriptionView } from '../reader-support/api.js';
import { callJson } from '../support/api.js';
import { expect } from '../support/test.js';

/**
 * What the PWA check reads from the HTTP API to compare it with what the screen shows. The wire
 * shapes are spec 08 §5 (packages/shared/src/dto/articles.ts); only the fields used here are typed.
 */

export interface ReaderFields {
  id: string;
  title: string;
  lane: string;
  rating: 1 | -1 | null;
  reason: string | null;
  readAt: string | null;
  archivedAt: string | null;
  bookmarkedAt: string | null;
  labelIds: string[];
  stateVersion: string;
  contentRevision: string;
  topReason: { kind: string; code?: string; ruleId?: string } | null;
  /** The start of the article's own text; the detail route has it, the lists do not. */
  bodyLead?: string | null;
}

interface ListPage {
  items: ReaderFields[];
  nextCursor: string | null;
}

/** Every article of a lane, read or not (`status: 'all'`), whatever the page size. */
export async function articlesOf(
  user: APIRequestContext,
  lane: string,
  status: 'unread' | 'all' = 'all',
): Promise<ReaderFields[]> {
  const items: ReaderFields[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await callJson<ListPage>(user, 'GET', '/api/v1/articles', {
      params: { lane, status, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
    });
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}

/**
 * Every article the account can see, by id: the normal lanes (`all`) and the hidden ones, which
 * the reader lists apart (spec 08 §5.1).
 */
export async function everyArticle(user: APIRequestContext): Promise<Map<string, ReaderFields>> {
  const found = new Map<string, ReaderFields>();
  for (const lane of ['all', 'hidden']) {
    for (const item of await articlesOf(user, lane)) found.set(item.id, item);
  }
  return found;
}

/** One article as the detail route reports it (no read or open side effect). */
export function fieldsOf(user: APIRequestContext, articleId: string): Promise<ReaderFields> {
  return callJson<ReaderFields>(user, 'GET', `/api/v1/articles/${articleId}`);
}

/** The id of the article with this title, once the account has it. */
export async function idOf(user: APIRequestContext, title: string): Promise<string> {
  const found = [...(await everyArticle(user)).values()].find((item) => item.title === title);
  if (found === undefined) throw new Error(`"${title}" is not among the account's articles`);
  return found.id;
}

/** Waits until the account has every one of these articles in its lists. */
export async function waitForTitles(
  user: APIRequestContext,
  titles: readonly string[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const have = new Set([...(await everyArticle(user)).values()].map((item) => item.title));
        return titles.filter((title) => !have.has(title));
      },
      { message: 'the articles reach the account', timeout: 45_000, intervals: [500, 1_000] },
    )
    .toEqual([]);
}

/** What a reader action changes and an undo must restore, without the version counter. */
export interface ReaderState {
  rating: 1 | -1 | null;
  reason: string | null;
  readAt: string | null;
  archivedAt: string | null;
  bookmarkedAt: string | null;
  labelIds: string[];
}

export function stateOf(fields: ReaderFields): ReaderState {
  return {
    rating: fields.rating,
    reason: fields.reason,
    readAt: fields.readAt,
    archivedAt: fields.archivedAt,
    bookmarkedAt: fields.bookmarkedAt,
    labelIds: fields.labelIds,
  };
}

/**
 * Reads until `accept` holds. When it never does, the failure says what the last read showed,
 * which a bare poll on a boolean would not.
 */
async function pollUntil<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
  { message, timeout, intervals }: { message: string; timeout: number; intervals: number[] },
  describe: (value: Value) => string,
): Promise<Value> {
  let last: { value: Value } | undefined;
  try {
    await expect
      .poll(
        async () => {
          last = { value: await read() };
          return accept(last.value);
        },
        { message, timeout, intervals },
      )
      .toBe(true);
  } catch (error) {
    const seen = last === undefined ? 'never read' : describe(last.value);
    throw new Error(`${message}; the last read showed ${seen}`, { cause: error });
  }
  if (last === undefined) throw new Error('unreachable: the poll ran at least once');
  return last.value;
}

/** The reader state of one article, polled until it is `expected`. */
export function expectState(
  user: APIRequestContext,
  articleId: string,
  expected: Partial<ReaderState> | ((state: ReaderState) => boolean),
  message: string,
): Promise<ReaderState> {
  const accept = (state: ReaderState): boolean =>
    typeof expected === 'function'
      ? expected(state)
      : Object.entries(expected).every(
          ([key, value]) =>
            JSON.stringify(state[key as keyof ReaderState]) === JSON.stringify(value),
        );
  return pollUntil(
    async () => stateOf(await fieldsOf(user, articleId)),
    accept,
    { message, timeout: 15_000, intervals: [250, 500, 1_000] },
    (state) => JSON.stringify(state),
  );
}

/**
 * The lane of an article, polled: the worker moves it when a rule, a card or an unhide changes
 * what hides it.
 */
export function expectLane(
  user: APIRequestContext,
  articleId: string,
  expected: (lane: string) => boolean,
  message: string,
): Promise<ReaderFields> {
  return pollUntil(
    () => fieldsOf(user, articleId),
    (fields) => expected(fields.lane),
    { message, timeout: 30_000, intervals: [500, 1_000, 2_000] },
    (fields) => `lane "${fields.lane}" because of ${JSON.stringify(fields.topReason)}`,
  );
}

export interface RuleView {
  id: string;
  kind: string;
  value: string;
}

/** The rules the account has made (`GET /rules`). */
export function rulesOf(user: APIRequestContext): Promise<RuleView[]> {
  return callJson<RuleView[]>(user, 'GET', '/api/v1/rules');
}

export interface CardView {
  id: string;
  title: string;
  strength: string;
}

/** The interest cards the account holds (`GET /cards`). */
export function cardsOf(user: APIRequestContext): Promise<CardView[]> {
  return callJson<CardView[]>(user, 'GET', '/api/v1/cards');
}

/**
 * Turns on automatic classification for one subscription, which takes the two steps the Feeds
 * page offers: training first, then active (spec 08 §4.1). Only arrivals after this are analyzed.
 */
export async function enableAutomaticClassification(
  user: APIRequestContext,
  feedUrl: string,
): Promise<void> {
  const subscription = (await subscriptionsOf(user)).find((item) => item.feed.url === feedUrl);
  if (subscription === undefined) throw new Error(`the account does not follow ${feedUrl}`);
  const path = `/api/v1/subscriptions/${subscription.feed.id}/inference`;
  const training = await callJson<{ subscription: SubscriptionView }>(user, 'POST', path, {
    data: { mode: 'training', expectedVersion: subscription.inferenceVersion },
  });
  await callJson<unknown>(user, 'POST', path, {
    data: { mode: 'active', expectedVersion: training.subscription.inferenceVersion },
  });
}

/** The saved preferences the PWA check looks at (`GET /me`). */
export interface Preferences {
  implicitFeedback: boolean;
  simpleMode: boolean;
}

export async function preferencesOf(user: APIRequestContext): Promise<Preferences> {
  const me = await callJson<{ preferences: Preferences }>(user, 'GET', '/api/v1/me');
  return {
    implicitFeedback: me.preferences.implicitFeedback,
    simpleMode: me.preferences.simpleMode,
  };
}

/**
 * Another device of the same account rates an article, from the state that device last saw (a
 * second session, as a phone would be). The edit moves the article's state version.
 */
export async function rateFromAnotherDevice(
  device: APIRequestContext,
  articleId: string,
  rating: 1 | -1 | null,
): Promise<void> {
  const current = await fieldsOf(device, articleId);
  await callJson(device, 'POST', `/api/v1/articles/${articleId}/rating`, {
    data: {
      stateVersion: current.stateVersion,
      contentRevision: current.contentRevision,
      rating,
    },
  });
}
