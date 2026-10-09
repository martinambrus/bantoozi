import type { OpmlImportReport } from '@bantoozi/shared';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage, quotaDetails } from '../../components/error-message.js';
import { saveFile } from '../../components/save-file.js';
import { TextField } from '../../components/text-field.js';
import { useSession } from '../../session/context.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';

/** The name the API gives the file (spec 08 §4). */
const EXPORT_FILENAME = 'bantoozi-subscriptions.opml';

/** The message key for the two reasons the API gives for a file it cannot import, else null. */
function opmlProblemKey(code: unknown): string | null {
  if (code === 'OPML_INVALID') return 'opml.errors.invalid';
  if (code === 'OPML_TOO_LARGE') return 'opml.errors.tooLarge';
  return null;
}

export interface OpmlSectionProps {
  /** Whether the export link is offered; the first-run wizard has nothing to export yet. */
  exportable?: boolean;
}

export function OpmlSection({ exportable = true }: OpmlSectionProps) {
  const { t } = useTranslation('feeds');
  const cache = useSubscriptionsCache();
  const session = useSession();
  const headingId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<OpmlImportReport | null>(null);
  // The list learns of the imported feeds even when the answer comes after the page was left.
  const upload = useApiMutation(routes.subscriptionsImportOpml, {
    onSuccess: () => {
      void cache.refresh();
    },
  });
  // Through the API client, not a link: an error is shown instead of saved as the file, and a 401
  // ends the session as on every other call.
  const download = useApiMutation(routes.subscriptionsExportOpml);

  function choose(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  function exportOpml() {
    if (download.isPending) return;
    const signIn = session.currentSignIn();
    // Saved even when the page was left meanwhile, as a download the browser had begun would be,
    // but not once the sign-in that asked has ended; a failure shows below the button.
    download.mutateAsync().then(
      (opml) => {
        if (session.currentSignIn() !== signIn) return;
        saveFile(new Blob([opml], { type: 'text/x-opml' }), EXPORT_FILENAME);
      },
      () => {},
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null || upload.isPending) return;
    setReport(null);
    upload.mutate(
      { body: { file } },
      {
        onSuccess: (imported) => {
          setReport(imported);
          // Only the file that was sent is done with; one chosen meanwhile stays for the next one.
          if (input.current?.files?.[0] === file) {
            setFile(null);
            input.current.value = '';
          }
        },
      },
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('opml.title')}
      </h2>
      <form onSubmit={submit} className="flex flex-col items-start gap-3">
        <TextField
          ref={input}
          type="file"
          accept=".opml,.xml,text/x-opml,text/xml,application/xml"
          label={t('opml.file')}
          hint={t('opml.fileHint')}
          onChange={choose}
          className="w-full"
        />
        <Button
          type="submit"
          variant="secondary"
          loading={upload.isPending}
          disabled={file === null}
        >
          {t('opml.import')}
        </Button>
      </form>
      {upload.error === null ? null : <ImportFailure error={upload.error} />}
      {report === null ? null : <ImportReport report={report} />}
      {exportable ? (
        <div className="flex flex-col items-start gap-3">
          <Button variant="secondary" loading={download.isPending} onClick={exportOpml}>
            {t('opml.export')}
          </Button>
          {download.error === null ? null : (
            <InlineAlert>{errorMessage(t, download.error)}</InlineAlert>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ImportFailure({ error }: { error: unknown }) {
  const { t } = useTranslation('feeds');
  const quota = quotaDetails(error);
  const problem = opmlProblemKey(isApiError(error) ? error.details?.['code'] : undefined);
  if (quota?.limit === 'opmlMaxFeeds') {
    return (
      <InlineAlert>
        {t('opml.errors.tooManyFeeds', { used: quota.used, max: quota.max })}
      </InlineAlert>
    );
  }
  return <InlineAlert>{problem === null ? errorMessage(t, error) : t(problem)}</InlineAlert>;
}

function ImportReport({ report }: { report: OpmlImportReport }) {
  const { t } = useTranslation('feeds');
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-xl border border-slate-300 p-4 dark:border-slate-700"
    >
      <h3 id={headingId} className="text-base font-semibold">
        {t('opml.report.title')}
      </h3>
      <p className="text-sm">
        {report.added === 0
          ? t('opml.report.noneAdded')
          : t('opml.report.added', { count: report.added })}
      </p>
      {report.existing === 0 ? null : (
        <p className="text-sm">{t('opml.report.existing', { count: report.existing })}</p>
      )}
      {report.invalid.length === 0 ? null : (
        <>
          <p className="text-sm font-medium">
            {t('opml.report.invalid', { count: report.invalid.length })}
          </p>
          <ul role="list" className="flex flex-col gap-2">
            {report.invalid.map((entry) => (
              <li key={entry.index} className="flex flex-col text-sm">
                <span className="font-medium">
                  {t('opml.report.entry', { number: entry.index + 1 })}
                </span>
                <span className="break-all text-slate-600 dark:text-slate-300">
                  {entry.url === '' ? t('opml.report.noAddress') : entry.url}
                </span>
                <span>{t(`opml.reasons.${entry.reason}`)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
