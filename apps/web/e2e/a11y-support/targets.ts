import type { Page } from '@playwright/test';

/** The least size of a target in CSS pixels (spec 09 §1); axe's own rule only checks 24. */
const MIN_PX = 44;

export interface SmallTarget {
  /** Role and name of the control, as a person would say it. */
  control: string;
  width: number;
  height: number;
  count: number;
}

interface Measure {
  min: number;
  /** Only the controls inside the elements this selects; the whole page when null. */
  within: string | null;
}

/**
 * The visible buttons, links, inputs, selects, checkboxes, radios, switches and menu items of the
 * page that are smaller than 44 x 44 px. A checkbox or radio is as big as its label, which is what
 * a press on it reaches; a link inside the running text of an article is exempt (WCAG 2.5.8).
 */
function measure({ min, within }: Measure): SmallTarget[] {
  const SELECTOR = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
  ].join(',');

  const shown = (element: Element): boolean => {
    if (getComputedStyle(element).visibility === 'hidden') return false;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (node.hasAttribute('inert') || getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  };

  // Clipped to a pixel is how a control is hidden from the eye and kept for a screen reader.
  const boxOf = (element: Element): { width: number; height: number } | null => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && shown(element) ? rect : null;
  };

  const nameOf = (element: Element): string => {
    const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
    const text = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return `${role} "${text.replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
  };

  const scopes: ParentNode[] =
    within === null ? [document] : Array.from(document.querySelectorAll(within));
  const controls = new Set<Element>(
    scopes.flatMap((scope) => [...scope.querySelectorAll(SELECTOR)]),
  );

  const found = new Map<string, SmallTarget>();
  for (const element of controls) {
    if (element instanceof HTMLAnchorElement && element.closest('.leading-relaxed') !== null) {
      continue;
    }
    const checkable =
      element instanceof HTMLInputElement &&
      (element.type === 'checkbox' || element.type === 'radio');
    const boxes = [element, ...(checkable ? Array.from(element.labels ?? []) : [])]
      .map(boxOf)
      .filter((box) => box !== null);
    const best = boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (best === undefined) continue;
    const width = Math.round(best.width * 100) / 100;
    const height = Math.round(best.height * 100) / 100;
    if (width >= min - 0.01 && height >= min - 0.01) continue;
    const control = nameOf(element);
    const key = `${control} ${width}x${height}`;
    const seen = found.get(key);
    if (seen === undefined) found.set(key, { control, width, height, count: 1 });
    else seen.count += 1;
  }
  return [...found.values()];
}

export interface CheckOptions {
  /** A selector for the part of the page to measure, e.g. the open dialog while a modal is up. */
  within?: string;
}

/** Measures the controls of the screens a test visits, prints what is too small and keeps it. */
export class TargetGate {
  readonly problems: string[] = [];
  private screens = 0;

  async check(page: Page, where: string, { within }: CheckOptions = {}): Promise<void> {
    const small = await page.evaluate(measure, { min: MIN_PX, within: within ?? null });
    this.screens += 1;
    console.log(`targets | ${where} | ${small.length} control(s) under ${MIN_PX} x ${MIN_PX} px`);
    for (const target of small) {
      const line = `${where}: ${target.control} is ${target.width} x ${target.height} px (${target.count}x)`;
      this.problems.push(line);
      console.log(`targets |   ${line}`);
    }
  }

  summary(): string {
    return `${this.screens} screen(s) measured, ${this.problems.length} control(s) too small`;
  }
}
