import type { ArticleListItem } from '@bantoozi/shared';
import { Link } from '@tanstack/react-router';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { topReasonText } from '../article/top-reason.js';
import { useReaderActions, useReaderItem } from './actions/provider.js';

const LINK = cx(
  'inline-flex min-h-11 items-center rounded font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200',
  FOCUS_RING,
);

/** A Never card hides an article under the code `never:<cardId>`; every other code is a rule. */
function isNeverCard(code: string): boolean {
  return code === 'never' || code.startsWith('never:');
}

export interface HiddenCausesProps {
  /** An article of the Hidden view, as the list has it. */
  item: ArticleListItem;
}

/**
 * Under a row of the Hidden view (spec 09 §3.1): what hides the article. The reader's own archive
 * can be undone here; a rule or a Never card is changed where it was made.
 */
export function HiddenCauses({ item }: HiddenCausesProps) {
  const { t, i18n } = useTranslation('reader');
  const { t: tArticle } = useTranslation('article');
  const store = useReaderActions();
  const shown = useReaderItem(item);
  const causes = useRef<HTMLUListElement>(null);
  const byYou = shown.archivedAt !== null;
  const byRule = item.lane === 'hidden';
  const rule = item.topReason?.kind === 'rule' ? item.topReason : null;

  // The button goes with the archive, and the focus with it: the row's title takes it over.
  function unhide() {
    store.dispatch(shown, { type: 'unhide' });
    causes.current?.closest('li')?.querySelector<HTMLElement>('h3 button')?.focus();
  }

  return (
    <ul
      ref={causes}
      role="list"
      aria-label={t('hidden.causes', { title: item.title })}
      className="mt-1 flex flex-col px-4 text-sm"
    >
      {byYou ? (
        <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
          <span>{t('hidden.byYou')}</span>
          <Button variant="secondary" size="sm" onClick={unhide}>
            {t('hidden.unhide')}
          </Button>
        </li>
      ) : null}
      {byRule ? (
        <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
          <span>
            {rule === null
              ? t('hidden.byRuleBare')
              : isNeverCard(rule.code)
                ? // The reason of a Never card already says that it hides the article.
                  topReasonText(tArticle, i18n.language, rule)
                : t('hidden.byRule', { reason: topReasonText(tArticle, i18n.language, rule) })}
          </span>
          {rule !== null && isNeverCard(rule.code) ? (
            <Link to="/interests" className={LINK}>
              {t('hidden.toInterests')}
            </Link>
          ) : (
            <Link to="/rules" className={LINK}>
              {t('hidden.toRules')}
            </Link>
          )}
        </li>
      ) : null}
      {byYou || byRule ? null : (
        <li className="py-2 text-slate-600 dark:text-slate-300">{t('hidden.none')}</li>
      )}
    </ul>
  );
}
