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

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  /** Null until the finger has gone far enough sideways. */
  started: { side: SwipeSide; action: SwipeAction; width: number } | null;
}

export interface SwipeOptions {
  /** What a swipe to `side` does now; null when it does nothing (`none`). */
  resolve(side: SwipeSide): SwipeAction | null;
  run(action: SwipeAction): void;
}

/**
 * The swipe of a row with a thumb or a pen (spec 09 §3.3): the content follows the finger, the
 * action shows past 15 % of the width, and lifting the finger past 35 % runs it. The browser keeps
 * vertical scrolling and pinch-zoom (`touch-action: pan-y pinch-zoom` on the row) and cancels the pointer when it takes over.
 */
export function useSwipe({ resolve, run }: SwipeOptions) {
  const gesture = useRef<Gesture | null>(null);
  const swallowUntil = useRef(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false);

  /** Follows `event` and returns where the content is now; null while no swipe has started. */
  function follow(event: PointerEvent<HTMLElement>): Drag | null {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.pointerId) return null;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.started === null) {
      if (Math.abs(dx) <= START_PX || Math.abs(dx) <= Math.abs(dy)) return null;
      const side = dx > 0 ? 'right' : 'left';
      const action = resolve(side);
      const width = event.currentTarget.getBoundingClientRect().width;
      if (action === null || !(width > 0)) return null;
      current.started = { side, action, width };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is gone already; its pointerup or pointercancel ends the swipe.
      }
      setSettling(false);
    }
    const { side, action, width } = current.started;
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

  return {
    drag,
    settling,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        swallowUntil.current = 0;
        if (!event.isPrimary || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
          return;
        }
        gesture.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          started: null,
        };
        setDrag(null);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const moved = follow(event);
        if (moved !== null) setDrag(moved);
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        const final = follow(event);
        const current = gesture.current;
        if (current === null || event.pointerId !== current.pointerId) return;
        gesture.current = null;
        setDrag(null);
        if (final === null) return;
        setSettling(true);
        swallowUntil.current = Date.now() + SWALLOW_CLICK_MS;
        if (final.armed) run(final.action);
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        const current = gesture.current;
        if (current === null || event.pointerId !== current.pointerId) return;
        gesture.current = null;
        setDrag(null);
        if (current.started !== null) setSettling(true);
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
