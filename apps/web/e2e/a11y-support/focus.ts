import type { Locator, Page } from '@playwright/test';

import { expect } from '../support/test.js';

/** What a keyboard can reach in a dialog (the list modal.tsx hands the first focus by). */
const TABBABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface FocusAt {
  /** The element that has the focus: its tag and name, or `body`. */
  where: string;
  onBody: boolean;
  /** The focus is in the dialog that was asked about. */
  inside: boolean;
}

function focusAt(dialog: HTMLElement): FocusAt {
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) {
    return { where: 'body', onBody: true, inside: false };
  }
  const name = active.getAttribute('aria-label') ?? (active.textContent ?? '').trim();
  return {
    where: `${active.tagName.toLowerCase()} "${name.replace(/\s+/g, ' ').slice(0, 40)}"`,
    onBody: false,
    inside: dialog.contains(active),
  };
}

/** Where the focus is now, seen from a dialog. */
export function focusOf(dialog: Locator): Promise<FocusAt> {
  return dialog.evaluate(focusAt);
}

/**
 * The focus is on `target`. When it is not, the failure says where it is, which `toBeFocused`
 * does not.
 */
export async function expectFocusOn(target: Locator, what: string): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate((element, label) => {
          const active = document.activeElement;
          if (active === element) return label;
          if (active === null || active === document.body) return 'body';
          const name = active.getAttribute('aria-label') ?? '';
          return `${active.tagName.toLowerCase()}${active.id === '' ? '' : `#${active.id}`} ${name}`.trim();
        }, what),
      { message: `the focus is on ${what}` },
    )
    .toBe(what);
}

/** The dialog took the focus in when it opened. */
export async function expectFocusMovedIn(dialog: Locator): Promise<void> {
  await expect
    .poll(async () => (await focusOf(dialog)).inside, { message: 'the focus is in the dialog' })
    .toBe(true);
}

/**
 * Tab and Shift+Tab, pressed more often than the dialog has controls, never reach the page behind
 * a modal dialog. At either end the browser may take the focus for its own controls (the page then
 * has none), and the next press brings it back into the dialog.
 */
export async function expectTabsStayIn(page: Page, dialog: Locator): Promise<void> {
  const controls = await dialog.locator(TABBABLE).count();
  expect(controls, 'the dialog has controls to tab through').toBeGreaterThan(0);
  for (const key of ['Tab', 'Shift+Tab']) {
    const trail: FocusAt[] = [];
    for (let press = 0; press < controls + 2; press += 1) {
      await page.keyboard.press(key);
      trail.push(await focusOf(dialog));
    }
    const behind = trail.filter((stop) => !stop.inside && !stop.onBody);
    expect(
      behind.map((stop) => stop.where),
      `${key} reaches the page behind the dialog`,
    ).toEqual([]);
    const stuck = trail.filter((stop, index) => stop.onBody && trail[index + 1]?.onBody === true);
    expect(stuck.length, `${key} stays out of the dialog once it has left`).toBe(0);
    const stops = new Set(trail.filter((stop) => stop.inside).map((stop) => stop.where));
    expect(stops.size, `${key} moves between the controls of the dialog`).toBeGreaterThan(
      Math.min(1, controls - 1),
    );
  }
}

export interface FocusStop {
  where: string;
  onBody: boolean;
}

interface Recorder {
  stops: FocusStop[];
  stop(): void;
}

/**
 * Starts noting where the focus is on every animation frame. A focus that falls to the body is
 * the one a keyboard or screen-reader user loses, and no check made afterwards can tell that it
 * was there for a moment.
 */
export async function watchFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as typeof window & { __a11yFocus?: Recorder };
    holder.__a11yFocus?.stop();
    const stops: FocusStop[] = [];
    let running = true;
    let last = '';
    const describe = (element: Element | null): string => {
      if (element === null || element === document.body || element === document.documentElement) {
        return 'body';
      }
      const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();
      return `${element.tagName.toLowerCase()} "${name.replace(/\s+/g, ' ').slice(0, 40)}"`;
    };
    const tick = () => {
      if (!running) return;
      const where = describe(document.activeElement);
      if (where !== last) {
        stops.push({ where, onBody: where === 'body' });
        last = where;
      }
      requestAnimationFrame(tick);
    };
    holder.__a11yFocus = {
      stops,
      stop() {
        running = false;
      },
    };
    tick();
  });
}

/** Every place the focus has been since the watch began (or was last emptied), in order. */
export async function takeFocusStops(page: Page): Promise<FocusStop[]> {
  return page.evaluate(() => {
    const holder = window as typeof window & { __a11yFocus?: Recorder };
    if (holder.__a11yFocus === undefined) throw new Error('the focus is not being watched');
    return holder.__a11yFocus.stops.splice(0);
  });
}
