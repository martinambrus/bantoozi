import type { Page } from '@playwright/test';

/**
 * Where the keyboard focus goes, sampled on every animation frame. A focus that falls to the
 * document body is the one a keyboard or screen-reader user loses, and no single check after the
 * fact can tell that it was there for a moment; the recording can.
 */
export interface FocusStop {
  /** The element that has the focus: its tag and name, or `body`. */
  where: string;
  onBody: boolean;
  /** The article of the row the element is in, if it is in one. */
  articleId: string | null;
}

interface Recorder {
  stops: FocusStop[];
  stop(): void;
}

/** Starts recording; the first stop is where the focus is now. */
export async function recordFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as typeof window & { __pwaFocus?: Recorder };
    holder.__pwaFocus?.stop();
    const stops: FocusStop[] = [];
    const describe = (element: Element | null): FocusStop => {
      if (element === null || element === document.body || element === document.documentElement) {
        return { where: 'body', onBody: true, articleId: null };
      }
      const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();
      const row = element.closest('li[data-article-id]');
      return {
        where: `${element.tagName.toLowerCase()}: ${name.slice(0, 60)}`,
        onBody: false,
        articleId: row instanceof HTMLElement ? (row.dataset['articleId'] ?? null) : null,
      };
    };
    let last: FocusStop | null = null;
    let running = true;
    const tick = () => {
      if (!running) return;
      const now = describe(document.activeElement);
      if (last === null || now.where !== last.where || now.articleId !== last.articleId) {
        stops.push(now);
        last = now;
      }
      requestAnimationFrame(tick);
    };
    holder.__pwaFocus = {
      stops,
      stop() {
        running = false;
      },
    };
    tick();
  });
}

/** Every place the focus has been since the recording began (or was last emptied), in order. */
export async function takeFocusStops(page: Page): Promise<FocusStop[]> {
  return page.evaluate(() => {
    const holder = window as typeof window & { __pwaFocus?: Recorder };
    if (holder.__pwaFocus === undefined) throw new Error('the focus is not being recorded');
    return holder.__pwaFocus.stops.splice(0);
  });
}
