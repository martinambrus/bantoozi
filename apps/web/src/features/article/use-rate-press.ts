import { useRef, type MouseEvent, type PointerEvent } from 'react';

import type { RateOptions } from './use-article-actions.js';

/** Spec 09 §3.3: a press held this long, then released, rates and hides. */
const LONG_PRESS_MS = 500;
/** A thumb that moves further than this has not held the press. */
const SLOP_PX = 10;
/** The click that follows a long press is not another rating; a later one is. */
const SWALLOW_CLICK_MS = 400;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  at: number;
  moved: boolean;
}

/**
 * What makes a rating button also hide the article: Shift + click, and a press with a thumb or a
 * pen that is held for 500 ms and released. The mouse has Shift. While a thumb or a pen is down the
 * browser's own menu for a long press is kept away, since it would end the press.
 */
export function useRatePress(rate: (options?: RateOptions) => void) {
  const press = useRef<Press | null>(null);
  const swallowUntil = useRef(0);

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      swallowUntil.current = 0;
      press.current =
        event.pointerType === 'mouse'
          ? null
          : {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              at: Date.now(),
              moved: false,
            };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const current = press.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > SLOP_PX) {
        current.moved = true;
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const current = press.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      press.current = null;
      if (current.moved || Date.now() - current.at < LONG_PRESS_MS) return;
      swallowUntil.current = Date.now() + SWALLOW_CLICK_MS;
      rate({ hide: true });
    },
    onPointerCancel() {
      press.current = null;
    },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      if (press.current !== null) event.preventDefault();
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (Date.now() < swallowUntil.current) {
        swallowUntil.current = 0;
        return;
      }
      rate(event.shiftKey ? { hide: true } : undefined);
    },
  };
}
