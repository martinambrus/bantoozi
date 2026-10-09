import type {
  CardDto,
  CardMutationResponse,
  CardSuggestionSchema,
  IdChange,
  LibraryCardDto,
  LibraryUpdateOfferSchema,
  Me,
  PublicationRequestDto,
  Subscription,
  TopicSchema,
} from '@bantoozi/shared';
import type { z } from 'zod';

import { json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler, FakeServer } from '../support/app.js';

export type Offer = z.infer<typeof LibraryUpdateOfferSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type Suggestion = z.infer<typeof CardSuggestionSchema>;

export function makeCard(overrides: Partial<CardDto> = {}): CardDto {
  return {
    id: '101',
    kind: 'interest',
    title: 'Rust programming',
    titleOverride: null,
    interest: 'The Rust programming language: releases, libraries and tooling',
    notFor: null,
    strength: 'like',
    scopeFeedId: null,
    origin: 'user',
    isPrivateFork: false,
    examplesYes: [],
    examplesNo: [],
    topicIds: [],
    lang: 'en',
    librarySlug: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

export function makeLibraryCard(overrides: Partial<LibraryCardDto> = {}): LibraryCardDto {
  return {
    id: '501',
    slug: 'ev-batteries',
    title: 'EV battery tech',
    interest: 'New battery chemistry and manufacturing for electric vehicles',
    notFor: 'Stock-price moves',
    examplesYes: [],
    examplesNo: [],
    topicIds: ['transport.ev'],
    l1TopicId: 'transport',
    lang: 'en',
    version: 1,
    held: false,
    ...overrides,
  };
}

export function makeSubscription(
  feedId: string,
  title: string | null,
  overrides: Partial<Subscription> = {},
): Subscription {
  return {
    feed: {
      id: feedId,
      url: `https://example.com/feed-${feedId}.xml`,
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
    inferenceVersion: '0',
    inferenceActivatedAt: null,
    imagePolicy: 'inherit',
    effectiveImagesAllowed: false,
    unread: { forYou: 0, maybe: 0, everything: 0, new: 0 },
    ...overrides,
  };
}

export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    currentCardId: '101',
    baseCardId: '101',
    newCardId: '151',
    librarySlug: 'rust-lang',
    fromVersion: 1,
    toVersion: 2,
    diff: {
      title: null,
      interest: {
        from: 'The Rust programming language: releases and libraries',
        to: 'The Rust programming language: releases, libraries, tooling and real-world use',
      },
      notFor: null,
      examplesYes: { added: [], removed: [] },
      examplesNo: { added: [], removed: [] },
    },
    hasPrivateCustomization: false,
    ...overrides,
  };
}

export function makeRequest(overrides: Partial<PublicationRequestDto> = {}): PublicationRequestDto {
  return {
    id: '7',
    cardId: '101',
    kind: 'interest',
    status: 'pending',
    version: '3',
    card: {
      title: 'Rust programming',
      interest: 'The Rust programming language: releases, libraries and tooling',
      notFor: 'Rust the video game',
      examplesYes: [],
      examplesNo: [],
      textHash: 'abc123',
    },
    proposed: {
      slug: 'rust-programming',
      title: 'Rust programming',
      topicIds: ['technology.software_dev'],
      i18n: { sk: { title: 'Programovanie v Ruste' } },
    },
    publicationSha: 'def456',
    requestedAt: '2026-09-20T10:00:00.000Z',
    expiresAt: '2026-10-20T10:00:00.000Z',
    respondedAt: null,
    ...overrides,
  };
}

export const TOPICS: Topic[] = [
  {
    id: 'technology',
    parent: null,
    level: 1,
    names: { en: 'Technology', sk: 'Technológie' },
    description: 'Software, hardware, the internet, AI and the tech industry',
  },
  {
    id: 'technology.software_dev',
    parent: 'technology',
    level: 2,
    names: { en: 'Software development', sk: 'Vývoj softvéru' },
    description: 'Programming',
  },
  {
    id: 'transport',
    parent: null,
    level: 1,
    names: { en: 'Cars and transport', sk: 'Autá a doprava' },
    description: 'Vehicles, mobility and travel infrastructure',
  },
  {
    id: 'transport.ev',
    parent: 'transport',
    level: 2,
    names: { en: 'Electric vehicles', sk: 'Elektromobily' },
    description: 'Electric cars',
  },
  {
    id: 'science',
    parent: null,
    level: 1,
    names: { en: 'Science', sk: 'Veda' },
    description: 'Scientific discoveries and research',
  },
];

/** The answer of every card mutation that leaves the user holding a card. */
export function cardResult(
  card: CardDto,
  idChange: IdChange | null = null,
  translation: CardMutationResponse['translation'] = null,
): CardMutationResponse {
  return { card, idChange, translation };
}

export interface Fixtures {
  cards?: CardDto[];
  subscriptions?: Subscription[];
  suggestions?: Suggestion[];
  updates?: Offer[];
  requests?: PublicationRequestDto[];
  topics?: Topic[];
  me?: Me;
}

/**
 * A fake API for the interests screen: every read it makes is answered from `fixtures` (the arrays
 * can be changed during a test to change later answers), and `routes` adds or replaces operations.
 */
export function interestsServer(
  fixtures: Fixtures = {},
  routes: Record<string, ApiRouteHandler> = {},
): FakeServer {
  const {
    cards = [],
    subscriptions = [],
    suggestions = [],
    updates = [],
    requests = [],
    topics = TOPICS,
  } = fixtures;
  return {
    me: fixtures.me ?? makeMe(),
    routes: {
      'GET /cards': () => json(200, cards),
      'GET /subscriptions': () => json(200, subscriptions),
      'GET /cards/suggestions': () => json(200, suggestions),
      'GET /library/updates': () => json(200, updates),
      'GET /cards/publication-requests': () => json(200, requests),
      'GET /topics': () => json(200, topics),
      'GET /library': () => json(200, { items: [], nextCursor: null }),
      ...routes,
    },
  };
}

/** A promise to hold an answer back until the test lets it go. */
export function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
}
