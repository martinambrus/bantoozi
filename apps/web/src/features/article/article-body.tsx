import type { BookmarkSnapshot } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { FOCUS_RING, cx } from '../../components/cx.js';
import { SafeHtml } from '../../components/safe-html.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import { httpUrl } from './http-url.js';

/** Plain text as paragraphs; React escapes it, so nothing in it is ever markup. */
export function Paragraphs({ text, lang }: { text: string; lang?: string | undefined }) {
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <div lang={lang} className="flex flex-col gap-3 break-words text-base leading-relaxed">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

/**
 * The saved copy of a bookmark (spec 09 §3.2): when it was saved, the original source when it is
 * known, and the text as saved. It is never swapped for the live article.
 */
export function SavedCopy({ snapshot }: { snapshot: BookmarkSnapshot }) {
  const { t, i18n } = useTranslation('article');
  const { timezone } = useMe();
  const source = httpUrl(snapshot.sourceUrl);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">{t('saved.heading')}</h3>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
        <span>
          {t('saved.capturedOn', {
            date: formatDate(snapshot.capturedAt, i18n.language, timezone),
          })}
        </span>
        {source === null ? null : (
          <a
            href={source.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
              'inline-flex min-h-11 items-center rounded-md text-indigo-700 underline dark:text-indigo-300',
              FOCUS_RING,
            )}
          >
            {t('saved.source')}
          </a>
        )}
      </p>
      {snapshot.html === null ? (
        <Paragraphs text={snapshot.text} />
      ) : (
        <SafeHtml html={snapshot.html} imagesAllowed={snapshot.effectiveImagesAllowed} />
      )}
    </section>
  );
}
