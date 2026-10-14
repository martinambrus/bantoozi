import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cx } from './cx.js';

/** What a trigger needs to carry its tooltip: spread it onto the one element that is described. */
export interface TooltipTriggerProps {
  'aria-describedby': string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent) => void;
  onBlur: (event: FocusEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

const GAP = 8;
const FALLBACK_WIDTH = 256;

/** A bubble that describes its trigger on hover and keyboard focus; Escape, blur and leaving hide it. */
export function Tooltip({
  text,
  className,
  children,
}: {
  text: string;
  className?: string | undefined;
  children: (props: TooltipTriggerProps) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ left: 0, top: 0 });
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  // Fixed placement so a scrolling ancestor (the reader sidebar) cannot clip the bubble.
  const place = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const width = bubbleRef.current?.offsetWidth || FALLBACK_WIDTH;
    const height = bubbleRef.current?.offsetHeight ?? 0;
    let left = rect.right + GAP;
    if (left + width > window.innerWidth - GAP) left = rect.left - GAP - width;
    left = Math.max(GAP, left);
    const top = Math.max(GAP, Math.min(rect.top, window.innerHeight - height - GAP));
    setPosition((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <span ref={wrapperRef} className={cx('inline-flex', className)}>
      {children({
        'aria-describedby': id,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
        onKeyDown: (event) => {
          if (event.key !== 'Escape' || !open) return;
          event.stopPropagation();
          setOpen(false);
        },
      })}
      <span
        ref={bubbleRef}
        id={id}
        style={position}
        role="tooltip"
        hidden={!open}
        className="pointer-events-none fixed z-50 w-64 max-w-[18rem] rounded-lg border border-slate-300 bg-white p-2 text-start text-xs font-normal text-slate-900 shadow-md dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      >
        {text}
      </span>
    </span>
  );
}
