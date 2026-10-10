import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

import { reduceArticle } from './reduce.js';
import type { LearnAnalysisResult, LearnEvent, LearnReaderState, LearnSamples } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Loads one effective training sample per (user, article) from `user_article` and the feedback log,
 * with the stored event-time snapshot (spec 06 §8.2, PLAN M7-T2). Only events up to `cutoffEventId`
 * are considered. Eligibility (180 days, sha checks, coverage) is the trainer's job.
 */
export async function loadLearnSamples(
  db: Executor,
  input: { userId: string; now: Date },
): Promise<LearnSamples> {
  const user = input.userId;
  const cutoffRows = await db.execute<{ id: string | null }>(
    sql`SELECT max(id)::text AS id FROM feedback_events WHERE user_id = ${user}::uuid`,
  );
  const cutoffEventId = cutoffRows.rows[0]?.id ?? null;
  if (cutoffEventId === null) return { samples: [], cutoffEventId: null };

  const prefRows = await db.execute<{ preferences: unknown }>(
    sql`SELECT preferences FROM users WHERE id = ${user}::uuid`,
  );
  const stored = prefRows.rows[0]?.preferences;
  const flag = (name: string): boolean => isRecord(stored) && stored[name] === true;
  const prefs = {
    implicitFeedback: flag('implicitFeedback'),
    implicitNegative: flag('implicitNegative'),
  };

  const eventRows = await db.execute<{
    id: string;
    article_id: string;
    kind: string;
    value: unknown;
    created_at: RawTimestamp;
  }>(sql`
    SELECT id::text AS id, article_id::text AS article_id, kind, value, created_at
      FROM feedback_events
     WHERE user_id = ${user}::uuid AND id <= ${cutoffEventId}::bigint
       AND kind IN ('rate', 'unrate', 'prompt_answer', 'bookmark', 'open', 'dwell', 'read')
     ORDER BY id`);
  const byArticle = new Map<string, LearnEvent[]>();
  for (const row of eventRows.rows) {
    const list = byArticle.get(row.article_id) ?? [];
    list.push({
      id: row.id,
      articleId: row.article_id,
      kind: row.kind,
      value: isRecord(row.value) ? row.value : {},
      createdAt: toDate(row.created_at),
    });
    byArticle.set(row.article_id, list);
  }

  const stateRows = await db.execute<{
    article_id: string;
    rating: number | null;
    rated_at: RawTimestamp | null;
    bookmarked_at: RawTimestamp | null;
    read_at: RawTimestamp | null;
  }>(sql`
    SELECT article_id::text AS article_id, rating, rated_at, bookmarked_at, read_at
      FROM user_article
     WHERE user_id = ${user}::uuid
       AND article_id IN (SELECT article_id FROM feedback_events
                           WHERE user_id = ${user}::uuid AND id <= ${cutoffEventId}::bigint)`);
  const states = new Map<string, LearnReaderState>();
  for (const row of stateRows.rows) {
    states.set(row.article_id, {
      rating: row.rating,
      ratedAt: toDateOrNull(row.rated_at),
      bookmarkedAt: toDateOrNull(row.bookmarked_at),
      readAt: toDateOrNull(row.read_at),
    });
  }

  const requestIds = new Set<string>();
  for (const events of byArticle.values()) {
    for (const e of events) {
      const id = e.value.analysisRequestId;
      if (
        (e.kind === 'rate' || e.kind === 'prompt_answer') &&
        typeof id === 'string' &&
        UUID.test(id)
      ) {
        requestIds.add(id);
      }
    }
  }
  const analysis = await loadAnalysis(db, user, [...requestIds]);

  const samples = [];
  for (const [articleId, events] of byArticle) {
    const state = states.get(articleId) ?? {
      rating: null,
      ratedAt: null,
      bookmarkedAt: null,
      readAt: null,
    };
    const sample = reduceArticle({ articleId, state, events, prefs, analysis });
    if (sample !== null) samples.push(sample);
  }
  samples.sort((a, b) => (BigInt(a.eventId) < BigInt(b.eventId) ? -1 : 1));
  return { samples, cutoffEventId };
}

async function loadAnalysis(
  db: Executor,
  userId: string,
  ids: string[],
): Promise<Map<string, LearnAnalysisResult>> {
  const out = new Map<string, LearnAnalysisResult>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ id: string; input_sha: string; result_snapshot: unknown }>(sql`
    SELECT id::text AS id, input_sha, result_snapshot
      FROM analysis_requests
     WHERE user_id = ${userId}::uuid AND status = 'complete' AND result_snapshot IS NOT NULL
       AND id = ANY(${sql.param(ids)}::uuid[])`);
  for (const row of rows.rows) {
    const result = row.result_snapshot;
    if (!isRecord(result) || result.inputSha !== row.input_sha) continue;
    const model = result.model;
    if (!isRecord(model) || model.engine !== 'typesafe') continue;
    const enrich = result.enrich;
    const match = result.match;
    const features = isRecord(enrich) && isRecord(enrich.features) ? enrich.features : null;
    const cardP = new Map<string, number>();
    if (isRecord(match) && Array.isArray(match.cards)) {
      for (const c of match.cards) {
        if (isRecord(c) && c.cardId !== undefined && typeof c.p === 'number') {
          cardP.set(String(c.cardId), c.p);
        }
      }
    }
    out.set(row.id, {
      inputSha: row.input_sha,
      facets: features as Record<string, number> | null,
      cardP,
    });
  }
  return out;
}
