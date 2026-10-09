import type { Page } from '@playwright/test';

/**
 * How a row of a list looks on every animation frame from now until it is gone: a row that fades
 * out passes through opacities between 1 and 0, one that is removed without animation does not.
 */
export interface RowFrame {
  opacity: string;
  translate: string;
}

export interface RowWatch {
  frames: RowFrame[];
  /** The row is no longer in the page. */
  gone: boolean;
}

/** Starts watching the row of this article. */
export async function watchRow(page: Page, articleId: string): Promise<void> {
  await page.evaluate((id) => {
    const holder = window as typeof window & { __pwaRow?: RowWatch };
    const watch: RowWatch = { frames: [], gone: false };
    holder.__pwaRow = watch;
    const tick = () => {
      const row = document.querySelector(`li[data-article-id="${id}"]`);
      if (row === null) {
        watch.gone = true;
        return;
      }
      const style = getComputedStyle(row);
      const last = watch.frames.at(-1);
      if (
        last === undefined ||
        last.opacity !== style.opacity ||
        last.translate !== style.translate
      ) {
        watch.frames.push({ opacity: style.opacity, translate: style.translate });
      }
      requestAnimationFrame(tick);
    };
    tick();
  }, articleId);
}

/** What the watch has seen so far. */
export async function rowWatch(page: Page): Promise<RowWatch> {
  return page.evaluate(() => {
    const holder = window as typeof window & { __pwaRow?: RowWatch };
    if (holder.__pwaRow === undefined) throw new Error('no row is being watched');
    return { frames: [...holder.__pwaRow.frames], gone: holder.__pwaRow.gone };
  });
}
