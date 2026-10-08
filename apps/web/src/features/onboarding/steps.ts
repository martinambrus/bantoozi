export const STEPS = ['welcome', 'feeds', 'interests', 'calibrate'] as const;

export type Step = (typeof STEPS)[number];

export function stepNumber(step: Step): number {
  return STEPS.indexOf(step) + 1;
}

export function stepBefore(step: Step): Step | undefined {
  return STEPS[STEPS.indexOf(step) - 1];
}

/** Goes to another step; `replace` swaps the current address instead of adding one. */
export type GoToStep = (step: Step, options?: { replace?: boolean }) => void;

export interface StepProps {
  go: GoToStep;
}
