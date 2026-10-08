import type { Control } from '../support/control.js';

/**
 * Typed calls of the PWA check's SQL hooks (packages/testing/src/e2e/hooks-pwa.ts).
 */

export interface FeedbackEventRow {
  kind: string;
  articleId: string;
  /** The event stores behavioural `features`, which only the implicit-feedback opt-in allows. */
  hasFeatures: boolean;
}

/** The feedback events one account has written, oldest first. */
export function feedbackEventsOf(control: Control, email: string): Promise<FeedbackEventRow[]> {
  return control.sql<FeedbackEventRow[]>('feedbackEventFeatures', { email });
}
