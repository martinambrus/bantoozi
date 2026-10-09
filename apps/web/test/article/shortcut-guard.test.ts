import { afterEach, describe, expect, it } from 'vitest';

import { shortcutBlocked } from '../../src/features/article/shortcut-guard.js';

afterEach(() => {
  document.body.replaceChildren();
});

/** Presses `key` on `target` and asks the guard about the event the page would have received. */
function press(init: KeyboardEventInit = {}, target: Element = document.body): boolean {
  const event = new KeyboardEvent('keydown', {
    key: '3',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return shortcutBlocked(event);
}

function add<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  parent: Element = document.body,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.append(element);
  return element;
}

describe('shortcutBlocked', () => {
  it('lets a key through that is pressed on the page', () => {
    expect(press()).toBe(false);
    expect(press({}, add('button'))).toBe(false);
    expect(press({}, add('a', { href: '#' }))).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    'blocks a key pressed with a modifier of the browser: %j',
    (init) => {
      expect(press(init)).toBe(true);
    },
  );

  it('lets Shift through, which the key for the overlay needs', () => {
    expect(press({ key: '?', shiftKey: true })).toBe(false);
  });

  it.each(['input', 'textarea', 'select'] as const)('blocks a key pressed in a %s', (tag) => {
    expect(press({}, add(tag))).toBe(true);
  });

  it('blocks a key pressed in an editable region, or in something inside one', () => {
    const editor = add('div', { contenteditable: 'true' });
    const inner = add('span', {}, editor);
    add('div', { contenteditable: '' });
    add('div', { contenteditable: 'plaintext-only' });

    expect(press({}, editor)).toBe(true);
    expect(press({}, inner)).toBe(true);
    expect(press({}, document.querySelector('[contenteditable=""]')!)).toBe(true);
    expect(press({}, document.querySelector('[contenteditable="plaintext-only"]')!)).toBe(true);
  });

  it('blocks a key pressed in an open menu, or on one of its items', () => {
    const menu = add('div', { role: 'menu' });
    const item = add('button', { role: 'menuitem' }, menu);

    expect(press({}, menu)).toBe(true);
    expect(press({}, item)).toBe(true);
  });

  it('lets a key through that is pressed where editing was switched off', () => {
    expect(press({}, add('div', { contenteditable: 'false' }))).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'blocks a key that belongs to an input method: %j',
    (init) => {
      expect(press(init)).toBe(true);
    },
  );

  it('blocks a key while a modal dialog is open, and not when it is closed', () => {
    const dialog = add('dialog');
    expect(press()).toBe(false);

    dialog.setAttribute('open', '');
    expect(press()).toBe(true);
    expect(press({}, add('button', {}, dialog))).toBe(true);

    dialog.removeAttribute('open');
    expect(press()).toBe(false);
  });

  it('blocks a key that something else has already taken', () => {
    const event = new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true });
    document.body.addEventListener('keydown', (other) => other.preventDefault(), { once: true });
    document.body.dispatchEvent(event);

    expect(shortcutBlocked(event)).toBe(true);
  });
});
