import { useId, type ReactNode } from 'react';

import { FOCUS_RING, cx } from '../../components/cx.js';
import { WarningIcon } from '../../components/icons.js';

export const LINK = cx(
  'inline-flex min-h-11 items-center rounded font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200',
  FOCUS_RING,
);

export interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  tone?: 'default' | 'danger';
  children: ReactNode;
}

/** One block of the settings page; a region named by its heading. */
export function SettingsSection({
  title,
  description,
  tone = 'default',
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cx(
        'flex flex-col gap-4 rounded-xl border p-4 sm:p-6',
        tone === 'danger'
          ? 'border-red-300 dark:border-red-700'
          : 'border-slate-300 dark:border-slate-600',
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-xl font-semibold">
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="text-sm text-slate-600 dark:text-slate-300">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** A failure the person has to know about; announced as soon as it appears. */
export function Alert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cx(
        'flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300',
        className,
      )}
    >
      <WarningIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-sm text-slate-600 dark:text-slate-300', className)}>{children}</p>;
}
