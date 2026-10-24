import type { DislikePattern } from '@bantoozi/shared';

import { arriveAll, startTraining } from './flow-support/estimate.js';
import { articleRow, reasonBar } from './flow-support/rows.js';
import { fieldsOf } from './pwa-support/api.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import { subscribe } from './reader-support/api.js';
import { refreshUntil } from './reader-support/ui.js';
import { callJson } from './support/api.js';
import { expect, test } from './support/test.js';

test('a Training feed pattern opens the Never editor with its three articles', async ({
  browse,
  control,
}) => {
  test.setTimeout(180_000);
  const page = await browse.as(newAccount('dislike-pattern'));
  const feed = await control.feed('science');
  const subscription = await subscribe(page.request, feed.url);
  await startTraining(page.request, subscription);
  const tag = uniqueTag();
  const titles = [
    'Škoda 105 L zadné svetlo',
    'Škoda 105 L blatník predný',
    'Škoda 105 L sedadlá',
  ].map((title) => `${title} ${tag}`);
  const ids = await arriveAll(
    control,
    'science',
    titles.map((title) => ({ title, excerpt: title })),
  );
  for (const title of titles.slice(0, 2)) {
    const id = ids.get(title)!;
    const item = await fieldsOf(page.request, id);
    await callJson(page.request, 'POST', `/api/v1/articles/${id}/rating`, {
      data: {
        rating: -1,
        reason: 'off_topic',
        stateVersion: item.stateVersion,
        contentRevision: item.contentRevision,
      },
    });
  }
  const target = titles[2]!;
  const targetId = ids.get(target)!;
  await page.goto(`/read/feed/${subscription.feed.id}`);
  await refreshUntil(page, async () => {
    await expect(articleRow(page, target)).toBeVisible({ timeout: 1500 });
  });
  const response = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/articles/${targetId}/rating`) && res.request().method() === 'POST',
  );
  await articleRow(page, target).getByRole('button', { name: 'Dislike', exact: true }).click();
  await reasonBar(page).getByRole('button', { name: 'Off-topic', exact: true }).click();
  const body = (await (await response).json()) as { pattern: DislikePattern | null };
  expect(body.pattern).toMatchObject({ kind: 'feed', feedId: subscription.feed.id });
  expect(body.pattern?.offer).toHaveLength(3);
  const drafted = page.waitForRequest(
    (req) => req.url().endsWith('/cards/drafts') && req.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Make a Never card from these', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New card from these articles', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('radio', { name: 'Never', exact: true })).toBeChecked();
  expect((await drafted).postDataJSON()).toEqual({
    articleIds: body.pattern?.offer,
    kind: 'never',
  });
  expect(body.pattern?.offer).toEqual(expect.arrayContaining([...ids.values()]));
});
