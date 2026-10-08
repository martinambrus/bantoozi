import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { newAccount } from '../reader-support/accounts.js';
import { subscribe } from '../reader-support/api.js';
import { articlePane, rowOf } from '../reader-support/ui.js';
import { callJson } from '../support/api.js';
import type { Control, FeedItem } from '../support/control.js';
import type { FeedKey } from '../support/env.js';
import { expect, type Browse } from '../support/test.js';

import { everyArticle, waitForTitles } from './api.js';

/**
 * What the PWA check does in the reader, as steps its tests share. They find things by role and
 * visible name and wait for the screen or the API to show the result.
 */

export interface Reader {
  email: string;
  page: Page;
  /** The signed-in API session of the page's browser context. */
  user: APIRequestContext;
  /** The items of the subscribed feeds, newest first within a feed. */
  items: FeedItem[];
}

export interface StartOptions {
  /** The fixture feeds to subscribe to; `tech` by default (three items, and no spec adds to it). */
  feeds?: readonly FeedKey[];
  /** The route to open; the New lane by default. */
  path?: string;
  /** Preferences to save before the page opens (`PATCH /me`). */
  preferences?: Record<string, unknown>;
}

/**
 * A new account in a browser of its own, subscribed to the fixture feeds, with the reader open on
 * a wide screen once every article of the feeds is listed.
 */
export async function startReader(
  { browse, control }: { browse: Browse; control: Control },
  label: string,
  { feeds = ['tech'], path = '/read/new', preferences }: StartOptions = {},
): Promise<Reader> {
  const email = newAccount(label);
  const page = await browse.as(email);
  const user = page.request;
  if (preferences !== undefined) {
    await callJson<unknown>(user, 'PATCH', '/api/v1/me', { data: { preferences } });
  }
  const items: FeedItem[] = [];
  for (const key of feeds) {
    const feed = await control.feed(key);
    await subscribe(user, feed.url);
    items.push(...feed.items);
  }
  await waitForTitles(
    user,
    items.map((item) => item.title),
  );
  await page.goto(path);
  for (const item of items) await expect(rowOf(page, item.title)).toBeVisible();
  return { email, page, user, items };
}

/**
 * The account holds the items of its feeds and no other article. The specs share one database, so
 * a feed that another spec appends to hands every later subscriber those articles too; the `tech`
 * feed is the one that stays as it was made.
 */
export async function expectOnlyItems(reader: Reader): Promise<void> {
  const held = [...(await everyArticle(reader.user)).values()].map((article) => article.title);
  expect(held.sort(), 'the account holds the items of its feeds and no other article').toEqual(
    reader.items.map((item) => item.title).sort(),
  );
}

/** The title of the fixture item about this topic (`quantum`, `robotics`, `firmware`, …). */
export function titleAbout(reader: Pick<Reader, 'items'>, topic: string): string {
  const found = reader.items.find((item) => item.topic === topic);
  if (found === undefined) throw new Error(`no fixture item is about "${topic}"`);
  return found.title;
}

export type RateButton = 'Like' | 'Dislike' | 'Bookmark';

/** A button of the row of one article (the detail pane repeats the same buttons). */
export function rowButton(page: Page, title: string, name: RateButton): Locator {
  return rowOf(page, title).getByRole('button', { name, exact: true });
}

/** The title of a row, which expands the article and takes the focus. */
export function rowTitle(page: Page, title: string): Locator {
  return rowOf(page, title).getByRole('button', { name: title, exact: true });
}

/** A button of the action bar in the article pane. */
export function paneButton(page: Page, name: string): Locator {
  return articlePane(page).getByRole('group', { name: 'Article actions' }).getByRole('button', {
    name,
    exact: true,
  });
}

/** Whether a rating button shows itself as pressed. */
export async function expectPressed(button: Locator, pressed: boolean): Promise<void> {
  await expect(button).toHaveAttribute('aria-pressed', String(pressed));
}

/** The toast that carries this text. */
export function toastWith(page: Page, text: string): Locator {
  return page.locator('[data-toast-id]').filter({ hasText: text });
}

/** The reason bar a dislike opens. */
export function reasonBar(page: Page): Locator {
  return page.getByRole('group', { name: 'Reason for the dislike' });
}

/** The header of the view: its title names the group. */
export function headerOf(page: Page, viewTitle: string): Locator {
  return page.getByRole('group', { name: viewTitle, exact: true });
}

async function chooseFromMoreMenu(page: Page, viewTitle: string, item: string): Promise<void> {
  await headerOf(page, viewTitle).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Opens the sheet of the actions that can still be undone. */
export async function openRecentActions(page: Page, viewTitle: string): Promise<Locator> {
  await chooseFromMoreMenu(page, viewTitle, 'Recent actions');
  const sheet = page.getByRole('dialog', { name: 'Recent actions' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** One entry of the recent actions: what was done and what it was done to. */
export function recentEntry(sheet: Locator, what: string, subject: string): Locator {
  return sheet.getByRole('listitem').filter({ hasText: what }).filter({ hasText: subject });
}

/** What the Hidden view says about why one article is hidden, and what can be done about it. */
export function causesOf(page: Page, title: string): Locator {
  return rowOf(page, title).getByRole('list', { name: `Why “${title}” is hidden` });
}

/** Opens the Hidden view through the More menu. */
export async function showHidden(page: Page, viewTitle: string): Promise<void> {
  await chooseFromMoreMenu(page, viewTitle, 'Show hidden');
  await expect(page).toHaveURL(/\/read\/hidden$/);
  await expect(headerOf(page, 'Hidden')).toBeVisible();
}
