import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {body === undefined ? null : (
        <div className="text-sm text-slate-600 dark:text-slate-300">{body}</div>
      )}
      {action}
    </div>
  );
}
