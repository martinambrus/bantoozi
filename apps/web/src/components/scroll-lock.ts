let holders = 0;
let savedOverflow = '';

/**
 * Stops the page behind a modal from scrolling by hiding the overflow of `<html>`. Locks are
 * counted, so the page scrolls again, with the overflow it had before, when the last one is
 * released. Releasing the same lock twice does nothing.
 */
export function lockScroll(): () => void {
  const root = document.documentElement;
  if (holders === 0) {
    savedOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
  }
  holders += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) root.style.overflow = savedOverflow;
  };
}
