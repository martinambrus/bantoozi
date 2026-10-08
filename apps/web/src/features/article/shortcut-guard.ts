/**
 * Whether a key is not for a keyboard shortcut of the page: the browser or the person typing has
 * it (a modifier, a field, an input method), something else already took it, or a modal dialog
 * has the focus of the page. Shift is not a modifier here, because `?` needs it.
 */
export function shortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null) {
    if (target.closest('input, textarea, select') !== null) return true;
    const editable = target.closest('[contenteditable]');
    if (editable !== null && editable.getAttribute('contenteditable') !== 'false') return true;
  }
  return document.querySelector('dialog[open]') !== null;
}
