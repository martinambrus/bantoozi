import { useTranslation } from 'react-i18next';

import { Kbd } from './kbd.js';
import { GO_KEYS, MUTE_KEYS, type Sequence } from './keymap.js';

export interface PendingHintProps {
  /** The key that waits for the next one, if any. */
  sequence: Sequence | null;
}

/**
 * Says which keys the waiting sequence takes (spec 09 §3.4): a polite live region for assistive
 * technology, which is always there so that what it gets is announced, and a hint in view.
 */
export function PendingHint({ sequence }: PendingHintProps) {
  const { t } = useTranslation('reader');

  const options =
    sequence === null
      ? []
      : sequence === 'g'
        ? GO_KEYS.map(([key, lane]) => ({ key, label: t(`lanes.${lane}`) }))
        : MUTE_KEYS.map(([key, days]) => ({
            key,
            label: t('shortcuts.pending.days', { count: days }),
          }));

  return (
    <>
      <div aria-live="polite" className="sr-only">
        {sequence === null
          ? null
          : t(`shortcuts.pending.${sequence}`, {
              pressed: sequence,
              options: options.map(({ key, label }) => `${key} – ${label}`).join(', '),
            })}
      </div>
      {sequence === null ? null : (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed bottom-4 left-4 z-40 flex max-w-sm flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-2 border-slate-500 bg-white p-3 text-sm text-slate-900 shadow-lg dark:border-slate-400 dark:bg-slate-800 dark:text-slate-100"
        >
          <span className="inline-flex items-center gap-1.5">
            <Kbd>{sequence}</Kbd>
            {t(`shortcuts.pending.${sequence}Lead`)}
          </span>
          {options.map(({ key, label }) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <Kbd>{key}</Kbd>
              {label}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
