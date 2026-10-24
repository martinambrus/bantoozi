import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { renderApp } from '../support/app.js';
import { adminMe, adminRoutes, makeOverview, unhandledGuard } from './support.js';

/**
 * M8-T4 (PLAN §14): the admin overview shows the like-rate per lane (with the number of rated
 * articles) and the regret rate (the observed recovery from Everything/Hidden, numerator and
 * eligible denominator) of the latest snapshot, in English and Slovak, and says so when there is no
 * snapshot yet. The API field is `metrics` (see apps/api/test/admin-metrics.int.test.ts).
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const METRICS = {
  day: '2026-10-09',
  lanes: {
    for_you: { likeRate: 0.81, rated: 137 },
    maybe: { likeRate: 0.62, rated: 411 },
    everything: { likeRate: 0.14, rated: 229 },
    hidden: { likeRate: null, rated: 0 },
  },
  regret: { numerator: 17, denominator: 523, rate: 17 / 523 },
};

async function open(language: 'en' | 'sk', metrics: unknown) {
  return guard(
    await renderApp({
      path: '/admin',
      language,
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/overview': () => json(200, { ...makeOverview(), metrics }),
        }),
      },
    }),
  );
}

/** The nearest ancestor of `element` (within five levels) whose text holds `text`. */
function near(element: HTMLElement, text: string): HTMLElement | null {
  let current: HTMLElement | null = element;
  for (let level = 0; level < 5 && current !== null; level += 1) {
    if (current.textContent?.includes(text)) return current;
    current = current.parentElement;
  }
  return null;
}

const PERCENT = (value: number) => new RegExp(`(^|\\D)${value}\\s?%`);

describe('overview metrics (spec 10 §7, M8-T4)', () => {
  it('shows the like-rate and the rated count per lane and the regret rate in English', async () => {
    await open('en', METRICS);

    expect(await screen.findByText(/like.?rate/i)).toBeVisible();
    for (const [rate, count, lane] of [
      [81, '137', /for you/i],
      [62, '411', /maybe/i],
      [14, '229', /everything/i],
    ] as const) {
      const shown = screen.getByText(PERCENT(rate));
      const group = near(shown, count);
      expect(group, `${rate} % with ${count} rated`).not.toBeNull();
      expect(group?.textContent).toMatch(lane);
    }
    expect(screen.getByText(/regret/i)).toBeVisible();
    const regret = near(screen.getByText(/regret/i), '523');
    expect(regret, 'the regret rate with its denominator').not.toBeNull();
    expect(regret?.textContent).toMatch(/(^|\D)17(\D|$)/);
    expect(regret?.textContent).toMatch(/3\s?%/);
  });

  it('shows the same figures in Slovak, in Slovak words', async () => {
    await open('sk', METRICS);

    await screen.findByText(PERCENT(81));
    for (const [rate, count] of [
      [81, '137'],
      [62, '411'],
      [14, '229'],
    ] as const) {
      expect(
        near(screen.getByText(PERCENT(rate)), count),
        `${rate} % with ${count}`,
      ).not.toBeNull();
    }
    expect(document.body.textContent).toContain('523');
    expect(document.body.textContent).toMatch(/(^|\D)17(\D|$)/);
    // Not the English labels of the English page.
    expect(screen.queryByText(/like.?rate/i)).toBeNull();
    expect(screen.queryByText(/regret/i)).toBeNull();
  });

  it.each([
    ['en', /no data yet/i],
    ['sk', /údaj|zatiaľ|ešte/i],
  ] as const)('says there is no data yet when no snapshot exists (%s)', async (language, words) => {
    await open(language, null);

    await screen.findByText(words);
    expect(screen.queryByText(PERCENT(81))).toBeNull();
    // The rest of the overview is still there.
    expect(screen.getByText('120')).toBeVisible();
    if (language === 'sk') expect(screen.queryByText(/no data yet/i)).toBeNull();
  });
});

describe('overview budgeted spend', () => {
  it.each([
    ['en', 'Spend today', /plus .*1[.,]50.* evaluation spend/i],
    ['sk', 'Výdavky dnes', /navyše .*1[.,]50.* vyhodnocovanie/i],
  ] as const)('separates exempt spend from the budget (%s)', async (language, label, words) => {
    const overview = makeOverview();
    await guard(
      await renderApp({
        path: '/admin',
        language,
        server: {
          me: adminMe(),
          routes: adminRoutes({
            'GET /admin/overview': () =>
              json(200, {
                ...overview,
                engine: { ...overview.engine, exemptSpendTodayUsd: 1.5 },
              }),
          }),
        },
      }),
    );
    const tile = await screen.findByRole('group', { name: label });
    expect(within(tile).getByText(words)).toBeVisible();
    expect(tile.textContent).toMatch(/1[.,]20/);
    expect(tile.textContent).toMatch(/5[.,]00/);
  });

  it('omits the exempt spend note when it is zero', async () => {
    await open('en', null);
    await screen.findByRole('group', { name: 'Spend today' });
    expect(screen.queryByText(/evaluation spend/i)).toBeNull();
  });
});
