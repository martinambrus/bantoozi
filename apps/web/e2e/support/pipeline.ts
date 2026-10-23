/**
 * The pipeline goes on from `extracted` (translation, enrichment, matching) with an active
 * subscriber and after a rating, so "the page is extracted" means these states, not only the first.
 */
export const EXTRACTED_OR_LATER: ReadonlySet<string> = new Set([
  'extracted',
  'translated',
  'enriched',
  'matched',
  'degraded',
]);

export function isExtracted(state: { pipelineState: string }): boolean {
  return EXTRACTED_OR_LATER.has(state.pipelineState);
}

export function countExtracted(states: readonly { pipelineState: string }[]): number {
  return states.filter(isExtracted).length;
}
