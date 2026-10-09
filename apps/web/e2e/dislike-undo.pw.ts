import { stateOf, unreadTitles } from './flow-support/articles.js';
import { openNewLane, reasonBar, rowButton, articleRow, toastSaying } from './flow-support/rows.js';
import { newAccount } from './reader-support/accounts.js';
import { subscribe, waitForExtraction } from './reader-support/api.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, scenario 4: a dislike from the buttons of a row in an unread lane asks for a reason,
 * the row leaves the list, and Undo in the toast brings it back with no rating.
 */
test('dislike with a reason: the item leaves the list and Undo restores it', async ({
  browse,
  control,
}) => {
  const email = newAccount('dislike-undo');
  const science = await control.feed('science');
  const titles = science.items.map((item) => item.title);
  expect(titles).toHaveLength(3);
  const [target, ...others] = titles;
  if (target === undefined) throw new Error('the science fixture feed has no items');
  const page = await browse.as(email);
  const user = page.request;

  await subscribe(user, science.url);
  // A page that is read while the article is rated could change it under the rating.
  await waitForExtraction(control, science.url, titles.length);
  await openNewLane(page, titles);

  await test.step('the article is unread and unrated', async () => {
    const before = await stateOf(user, target);
    expect(before).toMatchObject({ rating: null, reason: null, readAt: null });
    await expect(articleRow(page, target)).toContainText('Unread');
    await expect(rowButton(page, target, 'Dislike')).toHaveAttribute('aria-pressed', 'false');
  });

  await test.step('Dislike on its row opens the reason bar and the row leaves the list', async () => {
    await rowButton(page, target, 'Dislike').click();
    await expect(reasonBar(page)).toContainText(`Disliked: ${target}`);
    await expect(articleRow(page, target)).toHaveCount(0);
    for (const title of others) await expect(articleRow(page, title)).toBeVisible();
    // The dislike waits for its reason, so nothing has been stored yet.
    expect(await stateOf(user, target)).toMatchObject({ rating: null, reason: null });
  });

  await test.step('picking "Off-topic" stores the rating with that reason and offers Undo', async () => {
    await reasonBar(page).getByRole('button', { name: 'Off-topic', exact: true }).click();
    await expect(reasonBar(page)).toBeHidden();
    const toast = toastSaying(page, 'Marked as disliked');
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect
      .poll(() => stateOf(user, target), { message: 'the API holds the dislike and its reason' })
      .toMatchObject({ rating: -1, reason: 'off_topic' });
    expect((await stateOf(user, target)).readAt).not.toBeNull();
    expect(await unreadTitles(user, 'new')).not.toContain(target);
    await expect(articleRow(page, target)).toHaveCount(0);
  });

  await test.step('Undo in the toast brings the row back with no rating', async () => {
    await toastSaying(page, 'Marked as disliked')
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    await expect(articleRow(page, target)).toBeVisible();
    await expect(rowButton(page, target, 'Dislike')).toHaveAttribute('aria-pressed', 'false');
    await expect(articleRow(page, target)).toContainText('Unread');
    await expect
      .poll(() => stateOf(user, target), { message: 'the API holds no rating any more' })
      .toMatchObject({ rating: null, reason: null, readAt: null });
    expect(await unreadTitles(user, 'new')).toContain(target);
  });
});
