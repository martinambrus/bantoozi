import { Link } from '@tanstack/react-router';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { FOCUS_RING, cx } from '../../components/cx.js';

export interface AuthLayoutProps {
  title: string;
  lead?: string | undefined;
  /** Receives the focus when the screen replaces its form with an answer. */
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  /** Rows of text with links, below the form. */
  footer?: ReactNode;
  children?: ReactNode;
}

/** The frame of the sign-in screens, which sit outside the app shell and so own their `<main>`. */
export function AuthLayout({ title, lead, headingRef, footer, children }: AuthLayoutProps) {
  const { t } = useTranslation('common');
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10 outline-none"
    >
      <p className="text-lg font-bold">{t('appName')}</p>
      <div className="flex flex-col gap-2">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">
          {title}
        </h1>
        {lead === undefined ? null : <p className="text-slate-600 dark:text-slate-300">{lead}</p>}
      </div>
      {children}
      {footer === undefined ? null : (
        <div className="flex flex-col text-sm text-slate-600 dark:text-slate-300">{footer}</div>
      )}
    </main>
  );
}

/** One footer row: a sentence ending in a link. */
export function AuthFooterRow({
  text,
  to,
  children,
}: {
  text: string;
  to: '/login' | '/waitlist';
  children: string;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5">
      <span>{text}</span>
      <Link
        to={to}
        className={cx(
          'inline-flex min-h-11 items-center rounded font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200',
          FOCUS_RING,
        )}
      >
        {children}
      </Link>
    </p>
  );
}
