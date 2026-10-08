import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { stepBefore, type GoToStep, type Step } from './steps.js';

export interface StepFooterProps {
  step: Step;
  go: GoToStep;
  /** The actions that lead on, to the right of Back. */
  children?: ReactNode;
}

export function StepFooter({ step, go, children }: StepFooterProps) {
  const { t } = useTranslation('onboarding');
  const previous = stepBefore(step);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {previous === undefined ? (
        <span />
      ) : (
        <Button
          variant="ghost"
          onClick={() => {
            go(previous);
          }}
        >
          {t('back')}
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">{children}</div>
    </div>
  );
}
