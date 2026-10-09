import type { Page } from '@playwright/test';

import { expect } from '../support/test.js';

/** A wide screen: the article sits beside the list. */
export const WIDE = { viewport: { width: 1280, height: 800 } };

/** A phone: the single-column layout, a bottom sheet for the article and a touch screen. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

export const SCHEMES = ['light', 'dark'] as const;
export type Scheme = (typeof SCHEMES)[number];

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

/** Puts the page in the colour scheme of the person's system and waits until the page follows. */
export async function useScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => isDark(page), { message: `the page is in the ${scheme} theme` })
    .toBe(scheme === 'dark');
}

/** Waits for the colour transitions and entrance animations to end, so that colours are read at rest. */
export async function atRest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.allSettled(running.map((animation) => animation.finished));
  });
}

/** Nothing on the page says it is still loading. */
export async function expectLoaded(page: Page): Promise<void> {
  await expect(page.getByRole('status', { name: 'Loading…' })).toHaveCount(0);
}

/** Nothing makes the page wider than the screen, so that it never has to be scrolled sideways. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: document.documentElement.clientWidth,
  }));
  expect(widths.page, 'the page is as wide as the screen').toBeLessThanOrEqual(widths.screen);
}
