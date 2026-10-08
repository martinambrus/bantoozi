import type { Explain } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { useMe } from '../../session/context.js';
import { useTopicIndex } from '../interests/topics.js';
import { Meter, percentOf } from './meter.js';
import { Section } from './section.js';
import { useDemotions, type NeverShowFlag } from './use-demotions.js';

type Facets = NonNullable<Explain['facets']>;

const DEPTH_LEVELS = 5;

/** The five dots: depth is a score from 0 to 1, and the dots count the levels from 1 to 5. */
function depthLevel(depth: number): number {
  return Math.round(depth * (DEPTH_LEVELS - 1)) + 1;
}

/** The qualities that have a meter, and the demotion each one's "Never show me" switches on. */
const QUALITIES: ReadonlyArray<{
  facet: 'clickbait' | 'promotional' | 'timeSensitive';
  flag: NeverShowFlag;
}> = [
  { facet: 'clickbait', flag: 'clickbait' },
  { facet: 'promotional', flag: 'promotional' },
  { facet: 'timeSensitive', flag: 'stale' },
];

function useTopicPath(topic: Facets['topic']): string | null {
  const { index } = useTopicIndex();
  const broad = index?.name(topic.l1);
  if (index === null || broad === undefined) return null;
  const narrow = topic.l2 === undefined ? undefined : index.name(topic.l2);
  return narrow === undefined ? broad : `${broad} › ${narrow}`;
}

function Depth({ depth }: { depth: number }) {
  const { t } = useTranslation('why');
  const level = depthLevel(depth);
  return (
    <p className="flex items-center gap-2 text-sm">
      <span aria-hidden="true">{t('about.depth')}</span>
      <span role="img" aria-label={t('about.depthLevel', { level })} className="flex gap-1">
        {Array.from({ length: DEPTH_LEVELS }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={cx(
              'size-2.5 rounded-full',
              index < level ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-300 dark:bg-slate-600',
            )}
          />
        ))}
      </span>
    </p>
  );
}

/** What the analysis found out about the article itself, and what to do about unwanted kinds. */
export function AboutArticle({ facets }: { facets: Facets }) {
  const { t } = useTranslation('why');
  const me = useMe();
  const demotions = useDemotions();
  const topic = useTopicPath(facets.topic);
  const type = t(`about.contentTypes.${facets.contentType.choice}`, {
    defaultValue: t('about.contentTypes.other'),
  });

  return (
    <Section title={t('about.heading')}>
      <p className="text-sm">{t('about.type', { type })}</p>
      {topic === null ? null : <p className="text-sm">{t('about.topic', { topic })}</p>}
      <Depth depth={facets.depth} />
      <ul role="list" className="flex flex-col gap-3">
        {QUALITIES.map(({ facet, flag }) => {
          const label = t(`about.${facet}`);
          const valueText = t('percent', { percent: percentOf(facets[facet]) });
          return (
            <li key={facet} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span aria-hidden="true">{label}</span>
                <span aria-hidden="true" className="tabular-nums">
                  {valueText}
                </span>
              </div>
              <Meter label={label} value={facets[facet]} valueText={valueText} />
              {me.preferences.demote[flag] === 'on' ? null : (
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={demotions.pending}
                    onClick={() => demotions.neverShow(flag)}
                  >
                    {t(`about.never.${flag}`)}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
