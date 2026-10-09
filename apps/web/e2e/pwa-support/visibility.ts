import type { Page } from '@playwright/test';

/**
 * The reader goes to the original in the other tab and comes back. The test browser never hides a
 * tab behind another one, so the page is told what a browser tells it: the document turns hidden
 * and then visible again, each with a `visibilitychange` event.
 */
export async function leaveAndComeBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const show = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    show('hidden');
    show('visible');
    // Back to the browser's own value.
    Reflect.deleteProperty(document, 'visibilityState');
  });
}
