import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import { formatBytes } from './format.js';
import { Alert, Hint, SettingsSection } from './section.js';
import { useDataExport, type ExportProblem, type ExportState } from './use-data-export.js';

function problemText(t: TFunction, problem: ExportProblem): string {
  switch (problem.kind) {
    case 'http':
      return t('export.http', { status: problem.status });
    case 'rate_limited':
      return problem.minutes === null
        ? t('export.rateLimitedLater')
        : t('export.rateLimited', { count: problem.minutes });
    case 'network':
      return t('export.network');
    case 'incomplete':
      return t('export.incomplete');
  }
}

function statusText(t: TFunction, language: string, state: ExportState): string {
  switch (state.phase) {
    case 'done':
      return t('export.done', {
        filename: state.filename,
        size: formatBytes(state.bytes, language),
      });
    case 'cancelled':
      return t('export.cancelled');
    default:
      return '';
  }
}

export function ExportSection() {
  const { t, i18n } = useTranslation('settings');
  const { state, start, cancel } = useDataExport();
  const download = useRef<HTMLButtonElement>(null);
  const downloading = state.phase === 'downloading';
  const shown = statusText(t, i18n.language, state);

  // The cancel button leaves with the download; the focus goes back to the button that began it.
  useEffect(() => {
    if (state.phase === 'cancelled') download.current?.focus();
  }, [state.phase]);

  return (
    <SettingsSection title={t('export.title')} description={t('export.description')}>
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={download} disabled={downloading} onClick={() => void start()}>
          {t('export.download')}
        </Button>
        {downloading ? (
          <Button variant="secondary" onClick={cancel}>
            {t('export.cancel')}
          </Button>
        ) : null}
      </div>
      <p
        role="status"
        className={
          shown === '' ? 'sr-only' : 'text-sm font-medium text-slate-900 dark:text-slate-100'
        }
      >
        {downloading ? <VisuallyHidden>{t('export.downloading')}</VisuallyHidden> : shown}
      </p>
      {state.phase === 'downloading' ? (
        <Hint>{t('export.progress', { size: formatBytes(state.bytes, i18n.language) })}</Hint>
      ) : null}
      {state.phase === 'failed' ? <Alert>{problemText(t, state.problem)}</Alert> : null}
    </SettingsSection>
  );
}
