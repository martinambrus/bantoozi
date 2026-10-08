import type { ArticleDetail, ArticleListItem, CardDto, Explain, Me } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

import { WhyThisSheet } from '../../src/features/why/why-this-sheet.js';
import type { Language } from '../../src/i18n/index.js';
import { json } from '../api/fake-fetch.js';
import { makeDetail, renderReader } from '../article/harness.js';
import { TOPICS, makeCard, type Topic } from '../interests/support.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import type { ApiRouteHandler } from '../support/app.js';

export const ITEM = makeItem({ author: 'Jane Doe' });

/** The cards the person holds; ids 31 and 32 are in `makeExplain`, 33 is only in the rules. */
export const HELD: CardDto[] = [
  makeCard({ id: '31', title: 'EV battery tech', strength: 'love' }),
  makeCard({ id: '32', title: 'Solar power', strength: 'like' }),
  makeCard({ id: '33', title: 'Football', strength: 'never' }),
];

/** A valid explanation scored from cards, at tier 5. */
export function makeExplain(overrides: Partial<Explain> = {}): Explain {
  return {
    v: 1,
    inputs: {
      contentRevision: '2',
      mediaRevision: '1',
      rankRevision: '3',
      contextSha: 'a'.repeat(64),
    },
    source: 'cards',
    p: 0.91,
    lane: 'for_you',
    tier: 5,
    decidingCardId: '31',
    cards: [
      { id: '31', title: 'EV battery tech', strength: 'love', p: 0.91, engine: 'typesafe' },
      { id: '32', title: 'Solar power', strength: 'like', p: 0.42, engine: 'typesafe' },
    ],
    rules: [],
    ...overrides,
  };
}

/** A news report about software development: depth 3 of 5, clickbait, a little time-sensitive. */
export const FACETS: NonNullable<Explain['facets']> = {
  contentType: { choice: 'news_report', p: 0.8 },
  topic: { l1: 'technology', p: 0.7, l2: 'technology.software_dev' },
  depth: 0.5,
  clickbait: 0.82,
  promotional: 0.1,
  timeSensitive: 0.35,
  evergreen: 0.4,
};

/** An explanation that no card scored, as the ranker stores it for lanes without a score. */
export function makeUnscored(overrides: Partial<Explain> = {}): Explain {
  return makeExplain({
    source: 'none',
    p: null,
    lane: 'new',
    tier: null,
    cards: [],
    ...overrides,
  });
}

export interface DrawerFixtures {
  item?: ArticleListItem;
  /** `null` is an article that has no stored explanation. */
  explain?: Explain | null;
  detail?: Partial<ArticleDetail>;
  cards?: CardDto[];
  topics?: Topic[];
}

/** What the drawer reads: the detail, the cards, the taxonomy and (for the editor) the feeds. */
export function drawerRoutes(fixtures: DrawerFixtures = {}): Record<string, ApiRouteHandler> {
  const { item = ITEM, explain = makeExplain(), cards = HELD, topics = TOPICS } = fixtures;
  return {
    'GET /articles/:id': () => json(200, makeDetail(item, { explain, ...fixtures.detail })),
    'GET /cards': () => json(200, cards),
    'GET /topics': () => json(200, topics),
    'GET /subscriptions': () => json(200, []),
  };
}

export interface DrawerOptions extends DrawerFixtures {
  me?: Me;
  language?: Language;
  sourceFeedId?: string;
  saved?: boolean;
  routes?: Record<string, ApiRouteHandler>;
}

const opened: { unhandled: string[] }[] = [];

/** After each test: the app asked the fake API for nothing it does not handle. */
export function checkUnhandled() {
  afterEach(() => {
    for (const app of opened.splice(0)) expect(app.unhandled).toEqual([]);
  });
}

/** Has `checkUnhandled` look at an app that a test rendered by itself. */
export function track<T extends { unhandled: string[] }>(app: T): T {
  opened.push(app);
  return app;
}

type Rendered = ReturnType<typeof renderReader>;

/** Waits until every query has answered and the screen has shown the answers. */
export async function settled(app: Pick<Rendered, 'queryClient'>) {
  await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens the drawer for `ITEM` against a fake API and waits until it has everything it reads. */
export async function renderDrawer(options: DrawerOptions = {}) {
  const { language = 'en', me, sourceFeedId, saved, routes, ...fixtures } = options;
  const item = fixtures.item ?? ITEM;
  const onClose = vi.fn();
  const app = track(
    renderReader(
      <WhyThisSheet item={item} open onClose={onClose} sourceFeedId={sourceFeedId} saved={saved} />,
      {
        ...(me === undefined ? {} : { me }),
        language,
        routes: { ...drawerRoutes({ ...fixtures, item }), ...routes },
      },
    ),
  );
  const dialog = await screen.findByRole('dialog', {
    name: language === 'sk' ? 'Prečo toto?' : 'Why this?',
  });
  await settled(app);
  return { ...app, dialog, panel: within(dialog), onClose, item };
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement) || node.getAttribute('aria-hidden') === 'true') return '';
  const children = () => Array.from(node.childNodes).map(textOf).join(' ');
  const name = node.getAttribute('aria-label');
  const role = node.getAttribute('role');
  if (node.tagName === 'BUTTON') return ` [${collapse(name ?? children())}] `;
  if (role === 'meter') {
    return ` <meter "${name ?? ''}" ${node.getAttribute('aria-valuetext') ?? ''}> `;
  }
  if (role === 'img') return ` <img "${name ?? ''}"> `;
  if (['H2', 'H3', 'H4'].includes(node.tagName)) return `\n## ${children()}\n`;
  if (node.tagName === 'LI') return `\n- ${collapse(children())}\n`;
  if (['DIV', 'P', 'UL', 'OL', 'SECTION'].includes(node.tagName)) return `\n${children()}\n`;
  return children();
}

/**
 * What the drawer says, one line per block: headings as `## …`, list items as `- …`, buttons as
 * `[name]`, meters and images by their accessible name and value, a list item on one line. Text
 * that is hidden from assistive technology is left out, text meant only for it is in.
 */
export function describeDrawer(root: HTMLElement): string {
  return textOf(root)
    .split('\n')
    .map(collapse)
    .filter((line) => line !== '')
    .join('\n');
}
