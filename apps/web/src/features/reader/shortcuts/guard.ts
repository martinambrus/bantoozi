import { shortcutBlocked } from '../../article/shortcut-guard.js';

const CONTROLS = [
  'a[href]',
  'button',
  'summary',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="tab"]',
].join(',');

function inside(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

/**
 * Whether a key press is not for the reader's shortcuts (spec 09 §3.4): the person is typing, a
 * dialog or a menu has the keyboard, the browser has the key (a modifier, an input method) or
 * something else took it already.
 */
export function keyIgnored(event: KeyboardEvent): boolean {
  return shortcutBlocked(event);
}

/** CTRL+M, the one chord of the reader: Simple mode, as in FeedIt. */
export function isSimpleModeChord(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'm'
  );
}

/**
 * What keeps CTRL+M from the reader: the same as for the other keys, except the modifier that
 * makes it a chord.
 */
export function simpleModeChordIgnored(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  if (inside(event.target, 'input, textarea, select, [role="menu"]')) return true;
  const target = event.target instanceof Element ? event.target.closest('[contenteditable]') : null;
  if (target !== null && target.getAttribute('contenteditable') !== 'false') return true;
  return document.querySelector('dialog[open]') !== null;
}

/** Whether the focus is on something Enter acts on, such as a button or a link. */
export function onControl(target: EventTarget | null): boolean {
  return inside(target, CONTROLS);
}
