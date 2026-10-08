import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog } from '../../../components/dialog.js';
import { Kbd } from './kbd.js';
import { SHORTCUT_GROUPS } from './keymap.js';

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

/** The `?` overlay (spec 09 §3.4): every shortcut of the reader, in groups. */
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const { t } = useTranslation('reader');
  const prefix = useId();

  return (
    <Dialog open={open} onClose={onClose} title={t('shortcuts.title')}>
      <div className="flex flex-col gap-5">
        {SHORTCUT_GROUPS.map((group) => {
          const headingId = `${prefix}-${group.id}`;
          return (
            <section key={group.id} aria-labelledby={headingId} className="flex flex-col gap-1">
              <h3
                id={headingId}
                className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300"
              >
                {t(`shortcuts.groups.${group.id}`)}
              </h3>
              <dl className="flex flex-col divide-y divide-slate-200 dark:divide-slate-700">
                {group.rows.map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-4 py-2">
                    <dt className="min-w-0 text-sm">{t(row.label)}</dt>
                    <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-sm">
                      {row.chord.map((part, index) =>
                        typeof part === 'string' ? (
                          <Kbd key={index}>{part}</Kbd>
                        ) : (
                          <span key={index} className="text-slate-600 dark:text-slate-300">
                            {t(`shortcuts.words.${part.word}`)}
                          </span>
                        ),
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('shortcuts.note')}</p>
      </div>
    </Dialog>
  );
}
