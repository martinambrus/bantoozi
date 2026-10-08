import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../components/cx.js';
import type { UpdateOffer } from './queries.js';

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-slate-300 p-3 dark:border-slate-600">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {children}
    </fieldset>
  );
}

function TextChange({
  label,
  from,
  to,
  offer,
  stacked,
}: {
  label: string;
  from: string | null;
  to: string | null;
  offer: UpdateOffer;
  stacked: boolean;
}) {
  const { t } = useTranslation('interests');
  return (
    <Group label={label}>
      <div className={cx('grid gap-2', stacked ? undefined : 'sm:grid-cols-2')}>
        <Group label={t('updates.currentVersion', { version: offer.fromVersion })}>
          <p className="break-words text-sm">{from ?? t('updates.none')}</p>
        </Group>
        <Group label={t('updates.newVersion', { version: offer.toVersion })}>
          <p className="break-words text-sm">{to ?? t('updates.none')}</p>
        </Group>
      </div>
    </Group>
  );
}

function ChangedExamples({ label, items }: { label: string; items: readonly string[] }) {
  const labelId = useId();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p id={labelId} className="text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col gap-1">
        {items.map((text) => (
          <li
            key={text}
            className="break-words rounded-md bg-slate-100 px-3 py-1 text-sm dark:bg-slate-800"
          >
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExamplesChange({
  label,
  change,
}: {
  label: string;
  change: { added: readonly string[]; removed: readonly string[] };
}) {
  const { t } = useTranslation('interests');
  if (change.added.length === 0 && change.removed.length === 0) return null;
  return (
    <Group label={label}>
      <ChangedExamples label={t('updates.removed')} items={change.removed} />
      <ChangedExamples label={t('updates.added')} items={change.added} />
    </Group>
  );
}

export interface UpdateDiffProps {
  offer: UpdateOffer;
  /** Puts the old and the new text one above the other, for a narrow place. */
  stacked?: boolean | undefined;
}

/** What the library changed between two versions of a card: only the fields that differ. */
export function UpdateDiff({ offer, stacked = false }: UpdateDiffProps) {
  const { t } = useTranslation('interests');
  const { diff } = offer;
  return (
    <div className="flex flex-col gap-3">
      {diff.title === null ? null : (
        <TextChange
          label={t('updates.fields.title')}
          from={diff.title.from}
          to={diff.title.to}
          offer={offer}
          stacked={stacked}
        />
      )}
      {diff.interest === null ? null : (
        <TextChange
          label={t('updates.fields.interest')}
          from={diff.interest.from}
          to={diff.interest.to}
          offer={offer}
          stacked={stacked}
        />
      )}
      {diff.notFor === null ? null : (
        <TextChange
          label={t('updates.fields.notFor')}
          from={diff.notFor.from}
          to={diff.notFor.to}
          offer={offer}
          stacked={stacked}
        />
      )}
      <ExamplesChange label={t('updates.fields.examplesYes')} change={diff.examplesYes} />
      <ExamplesChange label={t('updates.fields.examplesNo')} change={diff.examplesNo} />
    </div>
  );
}
