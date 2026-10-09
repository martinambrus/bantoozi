import type { Explain } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { percentOf } from './meter.js';

const SEPARATOR = ' · ';

/** Where the article landed, how sure the ranking is, how it got there and what shaped the text. */
export function Verdict({ explain }: { explain: Explain }) {
  const { t } = useTranslation('why');
  const line = [
    t(`verdict.lane.${explain.lane}`),
    explain.p === null ? null : t('percent', { percent: percentOf(explain.p) }),
    explain.tier === null ? null : t('verdict.tier', { tier: explain.tier }),
  ]
    .filter((part) => part !== null)
    .join(SEPARATOR);
  const notRequested = explain.rules.some((rule) => rule.code === 'inference_not_requested');
  const muted = 'text-sm text-slate-600 dark:text-slate-300';

  return (
    <div className="flex flex-col gap-1">
      <p className="text-lg font-semibold">{line}</p>
      <p className={muted}>
        {t(
          explain.source === 'none' && notRequested
            ? 'source.notRequested'
            : `source.${explain.source}`,
        )}
      </p>
      {explain.translation === undefined ? null : (
        <p className={muted}>
          {t(explain.translation.quality === 'weak' ? 'translation.weak' : 'translation.ok')}
        </p>
      )}
      {explain.cluster === undefined ? null : (
        <p className={muted}>{t('cluster', { count: explain.cluster.size })}</p>
      )}
    </div>
  );
}

/** An article that has no stored explanation yet. */
export function NotAnalyzed() {
  const { t } = useTranslation('why');
  return (
    <div className="flex flex-col gap-1">
      <p className="text-lg font-semibold">{t('verdict.notAnalyzed')}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('verdict.notAnalyzedHint')}</p>
    </div>
  );
}
