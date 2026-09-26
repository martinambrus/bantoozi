import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/** `articles.pipeline_state` values (spec 02 §3). */
export type PipelineState =
  | 'ingested'
  | 'stale'
  | 'extracted'
  | 'translated'
  | 'enriched'
  | 'matched'
  | 'degraded'
  | 'failed';

/** States from which enrichment may (re)start: extraction has run and nothing is stale. */
export const ENRICHABLE_STATES: readonly PipelineState[] = [
  'extracted',
  'translated',
  'degraded',
  'failed',
  'enriched',
  'matched',
];

/** States before a successful enrichment: the ones a translation or an unavailable engine may set. */
export const PRE_ENRICH_STATES: readonly PipelineState[] = ['extracted', 'translated', 'degraded'];

/**
 * Move the article to `to` only from one of `from`, at exactly `revision` (spec 03 §2.1: a late or
 * duplicate stage never regresses the state or touches a newer revision). Optionally records the
 * enrich engine. Returns whether the row changed.
 */
export async function transitionPipelineState(
  db: Executor,
  input: {
    articleId: string;
    revision: string;
    to: PipelineState;
    from: readonly PipelineState[];
    enrichEngine?: string | null;
  },
): Promise<boolean> {
  const engine =
    input.enrichEngine === undefined ? sql`enrich_engine` : sql`${input.enrichEngine}::text`;
  const result = await db.execute(sql`
    UPDATE articles SET pipeline_state = ${input.to}, enrich_engine = ${engine}, updated_at = now()
     WHERE id = ${input.articleId}::bigint AND content_revision = ${input.revision}::bigint
       AND pipeline_state = ANY(${sql.param([...input.from])}::text[])`);
  return (result.rowCount ?? 0) > 0;
}
