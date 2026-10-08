import { useId, type KeyboardEvent, type ReactNode } from 'react';

import { FOCUS_RING, cx } from './cx.js';
import { FieldHelp, LABEL_CLASSES, useFieldIds } from './field.js';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean | undefined;
}

export interface SegmentedControlProps<V extends string> {
  /** Names the group. */
  label: ReactNode;
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string | undefined;
  className?: string | undefined;
}

/**
 * One choice out of a few, as a WAI-ARIA radio group: a single tab stop, arrow keys move the focus
 * and the selection together, Home and End jump to the ends, disabled options are skipped.
 */
export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onValueChange,
  hint,
  error,
  id: idProp,
  className,
}: SegmentedControlProps<V>) {
  const labelId = useId();
  const field = useFieldIds(idProp, { hint, error });
  const enabled = options.filter((option) => option.disabled !== true);
  const tabStop = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const from = enabled.findIndex((option) => option.value === focused?.dataset['value']);
    let target: SegmentedOption<V> | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = enabled[(from + 1) % enabled.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = enabled[from <= 0 ? enabled.length - 1 : from - 1];
        break;
      case 'Home':
        target = enabled[0];
        break;
      case 'End':
        target = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target === undefined) return;
    const next = target.value;
    onValueChange(next);
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    radios.find((radio) => radio.dataset['value'] === next)?.focus();
  }

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <span id={labelId} className={LABEL_CLASSES}>
        {label}
      </span>
      <div
        role="radiogroup"
        id={field.id}
        aria-labelledby={labelId}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid}
        onKeyDown={onKeyDown}
        className="inline-flex w-fit max-w-full rounded-lg border border-slate-500 p-0.5 dark:border-slate-400"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-value={option.value}
              tabIndex={option.value === tabStop ? 0 : -1}
              disabled={option.disabled}
              onClick={() => onValueChange(option.value)}
              className={cx(
                'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                selected
                  ? 'bg-indigo-600 font-semibold text-white dark:bg-indigo-400 dark:text-slate-950'
                  : 'font-medium text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
                FOCUS_RING,
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <FieldHelp hint={hint} hintId={field.hintId} error={error} errorId={field.errorId} />
    </div>
  );
}
