import type { Explain } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Section } from './section.js';

/** The factors that moved the personal model's score most, strongest first. */
export function PersonalModel({ model }: { model: NonNullable<Explain['model']> }) {
  const { t } = useTranslation('why');
  const strongest = [...model.top].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );
  if (strongest.length === 0) return null;

  return (
    <Section title={t('model.heading')}>
      <ul role="list" className="flex flex-col gap-1 text-sm">
        {strongest.map((factor) => (
          <li key={factor.feature}>{factor.label}</li>
        ))}
      </ul>
    </Section>
  );
}
