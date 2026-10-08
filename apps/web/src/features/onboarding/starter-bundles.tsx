import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { errorMessage, quotaDetails, quotaMessage } from '../../components/error-message.js';
import { CheckIcon, WarningIcon } from '../../components/icons.js';
import { InlineAlert } from '../feeds/inline-alert.js';
import { NEEDS_CHOICE, useBundleImport, type BundleRun, type ImportRow } from './bundle-import.js';
import { BUNDLES, type StarterBundle } from './bundles.js';

function Row({ row }: { row: ImportRow }) {
  const { t } = useTranslation('onboarding');
  const failed = row.status === 'failed';
  return (
    <li className="flex flex-col gap-0.5 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="break-all font-medium">{row.title ?? row.url}</span>
        <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200">
          {row.status === 'added' || row.status === 'existing' ? (
            <CheckIcon className="size-3.5" />
          ) : null}
          {failed ? <WarningIcon className="size-3.5" /> : null}
          {t(`bundles.status.${row.status}`)}
        </span>
      </div>
      {failed && quotaDetails(row.error) === null ? (
        <span className="text-slate-600 dark:text-slate-300">
          {row.error === NEEDS_CHOICE ? t('bundles.needsChoice') : errorMessage(t, row.error)}
        </span>
      ) : null}
    </li>
  );
}

function Report({ run }: { run: BundleRun }) {
  const { t } = useTranslation('onboarding');
  const count = (status: ImportRow['status']) => run.rows.filter((row) => row.status === status);
  const notTried = count('skipped').length;
  return (
    <div className="flex flex-col gap-2">
      <ul
        role="list"
        aria-label={t('bundles.results')}
        className="divide-y divide-slate-200 dark:divide-slate-700"
      >
        {run.rows.map((row) => (
          <Row key={row.url} row={row} />
        ))}
      </ul>
      <p role="status" className="text-sm font-medium">
        {run.running
          ? null
          : t('bundles.summary', {
              added: count('added').length,
              existing: count('existing').length,
              failed: count('failed').length,
            }) + (notTried > 0 ? ` ${t('bundles.notTried')}` : '')}
      </p>
      {run.quota === null ? null : <InlineAlert>{quotaMessage(t, run.quota)}</InlineAlert>}
    </div>
  );
}

interface BundleItemProps {
  bundle: StarterBundle;
  run: BundleRun | undefined;
  disabled: boolean;
  onAdd: () => void;
}

function BundleItem({ bundle, run, disabled, onAdd }: BundleItemProps) {
  const { t, i18n } = useTranslation('onboarding');
  const nameId = useId();
  const name = i18n.language.toLowerCase().startsWith('sk') ? bundle.names.sk : bundle.names.en;
  const count = bundle.urls.length;
  return (
    <li
      aria-labelledby={nameId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-700"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={nameId} className="text-base font-semibold">
          {name}
        </h3>
        <Button
          variant="secondary"
          size="sm"
          loading={run?.running === true}
          disabled={disabled}
          aria-label={t('bundles.addNamed', { count, name })}
          onClick={onAdd}
        >
          {t('bundles.add', { count })}
        </Button>
      </div>
      {run === undefined ? null : <Report run={run} />}
    </li>
  );
}

/** Groups of feeds to start with. Adding one never turns classification on for its feeds. */
export function StarterBundles() {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const { runs, running, add } = useBundleImport();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('bundles.title')}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('bundles.lead')}</p>
      <ul role="list" aria-labelledby={headingId} className="flex flex-col gap-3">
        {BUNDLES.map((bundle) => (
          <BundleItem
            key={bundle.id}
            bundle={bundle}
            run={runs[bundle.id]}
            disabled={running}
            onAdd={() => {
              void add(bundle.id, bundle.urls);
            }}
          />
        ))}
      </ul>
    </section>
  );
}
