import { useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { WarningIcon } from '../../components/icons.js';
import { TextField } from '../../components/text-field.js';

export function PageTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold">{children}</h2>;
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="text-lg font-semibold">
      {children}
    </h3>
  );
}

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

export interface DataTableProps {
  caption: string;
  /** Keeps the caption for assistive technology only, when a heading already says it. */
  hideCaption?: boolean;
  columns: readonly string[];
  children: ReactNode;
}

export function DataTable({ caption, hideCaption = false, columns, children }: DataTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <caption className={cx('py-2 text-left text-base font-semibold', hideCaption && 'sr-only')}>
          {caption}
        </caption>
        <thead>
          <tr className="border-b border-slate-300 dark:border-slate-600">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-2 font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ className, ...rest }: ComponentProps<'td'>) {
  return <td {...rest} className={cx('px-3 py-2 align-top', className)} />;
}

export function RowHeader({ className, ...rest }: ComponentProps<'th'>) {
  return <th {...rest} scope="row" className={cx('px-3 py-2 text-left align-top', className)} />;
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">{children}</dl>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-medium text-slate-600 dark:text-slate-300">{label}</dt>
      <dd className="mb-2 break-words sm:mb-0">{children}</dd>
    </>
  );
}

export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation('admin');
  if (!hasMore) return null;
  return (
    <div className="flex justify-center">
      <Button variant="secondary" loading={loading} onClick={onLoadMore}>
        {t('common.loadMore')}
      </Button>
    </div>
  );
}

export interface SearchFormProps {
  label: string;
  /** The search text in force (from the address); typing is kept apart until it is submitted. */
  value: string;
  onSearch: (text: string) => void;
}

export function SearchForm({ label, value, onSearch }: SearchFormProps) {
  const { t } = useTranslation('admin');
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  return (
    <form
      role="search"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(text.trim());
      }}
      className="flex items-end gap-2"
    >
      <TextField
        type="search"
        label={label}
        value={text}
        maxLength={200}
        onChange={(event) => setText(event.target.value)}
        className="min-w-0 flex-1 sm:max-w-sm"
      />
      <Button type="submit" variant="secondary">
        {t('common.search')}
      </Button>
    </form>
  );
}
