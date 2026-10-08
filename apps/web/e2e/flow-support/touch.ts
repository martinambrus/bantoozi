import type { CDPSession, Locator, Page } from '@playwright/test';

/**
 * A finger on the screen of a page. Playwright 1.56 can tap but not drag, so the touch events come
 * from the DevTools protocol (`Input.dispatchTouchEvent`): the browser itself turns them into the
 * pointer events a thumb makes, with `pointerType: 'touch'`, and applies `touch-action` to them. The
 * page's context needs `hasTouch: true` (and `isMobile: true` for a phone's viewport).
 */

export interface Point {
  x: number;
  y: number;
}

/** The distance one move of the finger covers, so that a drag arrives as a series of moves. */
const STEP_PX = 12;

export class Finger {
  private constructor(private readonly session: CDPSession) {}

  static async on(page: Page): Promise<Finger> {
    return new Finger(await page.context().newCDPSession(page));
  }

  /** Puts the finger down at `at`. */
  async touch(at: Point): Promise<void> {
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  }

  /** Slides the finger in a straight line to `to`, in small moves. */
  async slide(from: Point, to: Point): Promise<void> {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / STEP_PX));
    for (let step = 1; step <= steps; step += 1) {
      const share = step / steps;
      await this.session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share }],
      });
    }
  }

  /** Lifts the finger. */
  async lift(): Promise<void> {
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async detach(): Promise<void> {
    await this.session.detach();
  }
}

/** A swipe to the right that has not been lifted yet. */
export interface SwipeInProgress {
  /** How far the finger has travelled, as a share of the row's width. */
  readonly share: number;
  /** Lifts the finger where it is. */
  release(): Promise<void>;
}

/**
 * Puts a finger down just inside the left edge of `row` and slides it right until it has travelled
 * `share` of the row's width, without lifting it. The row needs to be on screen.
 */
export async function swipeRight(
  finger: Finger,
  row: Locator,
  share: number,
): Promise<SwipeInProgress> {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (box === null) throw new Error('the row has no box to swipe on');
  const from: Point = { x: box.x + 10, y: box.y + box.height / 2 };
  const to: Point = { x: from.x + box.width * share, y: from.y };
  await finger.touch(from);
  await finger.slide(from, to);
  return { share, release: () => finger.lift() };
}
