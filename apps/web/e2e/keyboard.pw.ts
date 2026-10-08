import { stateOf } from './flow-support/articles.js';
import {
  articleRow,
  openNewLane,
  reasonBar,
  rowButton,
  titleButton,
  toastSaying,
  waitForRows,
} from './flow-support/rows.js';
import { newAccount } from './reader-support/accounts.js';
import { subscribe, waitForExtraction } from './reader-support/api.js';
import { articlePane } from './reader-support/ui.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, scenario 5 (spec 09 §3.4): `j` and `k` move the focus between the rows, `=` likes the
 * focused article, `-` dislikes it and a digit picks the reason, `b` bookmarks it. Each key is
 * checked on the screen and through the API, and no other article is touched.
 */
test('keyboard: j and k move, = likes, - and a digit dislike with a reason, b bookmarks', async ({
  browse,
  control,
}) => {
  const email = newAccount('keyboard');
  const tech = await control.feed('tech');
  const titles = tech.items.map((item) => item.title);
  expect(titles).toHaveLength(3);
  // A wide screen (the default project viewport): the shortcuts exist from 1024 px on.
  const page = await browse.as(email);
  const user = page.request;

  await subscribe(user, tech.url);
  // A page that is read while the article is rated could change it under the rating.
  await waitForExtraction(control, tech.url, titles.length);
  await openNewLane(page, titles);
  const [first, second, third, ...rest] = await waitForRows(page, 3);
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error('the New lane lists fewer than three articles');
  }

  async function expectUntouched(title: string): Promise<void> {
    expect(await stateOf(user, title)).toMatchObject({
      rating: null,
      reason: null,
      bookmarkedAt: null,
    });
  }

  await test.step('j moves the focus to the first row and opens its article', async () => {
    await page.keyboard.press('j');
    await expect(titleButton(page, first)).toBeFocused();
    await expect(
      articlePane(page).getByRole('heading', { level: 2, name: first, exact: true }),
    ).toBeVisible();
    await expect(articleRow(page, first)).toContainText('Read');
    await expect.poll(async () => (await stateOf(user, first)).readAt).not.toBeNull();
    await expectUntouched(first);
  });

  await test.step('j again moves to the second row', async () => {
    await page.keyboard.press('j');
    await expect(titleButton(page, second)).toBeFocused();
    await expect(
      articlePane(page).getByRole('heading', { level: 2, name: second, exact: true }),
    ).toBeVisible();
  });

  await test.step('k moves back to the first row', async () => {
    await page.keyboard.press('k');
    await expect(titleButton(page, first)).toBeFocused();
    await expect(
      articlePane(page).getByRole('heading', { level: 2, name: first, exact: true }),
    ).toBeVisible();
    await expectUntouched(first);
    await expectUntouched(second);
  });

  await test.step('= likes the focused article, which leaves the list and passes the focus on', async () => {
    await page.keyboard.press('=');
    await expect(toastSaying(page, 'Marked as liked')).toBeVisible();
    await expect
      .poll(() => stateOf(user, first), { message: 'the API holds the like' })
      .toMatchObject({ rating: 1, reason: null });
    await expect(articleRow(page, first)).toHaveCount(0);
    await expect(titleButton(page, second)).toBeFocused();
    await expectUntouched(second);
  });

  await test.step('- dislikes the focused article and 1 picks "Off-topic" as the reason', async () => {
    await page.keyboard.press('-');
    await expect(reasonBar(page)).toContainText(`Disliked: ${second}`);
    // The dislike waits for its reason, so nothing has been stored yet.
    expect(await stateOf(user, second)).toMatchObject({ rating: null, reason: null });
    await page.keyboard.press('1');
    await expect(reasonBar(page)).toBeHidden();
    await expect(toastSaying(page, 'Marked as disliked')).toBeVisible();
    await expect
      .poll(() => stateOf(user, second), { message: 'the API holds the dislike and its reason' })
      .toMatchObject({ rating: -1, reason: 'off_topic' });
    await expect(articleRow(page, second)).toHaveCount(0);
    await expect(titleButton(page, third)).toBeFocused();
  });

  await test.step('b bookmarks the focused article, which stays in the list', async () => {
    await page.keyboard.press('b');
    await expect(rowButton(page, third, 'Bookmark')).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => (await stateOf(user, third)).bookmarkedAt, {
        message: 'the API holds the bookmark',
      })
      .not.toBeNull();
    expect(await stateOf(user, third)).toMatchObject({ rating: null, reason: null });
    await expect(articleRow(page, third)).toBeVisible();
  });

  await test.step('no key touched an article it was not on', async () => {
    expect(await stateOf(user, first)).toMatchObject({ rating: 1, bookmarkedAt: null });
    expect(await stateOf(user, second)).toMatchObject({ rating: -1, bookmarkedAt: null });
    for (const title of rest) await expectUntouched(title);
  });
});
