import { createRef, type RefObject } from 'react';

/**
 * What the keys act on outside the page of the article list. The sidebar and the header hold these
 * for as long as they offer them, and the shortcuts reach them from here.
 */
export interface ReaderTargets {
  /** The field that filters the feeds of the sidebar; none while the sidebar has no feeds. */
  feedFilter: RefObject<HTMLInputElement | null>;
  /** Opens the confirmation of "Mark all read"; none while that button is missing or disabled. */
  markAllRead: RefObject<(() => void) | null>;
}

export function createTargets(): ReaderTargets {
  return {
    feedFilter: createRef<HTMLInputElement>(),
    markAllRead: createRef<() => void>(),
  };
}
