import {
  mergeUserPreferences,
  type InviteDto,
  type Me,
  type MePatch,
  type SessionDto,
  type Subscription,
} from '@bantoozi/shared';
import { configure, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { json, type RecordedRequest } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler, type FakeServer } from '../support/app.js';

// Every test boots the whole app; on a busy machine a query can take longer than the default 1 s.
configure({ asyncUtilTimeout: 5_000 });

export const harness = createHarness();

// TanStack Query's online manager keeps what the last online/offline event said, across tests.
afterEach(() => {
  window.dispatchEvent(new Event('online'));
});

export const EMAIL = 'a@example.com';

/** `PATCH /me` as the API does it: merge the supplied leaves, answer with the whole account. */
export function patchMe(server: FakeServer): ApiRouteHandler {
  return (request) => {
    const patch = bodyOf(request) as MePatch;
    const me = server.me as Me;
    const next: Me = {
      ...me,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.locale === undefined ? {} : { locale: patch.locale }),
      ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
      preferences:
        patch.preferences === undefined
          ? me.preferences
          : mergeUserPreferences(me.preferences, patch.preferences),
    };
    server.me = next;
    return json(200, next);
  };
}

export function makeSession(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: '1',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0',
    ip: '203.0.113.7',
    createdAt: '2026-10-01T08:00:00.000Z',
    lastSeenAt: '2026-10-08T07:30:00.000Z',
    current: false,
    ...over,
  };
}

export function makeInviteRow(over: Partial<InviteDto> = {}): InviteDto {
  return {
    code: 'ABCDEFGH23',
    email: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    expiresAt: '2036-10-31T08:00:00.000Z',
    usedAt: null,
    url: 'http://localhost:5173/join?code=ABCDEFGH23',
    ...over,
  };
}

export function makeSubscription(
  feedId: string,
  title: string | null,
  over: Partial<Subscription> = {},
): Subscription {
  return {
    feed: {
      id: feedId,
      url: `https://feed${feedId}.example/rss`,
      siteUrl: null,
      title,
      iconUrl: null,
      status: 'active',
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
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
    ...over,
  };
}

/** Answers for everything the settings page reads, so a test replaces only what it is about. */
export function settingsRoutes(
  server: FakeServer,
  over: Record<string, ApiRouteHandler> = {},
): Record<string, ApiRouteHandler> {
  return {
    'PATCH /me': patchMe(server),
    'GET /auth/sessions': () => json(200, [makeSession({ id: '1', current: true })]),
    'GET /invites': () => json(200, { items: [], invitesLeft: 3 }),
    'GET /feed-preferences': () => json(200, []),
    'GET /subscriptions': () => json(200, []),
    ...over,
  };
}

type Routes = Record<string, ApiRouteHandler>;

export async function openSettings(
  options: { me?: Me; routes?: Routes | ((server: FakeServer) => Routes); path?: string } = {},
) {
  const server: FakeServer = { me: options.me ?? makeMe({ email: EMAIL }), routes: {} };
  const over = typeof options.routes === 'function' ? options.routes(server) : options.routes;
  server.routes = settingsRoutes(server, over);
  const app = await harness.open({ path: options.path ?? '/settings', server });
  await screen.findByRole('heading', { level: 1, name: /^(Settings|Nastavenia)$/ });
  return { ...app, server };
}

export const section = (name: string) => screen.getByRole('region', { name });

export const bodiesOf = (requests: RecordedRequest[]) => requests.map((request) => bodyOf(request));

/** A date as the settings screens print it: in the account's time zone and language. */
export const formatted = (iso: string, timeZone = 'Europe/Bratislava', language = 'en') =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(iso),
  );

/** The browser loses its connection; `afterEach` above brings it back. */
export function goOffline() {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  window.dispatchEvent(new Event('offline'));
}

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
