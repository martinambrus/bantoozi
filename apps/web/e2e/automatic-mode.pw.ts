import { newAccount, uniqueTag } from './reader-support/accounts.js';
import {
  articleByTitle,
  subscribe,
  subscriptionsOf,
  waitForExtraction,
} from './reader-support/api.js';
import { analysisRequests, arrive } from './reader-support/hooks.js';
import { gotoFeeds, openFeedSettings, refreshUntil, rowOf } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { callJson } from './support/api.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, scenario 7: enabling automatic classification applies to new arrivals only, and
 * switching Off while a request is running means stale work cannot call the model again.
 */
test('automatic mode: new arrivals only, and Off stops stale work', async ({ browse, control }) => {
  // Three round trips through the worker and one model call that lasts eight seconds.
  test.setTimeout(150_000);

  const email = newAccount('automatic-mode');
  const tag = uniqueTag();
  const culture = await control.feed('culture');
  const backlog = culture.items.map((item) => item.title);
  expect(backlog).toHaveLength(3);
  const [oldest] = backlog.slice(-1);
  if (oldest === undefined) throw new Error('the culture fixture feed has no items');
  const page = await browse.as(email);
  const user = page.request;

  const subscription = await subscribe(user, culture.url);
  await waitForExtraction(control, culture.url, backlog.length);
  // The arrival's title shares words with this card, so the fake model scores it a match.
  await callJson(user, 'POST', '/api/v1/cards', {
    data: { interest: 'Foghorn lighthouse restoration', strength: 'like' },
    expected: 201,
  });

  await test.step('explicitly enable automatic classification on the Feeds page', async () => {
    await gotoFeeds(page);
    const sheet = await openFeedSettings(page, culture.title);
    await sheet.getByRole('button', { name: 'Switch to training' }).click();
    await expect(
      sheet.getByText('Classification is now: Training: selected articles.'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Enable automatic classification' }).click();
    await expect(sheet.getByText('Classification is now: Active: new articles.')).toBeVisible();
    await expect(sheet).toContainText('Automatic classification has been on since');
    await sheet.getByRole('button', { name: 'Close' }).click();
    const [current] = await subscriptionsOf(user);
    expect(current?.inferenceMode).toBe('active');
  });

  await test.step('the backlog stays not analyzed and no request exists for it', async () => {
    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      for (const title of backlog) await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    for (const title of backlog) {
      await expect(rowOf(page, title).getByText('Not analyzed', { exact: true })).toBeVisible();
    }
    await staysTrueFor(4_000, async () => {
      expect(await control.fakeCount()).toBe(0);
      expect(await analysisRequests(control, email)).toEqual([]);
    });
  });

  const arrivalTitle = `Foghorn ${tag} revived by lighthouse volunteers`;
  await test.step('a new arrival is analyzed and leaves New', async () => {
    await arrive(control, 'culture', {
      title: arrivalTitle,
      excerpt: `Volunteers restored the old foghorn at the lighthouse on the headland (${tag}).`,
    });
    await page.goto('/read/for_you');
    await refreshUntil(
      page,
      async () => {
        await expect(rowOf(page, arrivalTitle)).toBeVisible({ timeout: 1_500 });
      },
      90_000,
    );
    await expect(rowOf(page, arrivalTitle).getByText('Not analyzed')).toHaveCount(0);

    const arrival = await articleByTitle(user, arrivalTitle);
    expect(arrival.lane).toBe('for_you');
    expect(arrival.analysis).toMatchObject({ mode: 'active', status: 'complete' });
    expect(await control.fakeCount()).toBeGreaterThan(0);

    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      for (const title of backlog) await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
      await expect(rowOf(page, arrivalTitle)).toHaveCount(0);
    });
    for (const title of backlog) {
      await expect(rowOf(page, title).getByText('Not analyzed', { exact: true })).toBeVisible();
    }
    // Automatic work needs no request, and the backlog still has none.
    expect(await analysisRequests(control, email)).toEqual([]);
  });

  // The feed settings are open before the slow call starts, so that Off is one click away while it
  // is in flight: the call lasts seconds, not minutes.
  await gotoFeeds(page);
  const sheet = await openFeedSettings(page, culture.title);

  let inFlight = 0;
  await test.step('a request is running on a slow model', async () => {
    await control.setFakeOptions({ latencyMs: 12_000 });
    const callsBefore = await control.fakeCount();
    const target = await articleByTitle(user, oldest);
    const [current] = await subscriptionsOf(user);
    await callJson(user, 'POST', `/api/v1/subscriptions/${subscription.feed.id}/analyze`, {
      data: {
        articles: [{ id: target.id, contentRevision: target.contentRevision }],
        expectedInferenceVersion: current?.inferenceVersion,
      },
      expected: 202,
    });
    await expect
      .poll(() => control.fakeCount(), {
        message: 'the model call of the request is in flight',
        timeout: 30_000,
        intervals: [250, 500],
      })
      .toBeGreaterThan(callsBefore);
    inFlight = await control.fakeCount();
    const requests = await analysisRequests(control, email);
    expect(requests.map((request) => request.status)).toEqual(['running']);
  });

  await test.step('switching classification Off in the UI cancels the stale request', async () => {
    await sheet.getByRole('button', { name: 'Turn classification off' }).click();
    await expect(sheet.getByText('Classification is now: Off.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    const [current] = await subscriptionsOf(user);
    expect(current?.inferenceMode).toBe('off');

    await expect
      .poll(
        async () =>
          (await analysisRequests(control, email)).map(
            (request) => `${request.status}:${request.errorCode}`,
          ),
        {
          message: 'the request is cancelled as revoked',
          timeout: 45_000,
          intervals: [500, 1_000],
        },
      )
      .toEqual(['cancelled:revoked']);
  });

  await test.step('no model call follows the one that was in flight', async () => {
    await control.setFakeOptions({ latencyMs: 50 });
    await staysTrueFor(3_000, async () => {
      expect(await control.fakeCount()).toBe(inFlight);
    });
  });

  await test.step('an arrival after Off is not analyzed either', async () => {
    const lateTitle = `Foghorn ${tag} second signal after Off`;
    await arrive(control, 'culture', {
      title: lateTitle,
      excerpt: `The lighthouse foghorn sounded again after the switch (${tag}).`,
    });
    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, lateTitle)).toBeVisible({ timeout: 1_500 });
    });
    await expect(rowOf(page, lateTitle).getByText('Not analyzed', { exact: true })).toBeVisible();
    await staysTrueFor(3_000, async () => {
      expect(await control.fakeCount()).toBe(inFlight);
    });
  });
});
