import { readFile } from 'node:fs/promises';

import type { Locator, Page } from '@playwright/test';

import { newAccount, uniqueTag } from './reader-support/accounts.js';
import {
  articleByTitle,
  articleDetail,
  listArticles,
  subscribe,
  waitForExtraction,
} from './reader-support/api.js';
import { arrive, clearArticleText, markSnapshotCold } from './reader-support/hooks.js';
import { imageRequests, requestsFor, WORKER_AGENT } from './reader-support/origin.js';
import {
  chooseFeedImages,
  gotoFeeds,
  openArticle,
  refreshUntil,
  rowOf,
  unsubscribeFrom,
} from './reader-support/ui.js';
import { call, callJson } from './support/api.js';
import { expect, test } from './support/test.js';

interface ExportedBookmark {
  url: string | null;
  title: string;
  capture: { status: string; snapshotId: string | null; errorCode: string | null };
  snapshot: {
    id: string;
    completeness: string;
    text: string;
    html: string | null;
    mediaPolicyFeedId: string | null;
    effectiveImagesAllowed: boolean;
  } | null;
}

interface ExportDocument {
  subscriptions: Array<{ feedId: string }>;
  bookmarks: ExportedBookmark[];
}

/** The snapshot fields of the export (spec 08 §3): text and sanitized HTML, no media of any kind. */
const SNAPSHOT_FIELDS = [
  'author',
  'capturedAt',
  'completeness',
  'contentRevision',
  'effectiveImagesAllowed',
  'html',
  'id',
  'mediaPolicyFeedId',
  'publishedAt',
  'sourceUrl',
  'text',
  'title',
];

/** What the export may never carry for a bookmark: an embedded image or any media markup. */
const EMBEDDED_MEDIA =
  /data:[a-z]+\/[a-z0-9.+-]+[;,]|;base64,|<(img|picture|source|video|audio|svg)\b/i;

/** The export as the Settings page downloads it. */
async function downloadExport(page: Page): Promise<ExportDocument> {
  await page.goto('/settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download my data' }).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8')) as ExportDocument;
}

/** The saved copy in the open article: the section that has the "Saved copy" heading. */
function savedCopy(pane: Locator): Locator {
  return pane
    .locator('section')
    .filter({ has: pane.page().getByRole('heading', { level: 3, name: 'Saved copy' }) });
}

/** Every paragraph of the saved text is on screen. */
async function expectShows(section: Locator, text: string): Promise<void> {
  const rendered = (await section.innerText()).replace(/\s+/g, ' ');
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\s+/g, ' ').trim());
  expect(paragraphs.length).toBeGreaterThan(3);
  for (const paragraph of paragraphs) expect(rendered).toContain(paragraph);
}

/**
 * Spec 09 §9, scenario 8: a captured full page stays readable, with the same text and HTML, after
 * the reader unsubscribes, the page goes away and the snapshot is compressed; neither the saved
 * view nor the export carries image data even though the feed allows images; a partial and a failed
 * capture read differently; and nobody else can read the snapshot.
 */
test('bookmark mirror: the saved copy outlives the subscription, the page and compression', async ({
  api,
  browse,
  control,
}) => {
  test.setTimeout(150_000);

  const tag = uniqueTag();
  const email = newAccount('bookmark-mirror');
  const science = await control.feed('science');
  const page = await browse.as(email);
  const user = page.request;
  const other = await api.login(newAccount('bookmark-other'));

  const subscription = await subscribe(user, science.url);
  await subscribe(other, science.url);
  await waitForExtraction(control, science.url, 3);
  // A full page that embeds an image, new to this run so that its snapshot is its own: the capture
  // must keep the text and not the picture.
  const { item: full } = await arrive(control, 'science', {
    title: `Mirror ${tag} of a page with a picture`,
    excerpt: `The harbour survey of ${tag} is written down in full.`,
    image: true,
  });
  if (full.imageUrl === null) throw new Error('the appended item has no image');
  const imagePath = new URL(full.imageUrl).pathname;
  const partial = await arrive(
    control,
    'science',
    {
      title: `Partial capture ${tag} of a page that went away`,
      excerpt: `Only the feed excerpt of ${tag} survives.`,
    },
    { pageStatus: 404 },
  );
  const failed = await arrive(
    control,
    'science',
    {
      title: `Failed capture ${tag} of a page that went away`,
      excerpt: `Nothing of ${tag} survives.`,
    },
    { pageStatus: 404 },
  );
  // A feed item that came without any text: nothing is left to fall back on.
  await clearArticleText(control, failed.articleId);

  await test.step('the feed allows its images', async () => {
    await gotoFeeds(page);
    await chooseFeedImages(page, science.title, 'Always allow');
  });

  await test.step('bookmark a full page, a page that failed and an item with no text', async () => {
    await page.goto('/read/new');
    const titles = [full.title, partial.item.title, failed.item.title];
    await refreshUntil(page, async () => {
      for (const title of titles) await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
    });
    const pane = await openArticle(page, full.title);
    await pane.getByRole('button', { name: 'Bookmark' }).click();
    // A capture that is still pending is asked for again every 30 seconds (spec 09 §3.2).
    await expect(pane).toContainText('Full text saved', { timeout: 75_000 });
    for (const title of [partial.item.title, failed.item.title]) {
      await openArticle(page, title).then((opened) =>
        opened.getByRole('button', { name: 'Bookmark' }).click(),
      );
    }
    await expect
      .poll(
        async () =>
          (await listArticles(user, 'bookmarks', 'all'))
            .map((article) => `${article.title}: ${article.bookmarkCapture?.status}`)
            .sort(),
        { message: 'the three captures finish', timeout: 60_000, intervals: [500, 1_000] },
      )
      .toEqual(
        [
          `${full.title}: saved`,
          `${partial.item.title}: partial`,
          `${failed.item.title}: failed`,
        ].sort(),
      );
  });

  const article = await articleByTitle(user, full.title);
  const saved = (await articleDetail(user, article.id, true)).bookmarkSnapshot;
  if (saved === null) throw new Error('the bookmark has no saved copy');
  await test.step('the saved copy holds the whole text and no image', async () => {
    expect(saved).toMatchObject({
      completeness: 'complete',
      mediaPolicyFeedId: subscription.feed.id,
      effectiveImagesAllowed: true,
    });
    expect(saved.text.length).toBeGreaterThan(2_000);
    expect(saved.html).not.toBeNull();
    expect(`${saved.text}${saved.html}`).not.toMatch(EMBEDDED_MEDIA);
    expect(`${saved.text}${saved.html}`).not.toContain(imagePath);
  });
  const pageRequests = (await requestsFor(control, 'science', new URL(full.url).pathname)).length;

  await test.step('the reader unsubscribes from the feed', async () => {
    await gotoFeeds(page);
    await unsubscribeFrom(page, science.title);
  });

  await test.step('the original page fails and the snapshot is compressed', async () => {
    await control.scriptRoute('science', new URL(full.url).pathname, 404);
    await markSnapshotCold(control, saved.id);
  });

  const reader = await browse.as(email);
  await test.step('in a fresh browser the saved view shows the same text', async () => {
    await reader.goto('/read/bookmarks');
    await expect(reader.getByRole('heading', { level: 1, name: 'Bookmarks' })).toBeVisible();
    const pane = await openArticle(reader, full.title);
    await expect(pane).toContainText('Full text saved');
    await expect(pane).toContainText('Text and formatting saved; images and other media');
    await expectShows(savedCopy(pane), saved.text);
    await expect(pane.locator('img')).toHaveCount(0);
    await expect(pane.locator('[data-blocked-image]')).toHaveCount(0);
    await expect(pane.getByRole('link', { name: 'Original source' })).toHaveAttribute(
      'href',
      full.url,
    );

    const after = (await articleDetail(user, article.id, true)).bookmarkSnapshot;
    expect(after).toEqual(saved);
  });

  await test.step('the partial and the failed capture read differently', async () => {
    const partialPane = await openArticle(reader, partial.item.title);
    await expect(partialPane.getByText('Partial text saved')).toBeVisible();
    await expect(partialPane.getByText('Could not capture article')).toHaveCount(0);
    await expect(partialPane.getByRole('button', { name: 'Retry capture' })).toBeVisible();
    await expect(savedCopy(partialPane)).toContainText(`Only the feed excerpt of ${tag} survives.`);

    const failedPane = await openArticle(reader, failed.item.title);
    await expect(failedPane.getByText('Could not capture article')).toBeVisible();
    await expect(failedPane.getByText('Partial text saved')).toHaveCount(0);
    await expect(failedPane.getByRole('button', { name: 'Retry capture' })).toBeVisible();
    await expect(failedPane).not.toContainText('survives');

    const fullPane = await openArticle(reader, full.title);
    await expect(fullPane.getByRole('button', { name: 'Retry capture' })).toHaveCount(0);
  });

  await test.step('the export keeps the same text and HTML, without any image', async () => {
    const fromApi = await callJson<ExportDocument>(user, 'GET', '/api/v1/me/export');
    const fromSettings = await downloadExport(reader);
    for (const exported of [fromApi, fromSettings]) {
      expect(exported.subscriptions).toEqual([]);
      const byTitle = new Map(exported.bookmarks.map((bookmark) => [bookmark.title, bookmark]));
      expect([...byTitle.keys()].sort()).toEqual(
        [full.title, partial.item.title, failed.item.title].sort(),
      );

      const mirror = byTitle.get(full.title);
      expect(mirror?.capture).toMatchObject({ status: 'saved', snapshotId: saved.id });
      expect(mirror?.snapshot).toMatchObject({
        id: saved.id,
        completeness: 'complete',
        text: saved.text,
        html: saved.html,
        mediaPolicyFeedId: subscription.feed.id,
        effectiveImagesAllowed: true,
      });
      expect(byTitle.get(partial.item.title)?.capture.status).toBe('partial');
      expect(byTitle.get(failed.item.title)?.capture.status).toBe('failed');

      for (const bookmark of exported.bookmarks) {
        expect(JSON.stringify(bookmark)).not.toMatch(EMBEDDED_MEDIA);
        expect(JSON.stringify(bookmark)).not.toContain(imagePath);
        if (bookmark.snapshot !== null) {
          expect(Object.keys(bookmark.snapshot).sort()).toEqual(SNAPSHOT_FIELDS);
        }
      }
    }
  });

  await test.step('the publisher was asked neither for the page nor for an image', async () => {
    // Read from the database: the page was not fetched again, and the worker never fetched an image.
    expect(await requestsFor(control, 'science', new URL(full.url).pathname)).toHaveLength(
      pageRequests,
    );
    const images = await imageRequests(control, 'science');
    for (const request of images) expect(request.userAgent ?? '').not.toMatch(WORKER_AGENT);
  });

  await test.step('another account cannot read the snapshot', async () => {
    const response = await call(other, 'GET', `/api/v1/articles/${article.id}`, {
      params: { view: 'saved' },
    });
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain(saved.text.slice(-120));

    const plain = await articleDetail(other, article.id);
    expect(plain.bookmarkSnapshot).toBeNull();
    expect(plain.bookmarkedAt).toBeNull();

    const theirs = await callJson<ExportDocument>(other, 'GET', '/api/v1/me/export');
    expect(theirs.bookmarks).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain(saved.text.slice(-120));
  });
});
