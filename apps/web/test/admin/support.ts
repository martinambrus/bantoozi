import type {
  AdminFeed,
  AdminInviteSchema,
  AdminLibraryCard,
  AdminOverview,
  AdminSettings,
  AdminUsage,
  AdminUser,
  AdminWaitlistEntrySchema,
  CredentialStatus,
  InviteDto,
  LibraryCandidate,
  Me,
  PromotionRequest,
  Provider,
} from '@bantoozi/shared';
import { afterEach, expect } from 'vitest';
import type { z } from 'zod';

import { json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler } from '../support/app.js';

export type AdminBreaker = AdminOverview['engine']['breakers']['typesafe'];
export type AdminInvite = z.infer<typeof AdminInviteSchema>;
export type AdminWaitlistEntry = z.infer<typeof AdminWaitlistEntrySchema>;

/**
 * Registers a check, after every test of the file, that no request reached the fake API without a
 * handler; wrap each rendered app in the returned function.
 */
export function unhandledGuard() {
  const apps: { unhandled: string[] }[] = [];
  afterEach(() => {
    const unanswered = apps.splice(0).flatMap((app) => app.unhandled);
    expect(unanswered).toEqual([]);
  });
  return <T extends { unhandled: string[] }>(app: T): T => {
    apps.push(app);
    return app;
  };
}

export const adminMe = (): Me => makeMe({ role: 'admin' });
export const userMe = (): Me => makeMe();

export const T1 = '2026-10-08T09:00:00.000Z';
export const T2 = '2026-10-08T09:30:00.000Z';
export const T3 = '2026-09-01T12:00:00.000Z';

export function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

export function breaker(over: Partial<AdminBreaker> = {}): AdminBreaker {
  return { state: 'closed', openUntil: null, resetRequestedAt: null, ...over };
}

export function makeOverview(over: Partial<AdminOverview> = {}): AdminOverview {
  return {
    users: { total: 120, active7d: 34 },
    feeds: { active: 100, quarantined: 3, dead: 2, paused: 1 },
    articlesToday: 57,
    queues: [
      { queue: 'article.extract', created: 4, retry: 1, active: 2, failed: 0 },
      { queue: 'feed.fetch', created: 0, retry: 0, active: 1, failed: 5 },
    ],
    engine: {
      breakers: { typesafe: breaker(), llm: breaker() },
      spendTodayUsd: 1.2,
      dailyBudgetUsd: 5,
      llmCallsToday: 12,
      llmDailyCap: 200,
    },
    translations: {
      last24h: [
        { engine: 'libretranslate', quality: 'ok', count: 80 },
        { engine: 'ollama', quality: 'weak', count: 3 },
      ],
      tier2CallsToday: 40,
      tier2DailyCap: 300,
    },
    ...over,
  };
}

export function makeUsage(over: Partial<AdminUsage> = {}): AdminUsage {
  return {
    days: 30,
    daily: [
      { day: '2026-10-01', engine: 'typesafe', kind: 'enrich', calls: 10, costUsd: 1 },
      { day: '2026-10-01', engine: 'llm', kind: 'decide', calls: 2, costUsd: 0.5 },
      { day: '2026-10-03', engine: 'typesafe', kind: 'enrich', calls: 30, costUsd: 3 },
      { day: '2026-10-04', engine: 'typesafe', kind: 'match', calls: 20, costUsd: 2 },
    ],
    topUsers: [
      {
        userId: '0192f7a0-0000-7000-8000-0000000000a1',
        email: 'heavy@example.com',
        directUsd: 2,
        sharedUsd: 0.5,
        totalUsd: 2.5,
      },
      {
        userId: '0192f7a0-0000-7000-8000-0000000000a2',
        email: null,
        directUsd: 0.25,
        sharedUsd: 0,
        totalUsd: 0.25,
      },
    ],
    ...over,
  };
}

export const SETTINGS_VALUES: AdminSettings['values'] = {
  'engine.daily_budget_usd': 5,
  'engine.llm_daily_cap': 200,
  'engine.prefilter_enabled': false,
  'engine.laya': {},
  language_modes: { en: 'native', sk: 'native' },
  card_text_mode: 'as_written',
  'ranker.thresholds': {},
  'translate.tier2_daily_cap': 300,
  'question_sets.active': {},
  signup_mode: 'invite',
};

export function makeSettings(over: Partial<AdminSettings> = {}): AdminSettings {
  return {
    values: SETTINGS_VALUES,
    stored: [{ key: 'engine.daily_budget_usd', updatedAt: T1 }],
    rankerSettingsVersion: 3,
    ...over,
  };
}

export function makeCredential(
  provider: Provider,
  over: Partial<CredentialStatus> = {},
): CredentialStatus {
  return {
    provider,
    source: 'none',
    enabled: false,
    revision: '0',
    activeVersion: null,
    candidateVersion: null,
    candidateStatus: null,
    validatedAt: null,
    capabilities: null,
    lastErrorCode: null,
    ...over,
  };
}

export function makeFeed(over: Partial<AdminFeed> = {}): AdminFeed {
  return {
    id: '41',
    url: 'https://news.example.com/feed.xml',
    siteUrl: 'https://news.example.com',
    title: 'Example News',
    status: 'active',
    subscriberCount: 7,
    consecutiveErrors: 0,
    quarantineCount: 0,
    quarantinedUntil: null,
    lastSuccessAt: T1,
    lastErrorCode: null,
    lastErrorAt: null,
    nextFetchAt: T2,
    minIntervalS: 900,
    mergedIntoId: null,
    fetchOptions: {},
    ...over,
  };
}

export function makeUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: '0192f7a0-0000-7000-8000-0000000000b1',
    email: 'reader@example.com',
    displayName: 'Rita Reader',
    role: 'user',
    plan: 'beta',
    invitesLeft: 3,
    createdAt: T3,
    lastActiveAt: T1,
    deletedAt: null,
    adminBootstrap: false,
    ...over,
  };
}

export function makeInvite(over: Partial<AdminInvite> = {}): AdminInvite {
  return {
    code: 'ABCDEFGH23',
    email: null,
    note: 'Beta cohort',
    createdBy: '0192f7a0-0000-7000-8000-00000000000a',
    createdAt: T3,
    expiresAt: T2,
    usedBy: null,
    usedAt: null,
    status: 'unused',
    ...over,
  };
}

export function makeInviteDto(over: Partial<InviteDto> = {}): InviteDto {
  return {
    code: 'ZXCVBNM234',
    email: null,
    createdAt: T1,
    expiresAt: T2,
    usedAt: null,
    url: 'http://localhost:5173/join?code=ZXCVBNM234',
    ...over,
  };
}

export function makeWaitlistEntry(over: Partial<AdminWaitlistEntry> = {}): AdminWaitlistEntry {
  return {
    id: '5',
    email: 'wait@example.com',
    locale: 'en',
    note: null,
    createdAt: T3,
    invitedAt: null,
    inviteCode: null,
    ...over,
  };
}

export function makeLibraryCard(over: Partial<AdminLibraryCard> = {}): AdminLibraryCard {
  return {
    cardId: '301',
    slug: 'solar-power',
    version: 2,
    title: 'Solar power',
    interest: 'Rooftop solar panels and home batteries',
    notFor: 'Stock tips',
    examplesYes: ['A school installs panels'],
    examplesNo: [],
    topicIds: ['energy'],
    i18n: {},
    holders: 12,
    retiredAt: null,
    createdAt: T3,
    publication: null,
    ...over,
  };
}

export function makeRequest(over: Partial<PromotionRequest> = {}): PromotionRequest {
  return {
    id: '11',
    cardId: '501',
    cardTitle: 'Hiking trails',
    status: 'pending',
    version: '3',
    requestedAt: T3,
    expiresAt: null,
    respondedAt: null,
    payload: {
      slug: 'hiking-trails-501',
      title: 'Hiking trails',
      titleSk: 'Turistické chodníky',
      topicIds: ['outdoors'],
    },
    publicationSha: 'sha',
    holders: 5,
    creatorKnown: true,
    vetoed: false,
    promotionEligibility: { status: 'eligible', basis: 'creator_inactive_30d', reason: null },
    authorizationKind: null,
    promotedAt: null,
    ...over,
  };
}

export function makeCandidate(over: Partial<LibraryCandidate> = {}): LibraryCandidate {
  return {
    cardId: '501',
    title: 'Hiking trails',
    interest: 'Day hikes and mountain trails',
    notFor: 'Extreme sports',
    lang: 'en',
    topicIds: ['outdoors'],
    holders: 5,
    createdAt: T3,
    creatorKnown: true,
    vetoed: false,
    request: null,
    promotionEligibility: { status: 'held', basis: null, reason: 'no_request' },
    ...over,
  };
}

/** Default answers for every admin read, so a test overrides only what it is about. */
export function adminRoutes(
  over: Record<string, ApiRouteHandler> = {},
): Record<string, ApiRouteHandler> {
  return {
    'GET /admin/overview': () => json(200, makeOverview()),
    'GET /admin/usage': () => json(200, makeUsage()),
    'GET /admin/settings': () => json(200, makeSettings()),
    'GET /admin/engine/credentials': () =>
      json(200, { items: [makeCredential('typesafe'), makeCredential('ollama')] }),
    'GET /admin/feeds': () => json(200, page([makeFeed()])),
    'GET /admin/users': () => json(200, page([makeUser()])),
    'GET /admin/invites': () => json(200, page([makeInvite()])),
    'GET /admin/waitlist': () => json(200, page([makeWaitlistEntry()])),
    'GET /admin/library': () => json(200, page([makeLibraryCard()])),
    'GET /admin/library/candidates': () => json(200, { items: [makeCandidate()] }),
    ...over,
  };
}
