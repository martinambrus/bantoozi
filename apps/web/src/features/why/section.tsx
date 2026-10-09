import { useId, type ReactNode } from 'react';

export interface SectionProps {
  title: string;
  children: ReactNode;
}

/** One part of the drawer: a heading and what belongs under it. */
export function Section({ title, children }: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      {children}
    </section>
  );
}
