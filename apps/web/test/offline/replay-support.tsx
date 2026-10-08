import type { ArticleListItem, Me } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

import { OFFLINE_DB } from '../../src/offline/names.js';
import type { QueueRecord } from '../../src/offline/queue.js';
import { failure, json, type RecordedRequest } from '../api/fake-fetch.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import { makeMe } from '../session/fixtures.js';
import { renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';

export const READ_AT = '2026-05-31T10:00:00.000Z';
export const TITLE = 'Solid-state batteries reach the pilot line';

export type MutationKind =
  | 'rating'
  | 'read'
  | 'unread'
  | 'unhide'
  | 'open'
  | 'dwell'
  | 'promptAnswer'
  | 'bookmark'
  | 'unbookmark'
  | 'retryCapture'
  | 'addLabel'
  | 'removeLabel';

const MUTATIONS: readonly (readonly [string, MutationKind])[] = [
  ['POST /articles/:id/rating', 'rating'],
  ['POST /articles/:id/read', 'read'],
  ['POST /articles/:id/unread', 'unread'],
  ['POST /articles/:id/unhide', 'unhide'],
  ['POST /articles/:id/open', 'open'],
  ['POST /articles/:id/dwell', 'dwell'],
  ['POST /articles/:id/prompt-answer', 'promptAnswer'],
  ['POST /articles/:id/bookmark', 'bookmark'],
  ['DELETE /articles/:id/bookmark', 'unbookmark'],
  ['POST /articles/:id/bookmark/retry-capture', 'retryCapture'],
  ['POST /articles/:id/labels', 'addLabel'],
  ['DELETE /articles/:id/labels/:labelId', 'removeLabel'],
];

/** What the server was asked to do: one entry per request that reached it. */
export interface Arrival {
  kind: MutationKind;
  articleId: string;
  /** The Idempotency-Key of the request. */
  key: string;
  /** The body of a POST, the query of a DELETE. */
  fields: Record<string, unknown>;
  /** The request was a repeat that the server answered from its receipt. */
  replayed: boolean;
}

export type Fault =
  /** The answer never arrives, the server did nothing. */
  | { when: 'before'; act: 'network' }
  /** The server did what was asked and its answer never arrives. */
  | { when: 'after'; act: 'network' }
  | {
      when: 'before';
      act: { status: number; code: string; headers?: Record<string, string> };
    };

interface QueuedFault {
  kinds: readonly MutationKind[] | null;
  fault: Fault;
  times: number;
}

export interface Gate {
  /** Resolves when a request that the gate holds has reached the server. */
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * A server for reader actions, shared by every tab of a test: article state with versions,
 * receipts per Idempotency-Key (a repeat is answered from the receipt and has no second effect),
 * fences, and faults and gates a test scripts. `fake` is what `renderApp` takes.
 */
export function createArticleServer(
  initial: readonly ArticleListItem[] = [makeItem()],
  me: Me | null = makeMe(),
) {
  const items = new Map(initial.map((item) => [item.id, item]));
  const receipts = new Map<string, Record<string, unknown>>();
  const faults: QueuedFault[] = [];
  const gates: {
    kinds: readonly MutationKind[] | null;
    released: boolean;
    reached: () => void;
    resume: (() => void) | null;
  }[] = [];
  const arrivals: Arrival[] = [];
  const effects: { kind: MutationKind; articleId: string; key: string }[] = [];
  const state = {
    reachable: true,
    suggestion: null as { cardId: string; side: 'yes' | 'no' } | null,
  };

  function takeFault(kind: MutationKind, when: Fault['when']): Fault | undefined {
    const index = faults.findIndex(
      (queued) =>
        queued.times > 0 &&
        queued.fault.when === when &&
        (queued.kinds === null || queued.kinds.includes(kind)),
    );
    const queued = faults[index];
    if (queued === undefined) return undefined;
    queued.times -= 1;
    return queued.fault;
  }

  function fieldsOf(request: RecordedRequest): Record<string, unknown> {
    if (typeof request.body === 'string')
      return JSON.parse(request.body) as Record<string, unknown>;
    return Object.fromEntries(request.query.entries());
  }

  function transition(
    item: ArticleListItem,
    kind: MutationKind,
    fields: Record<string, unknown>,
    params: Record<string, string>,
  ): ArticleListItem {
    const stamp = new Date().toISOString();
    const next = { ...item, stateVersion: String(BigInt(item.stateVersion) + 1n) };
    switch (kind) {
      case 'rating': {
        const rating = fields['rating'] as 1 | -1 | null;
        return {
          ...next,
          rating,
          reason: rating === -1 ? ((fields['reason'] as ArticleListItem['reason']) ?? null) : null,
          readAt: rating === null ? item.readAt : (item.readAt ?? stamp),
          archivedAt: fields['hide'] === true ? (item.archivedAt ?? stamp) : item.archivedAt,
        };
      }
      case 'read':
      case 'open':
        return { ...next, readAt: item.readAt ?? stamp };
      case 'unread':
        return { ...next, readAt: null, archivedAt: null };
      case 'unhide':
        return { ...next, archivedAt: null };
      case 'bookmark':
        return { ...next, bookmarkedAt: item.bookmarkedAt ?? stamp };
      case 'unbookmark':
        return { ...next, bookmarkedAt: null };
      case 'addLabel': {
        const labelId = fields['labelId'] as string;
        return { ...next, labelIds: [...new Set([...item.labelIds, labelId])] };
      }
      case 'removeLabel':
        return { ...next, labelIds: item.labelIds.filter((id) => id !== params['labelId']) };
      case 'promptAnswer':
        return { ...next, rating: fields['liked'] === true ? 1 : -1, reason: null };
      case 'retryCapture':
      case 'dwell':
        return next;
    }
  }

  function handle(
    kind: MutationKind,
    request: RecordedRequest,
    params: Record<string, string>,
  ): Response | Promise<Response> {
    if (!state.reachable) return Promise.reject(new TypeError('Failed to fetch'));
    const key = request.headers.get('Idempotency-Key') ?? '';
    const fields = fieldsOf(request);
    const articleId = params['id'] ?? '';
    const arrival: Arrival = { kind, articleId, key, fields, replayed: receipts.has(key) };
    arrivals.push(arrival);

    const before = takeFault(kind, 'before');
    if (before?.act === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (before !== undefined && typeof before.act === 'object') {
      const { status, code, headers } = before.act;
      return failure(status, code, undefined, headers);
    }

    let body = receipts.get(key);
    if (body === undefined) {
      const item = items.get(articleId);
      if (item === undefined) return failure(404, 'NOT_FOUND');
      if (
        fields['stateVersion'] !== item.stateVersion ||
        fields['contentRevision'] !== item.contentRevision
      ) {
        return failure(409, 'STALE_STATE', { item });
      }
      const next = transition(item, kind, fields, params);
      items.set(articleId, next);
      body = {
        item: next,
        mutationId: crypto.randomUUID(),
        ...(kind === 'rating' ? { exampleSuggestion: state.suggestion } : {}),
        ...(kind === 'dwell' ? { prompt: false } : {}),
      };
      receipts.set(key, body);
      effects.push({ kind, articleId, key });
    }
    const answer = body;

    const after = takeFault(kind, 'after');
    if (after !== undefined) return Promise.reject(new TypeError('Failed to fetch'));

    const gate = gates.find(
      (candidate) => candidate.kinds === null || candidate.kinds.includes(kind),
    );
    if (gate === undefined) return json(200, answer);
    gates.splice(gates.indexOf(gate), 1);
    gate.reached();
    if (gate.released) return json(200, answer);
    return new Promise<Response>((resolve) => {
      gate.resume = () => resolve(json(200, answer));
    });
  }

  const routes: Record<string, ApiRouteHandler> = Object.fromEntries(
    MUTATIONS.map(([route, kind]) => [
      route,
      (request: RecordedRequest, params: Record<string, string>) => handle(kind, request, params),
    ]),
  );

  const fake: FakeServer = { me, routes };

  return {
    fake,
    routes,
    items,
    arrivals,
    effects,
    state,
    /** The requests of one kind that reached the server, in order. */
    of: (kind: MutationKind) => arrivals.filter((arrival) => arrival.kind === kind),
    /** The article as the server holds it. */
    item: (id: string) => items.get(id)!,
    /** Another device changed the article. */
    change(id: string, patch: Partial<ArticleListItem>) {
      const current = items.get(id)!;
      const next = {
        ...current,
        ...patch,
        stateVersion: patch.stateVersion ?? String(BigInt(current.stateVersion) + 1n),
      };
      items.set(id, next);
      return next;
    },
    /** Queues `times` faults for requests of these kinds (any kind when omitted). */
    fault(fault: Fault, options: { kinds?: readonly MutationKind[]; times?: number } = {}) {
      faults.push({ kinds: options.kinds ?? null, fault, times: options.times ?? 1 });
    },
    /** Holds the answer of the next request of these kinds until the gate is released. */
    gate(...kinds: MutationKind[]): Gate {
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const entry = {
        kinds: kinds.length === 0 ? null : kinds,
        released: false,
        reached,
        resume: null as (() => void) | null,
      };
      gates.push(entry);
      return {
        reached: arrived,
        release: () => {
          entry.released = true;
          entry.resume?.();
        },
      };
    },
  };
}

export type ArticleServer = ReturnType<typeof createArticleServer>;

/** A tab: the whole app at the reader, over the shared server. */
export async function openTab(server: ArticleServer) {
  const app = await renderApp({ path: '/read/for_you', server: server.fake });
  const root = within(app.container);
  await root.findByRole('article', { name: TITLE });
  return { ...app, root };
}

export type Tab = Awaited<ReturnType<typeof openTab>>;

export const likeOf = (tab: Tab, title = TITLE) =>
  within(tab.root.getByRole('article', { name: title })).getByRole('button', { name: 'Like' });
export const dislikeOf = (tab: Tab, title = TITLE) =>
  within(tab.root.getByRole('article', { name: title })).getByRole('button', { name: 'Dislike' });
export const bookmarkOf = (tab: Tab, title = TITLE) =>
  within(tab.root.getByRole('article', { name: title })).getByRole('button', { name: 'Bookmark' });
export const isPressed = (button: HTMLElement) => button.getAttribute('aria-pressed') === 'true';

/** The browser's connection, as `navigator.onLine`, its events and the server's reachability. */
export function connection(server: ArticleServer) {
  let online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  return {
    get online() {
      return online;
    },
    drop() {
      online = false;
      server.state.reachable = false;
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
    },
    restore() {
      online = true;
      server.state.reachable = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
    },
  };
}

/** The tab is shown again after being in the background. */
export function showTab(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}

export function requestReplayEvent(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('bantoozi:replay'));
  });
}

const nextTurn = (callback: () => void): unknown =>
  (globalThis as unknown as { setImmediate(run: () => void): unknown }).setImmediate(callback);

/** Lets IndexedDB, broadcast channels and promise chains run. */
export async function flushIo(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => nextTurn(resolve));
    });
  }
}

/** The queue store as raw IndexedDB holds it, in no particular order. */
export async function storedRecords(factory: IDBFactory): Promise<QueueRecord[]> {
  const known = await factory.databases();
  if (!known.some((info) => info.name === OFFLINE_DB)) return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const rows = await new Promise<QueueRecord[]>((resolve, reject) => {
      const request = db.transaction('queue', 'readonly').objectStore('queue').getAll();
      request.onsuccess = () => resolve(request.result as QueueRecord[]);
      request.onerror = () => reject(request.error);
    });
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  } finally {
    db.close();
  }
}

/** Waits until the queue store holds exactly `count` records and returns them. */
export async function recordsReach(
  factory: IDBFactory,
  count: number,
  timeout = 3000,
): Promise<QueueRecord[]> {
  let found: QueueRecord[] = [];
  await waitFor(
    async () => {
      found = await storedRecords(factory);
      expectCount(found.length, count);
    },
    { timeout },
  );
  return found;
}

function expectCount(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`The queue store holds ${actual} records, expected ${expected}`);
  }
}

/** Waits for `check` to stop throwing, letting IndexedDB and timers run in between. */
export async function until(check: () => unknown, timeout = 3000): Promise<void> {
  await waitFor(check, { timeout });
}

export { FakeLocks, installLocks, removeLocks } from './fake-locks.js';

/** Every toast on screen. */
export const toastTexts = (): string[] =>
  Array.from(document.querySelectorAll('[data-tone]')).map((toast) => toast.textContent ?? '');

export const failureToast = () => screen.queryByText("Couldn't save — retry");
