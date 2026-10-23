import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { useScheme } from '../a11y-support/screens.js';
import { fetchFeedNow } from '../reader-support/hooks.js';
import type { SubscriptionView } from '../reader-support/api.js';
import { callJson } from '../support/api.js';
import type { Control, NewFeedItem } from '../support/control.js';
import type { FeedKey } from '../support/env.js';
import { expect } from '../support/test.js';

/**
 * Helpers of the word-estimates scenario (visible-learning §4.4): a Training feed, a batch of
 * articles that arrive together, the rows of a feed view with their tier, the word model's status
 * and the words behind one estimate.
 */

/** A fixture article and what the reader does with it: a rating, or none (an unrated article). */
export interface PlannedItem {
  item: NewFeedItem;
  rating: 1 | -1 | null;
  /** Which of the unrated probes it is; null for a rated article. */
  probe: 'H1' | 'H2' | 'L1' | null;
}

/**
 * Ten rated articles, alternating like and dislike, then the three unrated ones (newest). Every
 * title and excerpt carries the tag of the test, so no other scenario's article matches it. The
 * words of the two classes do not overlap; the tag is in all of them.
 */
export function fixtureItems(tag: string): PlannedItem[] {
  const rated: Array<[1 | -1, string, string]> = [
    [
      1,
      'Lighthouse keepers restore a historic beacon',
      'Volunteers repaired the lantern room and the old harbour light shines again over the coast',
    ],
    [
      -1,
      'Celebrity couple splits after gossip column storm',
      'Tabloids chase the pop star and her actor ex through another weekend of gossip and rumours',
    ],
    [
      1,
      'Restored lighthouse reopens its spiral staircase',
      'The keepers cottage and the lantern room welcome visitors after a long restoration of the tower',
    ],
    [
      -1,
      'Pop star gossip dominates the weekend headlines',
      'Tabloids celebrate another round of celebrity rumours about a pop star and her actor friend',
    ],
    [
      1,
      'Lighthouse lens polished by retired keepers',
      'Retired keepers cleaned the brass and the great lens of the harbour light before the coast festival',
    ],
    [
      -1,
      'Celebrity chef feud fuels tabloid gossip',
      'Rival celebrity chefs trade insults and tabloids print every rumour of the red carpet feud',
    ],
    [
      1,
      'Volunteers repaint the coastal lighthouse tower',
      'A crew of volunteers repainted the tower and the lantern room of the old harbour light',
    ],
    [
      -1,
      'Red carpet gossip - who wore what at the premiere',
      'Celebrity fashion rumours and tabloid gossip from the red carpet premiere party',
    ],
    [
      1,
      'Lighthouse museum opens in the old keepers house',
      'The old keepers cottage now shows lenses lanterns and logbooks of the harbour light',
    ],
    [
      -1,
      'Actor spotted with pop star, tabloids go wild',
      'Gossip columns and tabloids chase the celebrity pair after the premiere party',
    ],
  ];
  const probes: Array<['H1' | 'H2' | 'L1', string, string]> = [
    [
      'H1',
      'Lighthouse volunteers relight a coastal beacon',
      'Keepers and volunteers restored the lantern room of the harbour light',
    ],
    [
      'H2',
      'Old lighthouse keepers cottage restored',
      'The restored cottage of the lighthouse keepers opens to visitors',
    ],
    [
      'L1',
      'Celebrity gossip dominates another weekend',
      'Tabloids chase the pop star and the actor through the premiere party',
    ],
  ];
  return [
    ...rated.map(([rating, title, excerpt]) => ({
      item: { title: `${title} (${tag})`, excerpt: `${excerpt} (${tag}).` },
      rating,
      probe: null,
    })),
    ...probes.map(([probe, title, excerpt]) => ({
      item: { title: `${title} (${tag})`, excerpt: `${excerpt} (${tag}).` },
      rating: null,
      probe,
    })),
  ];
}

/** Turns a subscription to Training: the feed's articles are not analyzed until one is selected. */
export async function startTraining(
  user: APIRequestContext,
  subscription: SubscriptionView,
): Promise<void> {
  await callJson<unknown>(user, 'POST', `/api/v1/subscriptions/${subscription.feed.id}/inference`, {
    data: { mode: 'training', expectedVersion: subscription.inferenceVersion },
  });
}

/**
 * All the items appear in a fixture feed at once and the worker fetches the feed once (a forced
 * fetch per item would wait for the publisher's feed budget each time). Returns the article ids
 * by title when every item is extracted.
 */
export async function arriveAll(
  control: Control,
  key: FeedKey,
  items: NewFeedItem[],
): Promise<Map<string, string>> {
  const feed = await control.feed(key);
  const titles = new Set<string>();
  for (const item of items) titles.add((await control.appendItem(key, item)).title);
  await fetchFeedNow(control, feed.url);
  const ids = new Map<string, string>();
  await expect
    .poll(
      async () => {
        for (const state of await control.articleStates(feed.url)) {
          if (
            titles.has(state.title) &&
            /^(extracted|translated|enriched|matched|degraded)$/.test(state.pipelineState)
          ) {
            ids.set(state.title, state.id);
          }
        }
        return ids.size;
      },
      {
        message: `${titles.size} appended articles are extracted`,
        timeout: 120_000,
        intervals: [1_000, 2_000],
      },
    )
    .toBe(titles.size);
  return ids;
}

export interface FeedRow {
  id: string;
  title: string;
  lane: string;
  tier: number | null;
  pLike: number | null;
  rating: 1 | -1 | null;
  readAt: string | null;
  analysis: { status: string; requestId: string | null };
}

/** The unread rows of one feed as the API lists them, at least `minTier` (default: every tier). */
export async function feedRows(
  user: APIRequestContext,
  feedId: string,
  { minTier = 1 }: { minTier?: number } = {},
): Promise<FeedRow[]> {
  const list = await callJson<{ items: FeedRow[] }>(user, 'GET', '/api/v1/articles', {
    params: { lane: 'all', feedId, status: 'unread', limit: 100, minTier },
  });
  return list.items;
}

/** The total of the lane counts of a feed view. */
export async function countOf(
  user: APIRequestContext,
  feedId: string,
  minTier: number,
): Promise<number> {
  const counts = await callJson<{ total: number }>(user, 'GET', '/api/v1/articles/counts', {
    params: { feedId, minTier },
  });
  return counts.total;
}

export interface WordWeight {
  feature: string;
  label: string;
  contribution: number;
}

export interface RowExplain {
  source: string;
  top: WordWeight[];
}

/** The explain of a row in a feed view: where its score came from and the words behind it. */
export async function rowExplain(
  user: APIRequestContext,
  articleId: string,
  feedId: string,
): Promise<RowExplain> {
  const detail = await callJson<{
    explain: { source: string; estimate?: { top: WordWeight[] } } | null;
  }>(user, 'GET', `/api/v1/articles/${articleId}`, { params: { sourceFeedId: feedId } });
  if (detail.explain === null) throw new Error(`article ${articleId} has no explain`);
  return { source: detail.explain.source, top: detail.explain.estimate?.top ?? [] };
}

export interface EstimatesView {
  n: number;
  auc: number | null;
  trainedAt: string;
  lastRun: { at: string; movedUp: number; movedDown: number } | null;
}

/** The word model's status (`GET /me/learning`); null while no model is stored. */
export async function estimatesOf(user: APIRequestContext): Promise<EstimatesView | null> {
  const learning = await callJson<{ estimates: EstimatesView | null }>(
    user,
    'GET',
    '/api/v1/me/learning',
  );
  return learning.estimates;
}

/** Waits until the model holds `rated` ratings and its refresh of the rows has run. */
export async function waitForEstimates(user: APIRequestContext, rated: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const estimates = await estimatesOf(user);
        if (estimates === null) return 'no model yet';
        if (estimates.n < rated) return `model of ${estimates.n} ratings`;
        return estimates.lastRun === null ? 'refresh pending' : 'refreshed';
      },
      {
        message: 'the word model has all ratings and its refresh ran',
        timeout: 90_000,
        intervals: [1_000, 2_000],
      },
    )
    .toBe('refreshed');
}

/**
 * The words a person should see for one direction: the model's own words, strongest first, each once.
 * `raised` takes the positive contributions, otherwise the negative ones.
 */
export function expectedWords(top: WordWeight[], raised: boolean): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  const ordered = top
    .filter((word) => (raised ? word.contribution > 0 : word.contribution < 0))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  for (const word of ordered) {
    const key = word.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word.label);
  }
  return words;
}

/**
 * Evidence for the review of the screens: with `E2E_SCREENSHOT_DIR` set, saves the page (or just
 * `element`) as `<name>-dark.png` and `<name>-light.png` and leaves it in the light scheme. Without
 * the variable, nothing.
 */
export async function snap(page: Page, name: string, element?: Locator): Promise<void> {
  const dir = process.env['E2E_SCREENSHOT_DIR'];
  if (dir === undefined || dir === '') return;
  for (const scheme of ['dark', 'light'] as const) {
    await useScheme(page, scheme);
    await (element ?? page).screenshot({ path: `${dir}/${name}-${scheme}.png` });
  }
}
