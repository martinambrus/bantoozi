import { subscriptionsOf } from './reader-support/api.js';
import { newAccount } from './reader-support/accounts.js';
import { analysisRequests } from './reader-support/hooks.js';
import {
  addFeed,
  feedRow,
  gotoFeeds,
  openArticle,
  refreshUntil,
  rowOf,
} from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, scenario 2: a feed added on the Feeds page is Off, its items appear in New, and
 * polling, reading and adding a card make zero article-inference calls.
 */
test('add a feed: its mode is Off, its items appear in New and nothing is analyzed', async ({
  browse,
  control,
}) => {
  const email = newAccount('add-feed');
  const science = await control.feed('science');
  const titles = science.items.map((item) => item.title);
  expect(titles).toHaveLength(3);
  const [first] = science.items;
  if (first === undefined) throw new Error('the science fixture feed has no items');
  const page = await browse.as(email);

  await test.step('add the science fixture feed on the Feeds page', async () => {
    await gotoFeeds(page);
    await addFeed(page, science.url, science.title);
  });

  await test.step('the feed shows classification Off', async () => {
    await expect(feedRow(page, science.title)).toContainText(/Classification:\s*Off/);
    const subscriptions = await subscriptionsOf(page.request);
    expect(subscriptions.map((subscription) => subscription.inferenceMode)).toEqual(['off']);
  });

  await test.step('its three items appear in New, each marked as not analyzed', async () => {
    await page.goto('/read/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
    await refreshUntil(page, async () => {
      for (const title of titles) await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    for (const title of titles) {
      await expect(rowOf(page, title).getByText('Not analyzed', { exact: true })).toBeVisible();
    }
  });

  await test.step('an open reader polls on its idle timer without calling the model', async () => {
    // A second tab on a clock that can be moved forward: the idle poll is 30 seconds apart.
    const idle = await browse.as(email);
    await idle.clock.install();
    const polls: string[] = [];
    idle.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/articles/counts') polls.push(request.url());
    });
    await idle.goto('/read/new');
    await expect(idle.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
    await expect.poll(() => polls.length, { message: 'the counts load first' }).toBeGreaterThan(0);

    for (const round of [1, 2]) {
      const before = polls.length;
      // A timer that fires while the counts are still loading asks for nothing new, so a round
      // moves the clock on again until the poll has asked.
      await expect(async () => {
        await idle.clock.runFor(31_000);
        expect(polls.length, `idle poll ${round} asks for the counts`).toBeGreaterThan(before);
      }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] });
    }
    expect(await control.fakeCount()).toBe(0);
  });

  await test.step('opening an item to read it does not call the model', async () => {
    const pane = await openArticle(page, first.title);
    await expect(pane).toContainText(first.excerpt);
    await expect(pane.getByRole('button', { name: 'Read original' })).toBeVisible();
    await expect(rowOf(page, first.title).getByText('Read', { exact: true })).toBeVisible();
    expect(await control.fakeCount()).toBe(0);
  });

  await test.step('adding an interest card on the Interests page does not either', async () => {
    const interest = 'Meltwater lakes beneath the Greenland ice sheet';
    await page.goto('/interests');
    await page.getByRole('button', { name: 'New interest card' }).click();
    const editor = page.getByRole('dialog', { name: 'New interest card' });
    await editor.getByLabel(/I want to read about/).fill(interest);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('list', { name: 'Your interest cards' })).toContainText(interest);
  });

  await test.step('after everything, no model call and no analysis request exist', async () => {
    // Anything the card or the polling had queued would have started by now.
    await staysTrueFor(4_000, async () => {
      expect(await control.fakeCount()).toBe(0);
    });
    expect(await analysisRequests(control, email)).toEqual([]);
    const subscriptions = await subscriptionsOf(page.request);
    expect(subscriptions.map((subscription) => subscription.inferenceMode)).toEqual(['off']);
  });
});
