import type { Control } from '../support/control.js';

/**
 * Typed calls of the SQL hooks the reader flows added (packages/testing/src/e2e/hooks-reader.ts):
 * what the fake TypeSafe server was asked for, and what a rating was stored with.
 */

export interface EngineCallRow {
  id: string;
  /** The article the call was about; null for a call that is about none. */
  articleId: string | null;
  kind: string;
  engine: string;
  status: string;
}

/** The provider calls made on one account's behalf, oldest first. */
export function engineCalls(control: Control, email: string): Promise<EngineCallRow[]> {
  return control.sql<EngineCallRow[]>('engineCalls', { email });
}

export interface FeedbackEventRow {
  id: string;
  kind: string;
  rating: number | null;
  reason: string | null;
  /** The analysis request the article was rated under; null for a rating without one. */
  analysisRequestId: string | null;
}

/** The feedback events one account stored for one article, oldest first. */
export function feedbackEvents(
  control: Control,
  email: string,
  articleId: string,
): Promise<FeedbackEventRow[]> {
  return control.sql<FeedbackEventRow[]>('articleFeedback', { email, articleId });
}
