import type { Page } from '@playwright/test';

import { analyzeArticle } from './a11y-support/analysis.js';
import { AxeGate } from './a11y-support/axe.js';
import {
  expectFocusMovedIn,
  expectFocusOn,
  expectTabsStayIn,
  takeFocusStops,
  watchFocus,
} from './a11y-support/focus.js';
import { PHONE, WIDE, expectLoaded, expectNoSidewaysScroll } from './a11y-support/screens.js';
import { TargetGate } from './a11y-support/targets.js';
import { installThemeProbe, readThemeProbe } from './a11y-support/theme-probe.js';
import { openNewLane, titleButton } from './flow-support/rows.js';
import { newAccount } from './reader-support/accounts.js';
import { subscribe, waitForExtraction } from './reader-support/api.js';
import { articlePane, openArticle, refreshUntil, rowOf } from './reader-support/ui.js';
import { callJson } from './support/api.js';
import type { FeedItem, FeedView } from './support/control.js';
import { URLS } from './support/env.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §1 (accessibility) and M6-T8: what only a real browser can check. axe finds nothing
 * serious or critical in the reader, the Why-this drawer and onboarding; a dialog takes the focus
 * in, keeps it and gives it back; the theme is on `<html>` before the app runs; every control of
 * the reader is at least 44 x 44 px.
 */

/** The fixture item about a topic word (the fake model matches a card that names it). */
function itemAbout(feed: FeedView, topic: string): FeedItem {
  const found = feed.items.find((item) => item.topic === topic);
  if (found === undefined)
    throw new Error(`the ${feed.key} fixture feed has no item about ${topic}`);
  return found;
}

/** The header of a view: a group named by its title. */
function headerOf(page: Page, viewTitle: string) {
  return page.getByRole('group', { name: viewTitle, exact: true });
}

async function expectStep(page: Page, step: number, title: string): Promise<void> {
  await expect(page.getByText(`Step ${step} of 4`, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
}

test('axe finds no serious or critical violation in the reader, the Why-this drawer and onboarding', async ({
  browse,
  control,
}) => {
  test.setTimeout(300_000);
  const axe = new AxeGate();
  const email = newAccount('a11y-axe');
  const science = await control.feed('science');
  const analyzed = itemAbout(science, 'exoplanet');
  const opened = itemAbout(science, 'glacier');
  const other = itemAbout(science, 'enzyme');
  const wide = await browse.as(email, { context: WIDE });
  const user = wide.request;
  // Opening an article would read it, and the phone opens the New lane next.
  await callJson<unknown>(user, 'PATCH', '/api/v1/me', {
    data: { preferences: { markReadOnExpand: false } },
  });

  const subscription = await subscribe(user, science.url);
  await waitForExtraction(control, science.url, science.items.length);
  // The fake model scores this card a match for the exoplanet story alone.
  await callJson<unknown>(user, 'POST', '/api/v1/cards', {
    data: {
      title: 'Exoplanet atmospheres',
      interest: 'Exoplanet atmospheres and their water vapour',
      strength: 'like',
    },
    expected: 201,
  });
  await analyzeArticle(user, subscription, analyzed.title);

  await test.step('the reader on a wide screen, with an article open beside the list', async () => {
    await openNewLane(wide, [opened.title, other.title]);
    const pane = await openArticle(wide, opened.title);
    await expect(pane).toContainText(opened.excerpt);
    await axe.scanBoth(wide, 'New lane, wide, article open');
  });

  await test.step('the reader on a phone, with the article in its sheet', async () => {
    const phone = await browse.as(email, { context: PHONE });
    await openNewLane(phone, [opened.title, other.title]);
    await titleButton(phone, opened.title).click();
    const sheet = phone.getByRole('dialog', { name: opened.title, exact: true });
    await expect(sheet).toContainText(opened.excerpt);
    await axe.scanBoth(phone, 'New lane, phone, article sheet', { modal: true });
  });

  await test.step('the Why-this drawer of an analyzed article', async () => {
    await wide.goto('/read/for_you');
    await refreshUntil(
      wide,
      async () => {
        await expect(rowOf(wide, analyzed.title)).toBeVisible({ timeout: 1_500 });
      },
      90_000,
    );
    const pane = await openArticle(wide, analyzed.title);
    await pane.getByRole('button', { name: 'Why this?', exact: true }).click();
    const drawer = wide.getByRole('dialog', { name: 'Why this?' });
    await expect(drawer.getByRole('list', { name: 'Your interests' })).toBeVisible();
    await expectLoaded(wide);
    await axe.scanBoth(wide, 'Why this?, wide', { modal: true });
    await wide.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  await test.step('every step of onboarding, with no analysis requested', async () => {
    const newcomer = await browse.as(newAccount('a11y-wizard'), {
      onboarded: false,
      context: WIDE,
    });
    await subscribe(newcomer.request, science.url);

    await newcomer.goto('/onboarding');
    await expectStep(newcomer, 1, 'Welcome to Bantoozi');
    await axe.scanBoth(newcomer, 'onboarding, welcome');

    await newcomer.getByRole('button', { name: 'Get started', exact: true }).click();
    await expectStep(newcomer, 2, 'Add your feeds');
    await expect(newcomer.getByRole('list', { name: 'Your feeds' })).toContainText(science.title);
    await expectLoaded(newcomer);
    await axe.scanBoth(newcomer, 'onboarding, feeds');

    await newcomer.getByRole('button', { name: 'Continue', exact: true }).click();
    await expectStep(newcomer, 3, 'What do you want to read about?');
    await expect(newcomer.getByRole('button', { pressed: false }).first()).toBeVisible();
    await expectLoaded(newcomer);
    await axe.scanBoth(newcomer, 'onboarding, interests');

    await newcomer.getByRole('button', { name: 'Continue', exact: true }).click();
    const warning = newcomer.getByRole('dialog', { name: 'Continue without interests?' });
    await expect(warning).toBeVisible();
    await axe.scanBoth(newcomer, 'onboarding, interests, no interests chosen', { modal: true });
    await warning.getByRole('button', { name: 'Continue anyway', exact: true }).click();

    await expectStep(newcomer, 4, 'Choose articles to teach Bantoozi');
    await expect(newcomer.getByText(opened.title, { exact: true })).toBeVisible();
    await expectLoaded(newcomer);
    await axe.scanBoth(newcomer, 'onboarding, articles to teach');
  });

  console.log(`axe | ${axe.summary()}`);
  expect(axe.blocking(), 'serious or critical axe violations').toEqual([]);
});

test('a dialog takes the focus in, keeps it there and gives it back when it closes', async ({
  browse,
  control,
}) => {
  test.setTimeout(180_000);
  const email = newAccount('a11y-focus');
  const science = await control.feed('science');
  const [article] = science.items;
  if (article === undefined) throw new Error('the science fixture feed has no items');
  const pottery = { title: 'Pottery wheels', interest: 'Throwing pots on a potter’s wheel' };
  const kiln = { title: 'Kiln firing', interest: 'Firing stoneware in a wood kiln' };
  const cards = [pottery, kiln];
  const page = await browse.as(email, { context: WIDE });
  const user = page.request;

  await subscribe(user, science.url);
  await waitForExtraction(control, science.url, science.items.length);
  for (const card of cards) {
    await callJson<unknown>(user, 'POST', '/api/v1/cards', {
      data: { ...card, strength: 'like' },
      expected: 201,
    });
  }

  await test.step('Why this? and the card editor it opens take the focus in and give it back', async () => {
    await openNewLane(
      page,
      science.items.map((item) => item.title),
    );
    const pane = await openArticle(page, article.title);
    const whyThis = pane.getByRole('button', { name: 'Why this?', exact: true });
    await whyThis.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Why this?' });
    await expect(drawer).toBeVisible();
    await expectFocusMovedIn(drawer);
    await expectTabsStayIn(page, drawer);

    const makeCard = drawer.getByRole('button', { name: 'Make a card from this', exact: true });
    await makeCard.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('dialog', { name: 'New card from this article' });
    await expect(editor).toBeVisible();
    await expectFocusMovedIn(editor);
    await expectTabsStayIn(page, editor);
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(makeCard).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(whyThis).toBeFocused();
  });

  await test.step('the card editor of the Interests page does the same', async () => {
    await page.goto('/interests');
    const list = page.getByRole('list', { name: 'Your interest cards' });
    const row = (title: string) => list.getByRole('listitem', { name: title, exact: true });
    for (const card of cards) await expect(row(card.title)).toBeVisible();

    const edit = row(pottery.title).getByRole('button', { name: 'Edit', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('dialog', { name: 'Edit interest card' });
    await expect(editor).toBeVisible();
    await expectFocusMovedIn(editor);
    await expectTabsStayIn(page, editor);
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(edit).toBeFocused();
  });

  await test.step('the question about deleting a card does too, and the deleted card leaves the focus on the list', async () => {
    const list = page.getByRole('list', { name: 'Your interest cards' });
    const doomed = list.getByRole('listitem', { name: pottery.title, exact: true });
    const remove = doomed.getByRole('button', { name: 'Delete', exact: true });
    await remove.focus();
    await page.keyboard.press('Enter');
    const question = page.getByRole('dialog', { name: 'Delete this card?' });
    await expect(question).toBeVisible();
    await expectFocusMovedIn(question);
    await expectTabsStayIn(page, question);
    await page.keyboard.press('Escape');
    await expect(question).toBeHidden();
    await expect(remove).toBeFocused();
    await expect(doomed).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(question).toBeVisible();
    await watchFocus(page);
    await question.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(doomed).toHaveCount(0);
    await expect(question).toBeHidden();
    await expectFocusOn(list, 'the list of cards');
    const stops = await takeFocusStops(page);
    expect(
      stops.filter((stop) => stop.onBody),
      'the focus was never on the body',
    ).toEqual([]);
    await expect(list.getByRole('listitem')).toHaveCount(cards.length - 1);
  });
});

test('the stored theme is on <html> before the app runs, and the CSP is not violated', async ({
  browser,
}) => {
  const cases = [
    { stored: 'dark', system: 'light', dark: true },
    { stored: 'light', system: 'dark', dark: false },
  ] as const;

  for (const { stored, system, dark } of cases) {
    await test.step(`"${stored}" is stored and the system is ${system}`, async () => {
      const context = await browser.newContext({
        baseURL: URLS.app,
        serviceWorkers: 'block',
        colorScheme: system,
      });
      try {
        await context.addInitScript(installThemeProbe, stored);
        const page = await context.newPage();
        const refused: string[] = [];
        page.on('console', (message) => {
          if (/content security policy/i.test(message.text())) refused.push(message.text());
        });

        const response = await page.goto('/login');
        expect(
          response?.headers()['content-security-policy'] ?? '',
          'the page is served with its CSP',
        ).toContain("script-src 'self'");
        await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

        const probe = await page.evaluate(readThemeProbe);
        if (probe === undefined) throw new Error('the page ran without the probe');
        const theme = { dark, colorScheme: dark ? 'dark' : 'light' };
        const interactive = probe.states.find((state) => state.readyState === 'interactive');
        expect(interactive, 'the document reached readyState interactive').toMatchObject(theme);
        expect(probe.firstFrame, 'the first frame').toMatchObject(theme);
        expect(probe.violations, 'violations the document reported').toEqual([]);
        expect(refused, 'CSP errors in the console').toEqual([]);

        // The app, once started, keeps what the script painted.
        await expect(page.locator('html')).toHaveClass(
          dark ? /(^|\s)dark(\s|$)/ : /^(?!.*\bdark\b)/,
        );
      } finally {
        await context.close();
      }
    });
  }
});

test('no control of the reader is smaller than 44 x 44 px', async ({ browse, control }) => {
  test.setTimeout(180_000);
  const gate = new TargetGate();
  const email = newAccount('a11y-targets');
  const science = await control.feed('science');
  const titles = science.items.map((item) => item.title);
  const opened = itemAbout(science, 'glacier');
  const wide = await browse.as(email, { context: WIDE });
  const user = wide.request;
  // Opening an article would read it, and the phone opens the New lane next.
  await callJson<unknown>(user, 'PATCH', '/api/v1/me', {
    data: { preferences: { markReadOnExpand: false } },
  });

  await subscribe(user, science.url);
  await waitForExtraction(control, science.url, titles.length);
  await callJson<unknown>(user, 'POST', '/api/v1/labels', {
    data: { name: 'Water', definition: 'Articles about water, ice and meltwater' },
    expected: 201,
  });

  await test.step('on a wide screen, with an article open', async () => {
    await openNewLane(wide, titles);
    const pane = await openArticle(wide, opened.title);
    await expect(pane).toContainText(opened.excerpt);
    await gate.check(wide, 'wide, article open');
  });

  await test.step('on a wide screen, with the More menu open', async () => {
    await headerOf(wide, 'New').getByRole('button', { name: 'More', exact: true }).click();
    await expect(wide.getByRole('menuitem', { name: 'Recent actions', exact: true })).toBeVisible();
    await gate.check(wide, 'wide, More menu open');
    await wide.keyboard.press('Escape');
    await expect(wide.getByRole('menu')).toHaveCount(0);
  });

  await test.step('on a wide screen, with the Labels menu of the article open', async () => {
    await articlePane(wide).getByRole('button', { name: 'Labels', exact: true }).click();
    await expect(wide.getByRole('menuitem', { name: 'Add label Water' })).toBeVisible();
    await gate.check(wide, 'wide, Labels menu open');
    await wide.keyboard.press('Escape');
    await expect(wide.getByRole('menu')).toHaveCount(0);
  });

  const phone = await browse.as(email, { context: PHONE });
  await test.step('on a phone, with the More menu open', async () => {
    await openNewLane(phone, titles);
    await expectNoSidewaysScroll(phone);
    await gate.check(phone, 'phone, list');
    await headerOf(phone, 'New').getByRole('button', { name: 'More', exact: true }).click();
    await expect(
      phone.getByRole('menuitem', { name: 'Recent actions', exact: true }),
    ).toBeVisible();
    await gate.check(phone, 'phone, More menu open');
    await phone.keyboard.press('Escape');
    await expect(phone.getByRole('menu')).toHaveCount(0);
  });

  await test.step('on a phone, with the article in its sheet and the Labels menu open', async () => {
    await titleButton(phone, opened.title).click();
    const sheet = phone.getByRole('dialog', { name: opened.title, exact: true });
    await expect(sheet).toContainText(opened.excerpt);
    await gate.check(phone, 'phone, article sheet', { within: 'dialog[open]' });
    await sheet.getByRole('button', { name: 'Labels', exact: true }).click();
    await expect(sheet.getByRole('menuitem', { name: 'Add label Water' })).toBeVisible();
    await gate.check(phone, 'phone, article sheet, Labels menu open', { within: 'dialog[open]' });
  });

  console.log(`targets | ${gate.summary()}`);
  expect(gate.problems, 'controls under 44 x 44 px').toEqual([]);
});
