import { useNavigate } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Batch } from './batch.js';
import { CalibrateStep } from './calibrate-step.js';
import { FeedsStep } from './feeds-step.js';
import { GatedStep } from './gated-step.js';
import { InterestsStep } from './interests-step.js';
import { STEPS, stepNumber, type GoToStep, type Step } from './steps.js';
import { WelcomeStep } from './welcome-step.js';

export interface OnboardingPageProps {
  /** The step the address names; none, or one that does not exist, is the welcome step. */
  step?: Step | undefined;
}

interface StepContentProps {
  step: Step;
  go: GoToStep;
  batch: Batch | null;
  onBatch: (update: (current: Batch | null) => Batch) => void;
}

function StepContent({ step, go, batch, onBatch }: StepContentProps) {
  switch (step) {
    case 'welcome':
      return <WelcomeStep go={go} />;
    case 'feeds':
      return <FeedsStep go={go} />;
    case 'interests':
      return <GatedStep go={go}>{() => <InterestsStep go={go} />}</GatedStep>;
    case 'calibrate':
      return (
        <GatedStep go={go}>
          {(subscriptions) => (
            <CalibrateStep go={go} subscriptions={subscriptions} batch={batch} onBatch={onBatch} />
          )}
        </GatedStep>
      );
  }
}

/**
 * The first-run wizard (spec 09 §4). The frame and the welcome step use no data, so they render
 * before the account is known; the steps that follow load what they need themselves.
 */
export function OnboardingPage({ step = 'welcome' }: OnboardingPageProps) {
  const { t } = useTranslation('onboarding');
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  // The articles sent to be analyzed outlive the calibration step, so Back and forward keep them.
  const [batch, setBatch] = useState<Batch | null>(null);

  // A change of step moves the focus to its heading, so a screen reader starts reading there.
  useLayoutEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);

  const go = useCallback<GoToStep>(
    (next, options) => {
      void navigate({
        to: '/onboarding',
        search: { step: next },
        replace: options?.replace === true,
      });
    },
    [navigate],
  );

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8 outline-none"
    >
      <p className="text-lg font-bold">{t('common:appName')}</p>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          {t('step', { step: stepNumber(step), total: STEPS.length })}
        </p>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
          {t(`${step}.title`)}
        </h1>
      </div>
      <StepContent step={step} go={go} batch={batch} onBatch={setBatch} />
    </main>
  );
}
