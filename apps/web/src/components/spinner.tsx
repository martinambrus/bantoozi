import { cx } from './cx.js';

/** Decorative: the surrounding control or state carries the accessible name. */
export function Spinner({ className }: { className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0 motion-safe:animate-spin', className ?? 'size-5')}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={3} opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}
