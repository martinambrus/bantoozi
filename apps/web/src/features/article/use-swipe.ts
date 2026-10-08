import { useDrag, type Vector2 } from '@use-gesture/react';
import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';

export type SwipeSide = 'left' | 'right';
export type SwipeAction = 'like' | 'dislike' | 'bookmark' | 'read';

/** Spec 09 §3.3: the finger has to go this far sideways, and more than it went up or down. */
const START_PX = 10;
/** Past this share of the width the action shows; at the commit share a release runs it. */
const SHOW_AT = 0.15;
const COMMIT_AT = 0.35;
/** The click that ends a swipe is not a press of what is under the finger. */
const SWALLOW_CLICK_MS = 400;

/** A swipe that is under way. */
export interface Drag {
  side: SwipeSide;
  action: SwipeAction;
  /** How far the content has moved, signed: positive to the right. */
  offset: number;
  /** The colour and name of the action are shown. */
  shows: boolean;
  /** Lifting the finger now runs the action. */
  armed: boolean;
}

/** What a swipe is once the finger has gone far enough sideways. */
interface Started {
  side: SwipeSide;
  action: SwipeAction;
  width: number;
}

export interface SwipeOptions {
  /** What a swipe to `side` does now; null when it does nothing (`none`). */
  resolve(side: SwipeSide): SwipeAction | null;
  run(action: SwipeAction): void;
}

/**
 * The swipe of a row with a thumb or a pen (spec 09 §3.3): the content follows the finger, the
 * action shows past 15 % of the width, and lifting the finger past 35 % runs it. The browser keeps
 * vertical scrolling and pinch-zoom (`touch-action: pan-y pinch-zoom` on the row) and cancels the
 * pointer when it takes over.
 */
export function useSwipe({ resolve, run }: SwipeOptions) {
  const started = useRef<Started | null>(null);
  const swallowUntil = useRef(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false);

  /** Follows `event` and returns where the content is now; null while no swipe has started. */
  function follow(event: PointerEvent<HTMLElement>, [x, y]: Vector2): Drag | null {
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    let current = started.current;
    if (current === null) {
      if (Math.abs(dx) <= START_PX || Math.abs(dx) <= Math.abs(dy)) return null;
      const side = dx > 0 ? 'right' : 'left';
      const action = resolve(side);
      const width = event.currentTarget.getBoundingClientRect().width;
      if (action === null || !(width > 0)) return null;
      current = { side, action, width };
      started.current = current;
      setSettling(false);
    }
    const { side, action, width } = current;
    const travelled = Math.min(Math.max(side === 'right' ? dx : -dx, 0), width);
    const progress = travelled / width;
    return {
      side,
      action,
      offset: side === 'right' ? travelled : -travelled,
      shows: progress > SHOW_AT,
      armed: progress >= COMMIT_AT,
    };
  }

  const bind = useDrag<PointerEvent<HTMLElement>>(
    ({ event, last, initial }) => {
      // A pointerdown starts afresh, also over a gesture whose end never came.
      if (event.type === 'pointerdown') {
        started.current = null;
        setDrag(null);
        return;
      }
      if (!last) {
        const moved = follow(event, initial);
        if (moved !== null) setDrag(moved);
        return;
      }
      // A release counts where the finger is lifted; use-gesture's movement stops at the last move.
      const final = event.type === 'pointerup' ? follow(event, initial) : null;
      const swiped = started.current !== null;
      started.current = null;
      setDrag(null);
      if (swiped) setSettling(true);
      if (final === null) return;
      swallowUntil.current = Date.now() + SWALLOW_CLICK_MS;
      if (final.armed) run(final.action);
    },
    // The pointer stays captured when the finger leaves the row. Any button state starts a swipe,
    // since a pen with its barrel button down is still a pen; the arrow keys never drag the row.
    { pointer: { capture: true, buttons: -1, keys: false } },
  );
  const bound = bind();

  return {
    drag,
    settling,
    handlers: {
      ...bound,
      onPointerDown(event: PointerEvent<HTMLElement>) {
        swallowUntil.current = 0;
        if (!event.isPrimary || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
          return;
        }
        bound.onPointerDown?.(event);
      },
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (Date.now() >= swallowUntil.current) return;
        swallowUntil.current = 0;
        event.stopPropagation();
        event.preventDefault();
      },
    },
  };
}
