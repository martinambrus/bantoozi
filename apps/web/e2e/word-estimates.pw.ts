import { AxeGate } from './a11y-support/axe.js';
import { expectLoaded } from './a11y-support/screens.js';
import { TargetGate } from './a11y-support/targets.js';
import { unreadTitles } from './flow-support/articles.js';
import {
  arriveAll,
  countOf,
  estimatesOf,
  expectedWords,
  feedRows,
  fixtureItems,
  rowExplain,
  snap,
  startTraining,
  waitForEstimates,
} from './flow-support/estimate.js';
import { engineCalls } from './flow-support/hooks.js';
import { articleRow } from './flow-support/rows.js';
import { rateFromAnotherDevice } from './pwa-support/api.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import { subscribe, subscriptionsOf } from './reader-support/api.js';
import { analysisRequests } from './reader-support/hooks.js';
import { refreshUntil, rowOf } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { callJson } from './support/api.js';
import { expect, test } from './support/test.js';

/*
 * This file must sort LAST among the specs: it leaves 13 more articles in the shared `science` feed,
 * and the specs that run after it would see them (their lists are paged at 30 rows).
 */

/**
 * Visible learning, word estimates: after ten ratings (five likes, five dislikes) in a Training feed
 * the word model trains and its refresh runs; the feed view at tier 2 and above lists the unrated
 * articles whose words the reader liked as estimated rows, Why this? names the words behind the
 * estimate, the Settings switch turns estimates off and on, and nothing was analyzed for the rows.
 */
test('word estimates: ten ratings give unanalyzed articles a tier, with the words behind it', async ({
  browse,
  control,
}) => {
  // Ingestion of 13 articles (about a page a second), the model (up to 30 s), the round trip.
  test.setTimeout(420_000);

  const email = newAccount('word-estimates');
  const tag = uniqueTag();
  const science = await control.feed('science');
  const page = await browse.as(email);
  const user = page.request;
  const planned = fixtureItems(tag);
  const rated = planned.filter((entry) => entry.rating !== null);
  const probe = (name: 'H1' | 'H2' | 'L1') => {
    const found = planned.find((entry) => entry.probe === name);
    if (found === undefined) throw new Error(`no fixture ${name}`);
    return found.item.title;
  };
  const [H1, H2, L1] = [probe('H1'), probe('H2'), probe('L1')] as [string, string, string];
  expect(rated).toHaveLength(10);

  const subscription = await subscribe(user, science.url);
  const feedId = subscription.feed.id;
  await startTraining(user, subscription);
  expect((await subscriptionsOf(user))[0]?.inferenceMode).toBe('training');

  const ids = await arriveAll(
    control,
    'science',
    planned.map((entry) => entry.item),
  );
  const idOf = (title: string): string => {
    const id = ids.get(title);
    if (id === undefined) throw new Error(`"${title}" did not arrive`);
    return id;
  };
  const probeIds = [H1, H2, L1].map(idOf);

  await test.step('before any rating: no model, no estimate, no marker', async () => {
    const rows = await feedRows(user, feedId);
    for (const title of [H1, H2, L1]) {
      const row = rows.find((item) => item.title === title);
      expect(row, `"${title}" is listed`).toBeDefined();
      expect(row).toMatchObject({ lane: 'new', tier: null, pLike: null });
      expect(row?.analysis.status).toBe('not_requested');
    }
    expect(await estimatesOf(user)).toBeNull();
    await page.goto(`/read/feed/${feedId}`);
    await refreshUntil(page, async () => {
      for (const title of [H1, H2, L1])
        await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    for (const title of [H1, H2, L1]) {
      await expect(articleRow(page, title).getByRole('button', { name: /^Estimated/ })).toHaveCount(
        0,
      );
    }
  });

  let modelWaitMs = 0;
  await test.step('ten ratings: the gate stays closed at nine and opens at ten', async () => {
    for (const [index, entry] of rated.entries()) {
      await rateFromAnotherDevice(user, idOf(entry.item.title), entry.rating);
      if (index === 8) expect(await estimatesOf(user)).toBeNull();
    }
    const started = Date.now();
    await waitForEstimates(user, 10);
    modelWaitMs = Date.now() - started;
    console.log(`estimates | model of 10 ratings and its refresh after ${modelWaitMs} ms`);
  });

  const rows = await feedRows(user, feedId);
  const row = (title: string) => {
    const found = rows.find((item) => item.title === title);
    if (found === undefined) throw new Error(`"${title}" is not listed`);
    return found;
  };

  await test.step('the API: estimated tiers, unrated and unanalyzed', async () => {
    for (const title of [H1, H2]) {
      const high = row(title);
      expect(high).toMatchObject({ lane: 'new', rating: null, readAt: null });
      expect(high.tier, `tier of "${title}"`).toBeGreaterThanOrEqual(4);
      expect(high.pLike ?? 0).toBeGreaterThan(0.85);
      expect(high.analysis).toMatchObject({ status: 'not_requested', requestId: null });
    }
    expect(row(L1)).toMatchObject({ lane: 'new', tier: 1, rating: null, readAt: null });

    const atTwo = await feedRows(user, feedId, { minTier: 2 });
    const titlesAtTwo = atTwo.map((item) => item.title);
    expect(titlesAtTwo).toEqual(expect.arrayContaining([H1, H2]));
    expect(titlesAtTwo).not.toContain(L1);
    expect(atTwo.length).toBeLessThan(100);
    expect(await countOf(user, feedId, 2)).toBe(atTwo.length);

    for (const lane of ['for_you', 'maybe']) {
      const titles = await unreadTitles(user, lane);
      expect(titles).not.toContain(H1);
      expect(titles).not.toContain(H2);
    }

    const estimates = await estimatesOf(user);
    expect(estimates?.n).toBe(10);
    expect(estimates?.auc ?? 0).toBeGreaterThanOrEqual(0.8);

    for (const title of [H1, L1]) {
      expect((await rowExplain(user, idOf(title), feedId)).source).toBe('estimate');
    }

    // Nothing selects an unrated article of a Training feed, so no request and no model call.
    await staysTrueFor(3_000, async () => {
      const requests = await analysisRequests(control, email);
      expect(requests.filter((request) => probeIds.includes(request.articleId))).toEqual([]);
      const calls = await engineCalls(control, email);
      expect(
        calls.filter((call) => call.articleId !== null && probeIds.includes(call.articleId)),
      ).toEqual([]);
    });
  });

  const axe = new AxeGate();
  const targets = new TargetGate();
  const marker = (title: string, tier: number) =>
    articleRow(page, title).getByRole('button', {
      name: `Estimated, tier ${tier} of 5, Why this?`,
      exact: true,
    });

  await test.step('the feed view: estimated rows carry the marker', async () => {
    await page.goto(`/read/feed/${feedId}`);
    await expect(page.getByRole('heading', { level: 1, name: science.title })).toBeVisible();
    await refreshUntil(page, async () => {
      for (const title of [H1, H2, L1])
        await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    for (const title of [H1, H2]) {
      await expect(marker(title, 5)).toBeVisible();
      await expect(marker(title, 5)).toContainText('Estimated');
      await expect(marker(title, 5).locator('[data-dot="outlined"]')).toHaveCount(5);
    }
    await expect(marker(L1, 1)).toBeVisible();
    await expect(marker(L1, 1).locator('[data-dot="outlined"]')).toHaveCount(1);

    await expectLoaded(page);
    await axe.scanBoth(page, 'Training feed, estimated rows');
    await targets.check(page, 'Training feed, estimated rows');
    await snap(page, 'feed-estimated-rows');
  });

  const drawerOf = () => page.getByRole('dialog', { name: 'Why this?' });
  const wordsOf = async (listName: string): Promise<string[]> => {
    const items = await drawerOf()
      .getByRole('list', { name: listName })
      .getByRole('listitem')
      .allTextContents();
    return items.map((text) => text.trim());
  };

  for (const [title, tier, name] of [
    [L1, 1, 'L1'],
    [H1, 5, 'H1'],
  ] as const) {
    await test.step(`Why this? of ${name} names the words behind the estimate`, async () => {
      await marker(title, tier).click();
      const drawer = drawerOf();
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('Estimated from the words of articles you rated.');
      await expect(
        drawer.getByRole('heading', { level: 3, name: 'Words behind this estimate' }),
      ).toBeVisible();
      await expect(drawer).toContainText(
        'These are patterns in the articles you rated, not reasons.',
      );

      const explain = await rowExplain(user, idOf(title), feedId);
      expect(explain.source).toBe('estimate');
      const raised = expectedWords(explain.top, true);
      const lowered = expectedWords(explain.top, false);
      for (const [words, list] of [
        [raised, 'Raised the estimate'],
        [lowered, 'Lowered the estimate'],
      ] as const) {
        if (words.length === 0) {
          await expect(drawer.getByRole('list', { name: list })).toHaveCount(0);
        } else {
          await expect(drawer.getByRole('list', { name: list })).toBeVisible();
          expect((await wordsOf(list)).map((word) => word.toLowerCase())).toEqual(
            words.map((word) => word.toLowerCase()),
          );
        }
      }
      if (name === 'H1') expect(raised.map((word) => word.toLowerCase())).toContain('lighthouse');
      else {
        expect(lowered.length).toBeGreaterThan(0);
        expect(
          lowered.some((word) =>
            ['celebrity', 'tabloids', 'pop', 'star', 'actor', 'gossip'].includes(
              word.toLowerCase(),
            ),
          ),
        ).toBe(true);
      }
      await expect(drawer).not.toContainText(/\b[tbe]:/);

      await expectLoaded(page);
      await axe.scanBoth(page, `Why this?, estimated row ${name}`, { modal: true });
      await targets.check(page, `Why this?, estimated row ${name}`, { within: 'dialog[open]' });
      if (name === 'L1') await snap(page, 'why-this-estimate');
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
    });
  }

  await test.step('the tier slider at 2 hides the low estimate only', async () => {
    const slider = page.getByRole('slider', { name: 'Minimum tier' });
    await slider.focus();
    await slider.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Tier 2 and above');
    await expect(rowOf(page, L1)).toHaveCount(0);
    await expect(rowOf(page, H1)).toBeVisible();
    await expect(rowOf(page, H2)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await callJson<{ preferences: { feedMinTier: number } }>(user, 'GET', '/api/v1/me'))
            .preferences.feedMinTier,
        { message: 'the minimum tier is saved' },
      )
      .toBe(2);
  });

  await test.step('Settings: the switch turns estimates off and on', async () => {
    const tierOf = async (title: string) =>
      (await feedRows(user, feedId)).find((item) => item.title === title)?.tier ?? null;
    await page.goto('/settings');
    const toggle = page.getByRole('switch', { name: 'Estimate unanalysed articles' });
    await expect(toggle).toBeChecked();
    await expect(page.getByText(/Word estimates are trained on 10 ratings/)).toBeVisible();
    await snap(
      page,
      'settings-estimates',
      page.getByRole('group', { name: 'Feedback and learning' }),
    );
    await snap(page, 'settings-learning', page.getByRole('region', { name: 'Personal learning' }));

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => tierOf(H1), {
        message: 'with estimates off the unanalyzed row has no tier',
        timeout: 90_000,
        intervals: [1_000, 2_000],
      })
      .toBeNull();

    await page.goto(`/read/feed/${feedId}`);
    await expect(page.getByRole('heading', { level: 1, name: science.title })).toBeVisible();
    await refreshUntil(page, async () => {
      await expect(rowOf(page, H1)).toHaveCount(0, { timeout: 1_500 });
    });

    await page.goto('/settings');
    const back = page.getByRole('switch', { name: 'Estimate unanalysed articles' });
    await expect(back).not.toBeChecked();
    await back.click();
    await expect(back).toBeChecked();
    await expect
      .poll(() => tierOf(H1), {
        message: 'with estimates on again the row has its tier',
        timeout: 90_000,
        intervals: [1_000, 2_000],
      })
      .toBe(5);

    await page.goto(`/read/feed/${feedId}`);
    await expect(page.getByRole('heading', { level: 1, name: science.title })).toBeVisible();
    await refreshUntil(page, async () => {
      await expect(marker(H1, 5)).toBeVisible({ timeout: 1_500 });
    });
  });

  console.log(`axe | ${axe.summary()}`);
  console.log(`targets | ${targets.summary()}`);
  expect(axe.blocking()).toEqual([]);
  expect(targets.problems).toEqual([]);
});
