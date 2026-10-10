import type { Explain } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { useFeatureLabel } from './model-labels.js';
import { Section } from './section.js';

/** The factors that moved the personal model's score most, strongest first, each worded from its feature key. */
export function PersonalModel({ model }: { model: NonNullable<Explain['model']> }) {
  const { t } = useTranslation('why');
  const featureLabel = useFeatureLabel();
  const strongest = [...model.top].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );
  if (strongest.length === 0) return null;

  return (
    <Section title={t('model.heading')}>
      <ul role="list" className="flex flex-col gap-1 text-sm">
        {strongest.map((factor) => (
          <li key={factor.feature}>
            {t('model.factor', {
              phrase: featureLabel(factor.feature, factor.label),
              direction: t(factor.contribution < 0 ? 'model.lowered' : 'model.raised'),
              interpolation: { escapeValue: false },
            })}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('model.note')}</p>
    </Section>
  );
}
