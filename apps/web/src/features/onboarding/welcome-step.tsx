import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import type { StepProps } from './steps.js';

const LINES = ['interests', 'lanes', 'why'] as const;

export function WelcomeStep({ go }: StepProps) {
  const { t } = useTranslation('onboarding');
  return (
    <>
      <ol aria-label={t('welcome.how')} className="flex list-decimal flex-col gap-3 ps-6 text-base">
        {LINES.map((line) => (
          <li key={line}>{t(`welcome.lines.${line}`)}</li>
        ))}
      </ol>
      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={() => {
            go('feeds');
          }}
        >
          {t('welcome.start')}
        </Button>
      </div>
    </>
  );
}
