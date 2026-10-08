/** A probability from 0 to 1 as the whole percent it is shown and announced as. */
export function percentOf(p: number): number {
  return Math.round(p * 100);
}

export interface MeterProps {
  /** The accessible name of the bar. */
  label: string;
  /** A probability from 0 to 1. */
  value: number;
  /** The value in words, which assistive technology reads instead of the bare number. */
  valueText: string;
}

/** A labelled bar for a probability (the bar itself is decorative for sighted readers). */
export function Meter({ label, value, valueText }: MeterProps) {
  const percent = percentOf(value);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
    >
      <div
        className="h-full rounded-full bg-indigo-600 dark:bg-indigo-400"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
