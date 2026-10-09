import { stateOf } from './flow-support/articles.js';
import { articleRow, openNewLane, toastSaying } from './flow-support/rows.js';
import { Finger, swipeRight } from './flow-support/touch.js';
import { newAccount } from './reader-support/accounts.js';
import { subscribe, waitForExtraction } from './reader-support/api.js';
import { staysTrueFor } from './reader-support/wait.js';
import { expect, test } from './support/test.js';

/** A phone: narrow enough for the single-column layout, with a touch screen. */
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

/**
 * Spec 09 §9, scenario 6 (spec 09 §3.3): on a phone, a swipe to the right that travels at least 35 %
 * of a row's width likes the article, and a shorter one snaps back and changes nothing.
 */
test('mobile swipe: a right swipe past 35 % likes the item, a short one does nothing', async ({
  browse,
  control,
}) => {
  const email = newAccount('mobile-swipe');
  const culture = await control.feed('culture');
  const titles = culture.items.map((item) => item.title);
  expect(titles).toHaveLength(3);
  const [target, other] = titles;
  if (target === undefined || other === undefined) throw new Error('the culture feed has no items');
  const page = await browse.as(email, { context: PHONE });
  const user = page.request;

  await subscribe(user, culture.url);
  // A page that is read while the article is rated could change it under the rating.
  await waitForExtraction(control, culture.url, titles.length);
  await openNewLane(page, titles);

  await test.step('the page is in its phone layout and the article is unrated', async () => {
    expect(await page.evaluate(() => matchMedia('(min-width: 1024px)').matches)).toBe(false);
    expect(await page.evaluate(() => 'ontouchstart' in window)).toBe(true);
    expect(await stateOf(user, target)).toMatchObject({ rating: null, readAt: null });
  });

  const finger = await Finger.on(page);
  const row = articleRow(page, target);
  const feedback = row.locator('[data-swipe-action="like"]');

  await test.step('a swipe of 25 % shows the action and snaps back without rating', async () => {
    const swipe = await swipeRight(finger, row, 0.25);
    await expect(feedback).toBeVisible();
    await expect(feedback).not.toHaveAttribute('data-armed', 'true');
    await swipe.release();
    await expect(feedback).toBeHidden();
    await expect(row).toBeVisible();
    await staysTrueFor(1_500, async () => {
      await expect(toastSaying(page, 'Marked as liked')).toHaveCount(0);
      expect(await stateOf(user, target)).toMatchObject({ rating: null, readAt: null });
    });
    await expect(row.getByRole('button', { name: 'Like', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  await test.step('a swipe of 60 % arms the action and lifting the finger likes the article', async () => {
    const swipe = await swipeRight(finger, row, 0.6);
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveAttribute('data-armed', 'true');
    await swipe.release();
    await expect(toastSaying(page, 'Marked as liked')).toBeVisible();
    await expect
      .poll(() => stateOf(user, target), { message: 'the API holds the like' })
      .toMatchObject({ rating: 1, reason: null });
    expect((await stateOf(user, target)).readAt).not.toBeNull();
    await expect(articleRow(page, target)).toHaveCount(0);
  });

  await test.step('the other articles were not touched', async () => {
    await expect(articleRow(page, other)).toBeVisible();
    expect(await stateOf(user, other)).toMatchObject({ rating: null, readAt: null });
  });

  await finger.detach();
});
