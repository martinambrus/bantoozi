import { AnalysisLearnInputSchema } from '@bantoozi/shared';
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

/**
 * Derived results of completed requests by request id, process-wide and bounded (least recently
 * used first out). A completed request's snapshots and `input_sha` never change, so only the rows
 * themselves are re-read: one that was deleted is no longer returned (D-259). `null`: the row
 * yields no result.
 */
const ANALYSIS_CACHE_MAX = 8_000;
const analysisCache = new Map<string, LearnAnalysisResult | null>();

function cacheAnalysis(id: string, result: LearnAnalysisResult | null): void {
  analysisCache.delete(id);
  analysisCache.set(id, result);
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next();
    if (oldest.done !== true) analysisCache.delete(oldest.value);
  }
}

async function loadAnalysis(
  db: Executor,
  userId: string,
  ids: string[],
): Promise<Map<string, LearnAnalysisResult>> {
  const out = new Map<string, LearnAnalysisResult>();
  if (ids.length === 0) return out;
  const present = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM analysis_requests
     WHERE user_id = ${userId}::uuid AND status = 'complete' AND result_snapshot IS NOT NULL
       AND id = ANY(${sql.param(ids)}::uuid[])`);
  const missing = present.rows.map((row) => row.id).filter((id) => !analysisCache.has(id));
  if (missing.length > 0) await deriveAnalysis(db, userId, missing);
  for (const { id } of present.rows) {
    const result = analysisCache.get(id);
    if (result === undefined) continue;
    cacheAnalysis(id, result);
    if (result !== null) out.set(id, result);
  }
  return out;
}

/** Reads and derives the given completed requests into the cache. */
async function deriveAnalysis(db: Executor, userId: string, ids: string[]): Promise<void> {
  // Only the fields read below leave the database: a snapshot freezes every card's question text
  // (tens of kilobytes per request), which a sample load never needs (D-259).
  const rows = await db.execute<{
    id: string;
    input_sha: string;
    result_snapshot: unknown;
    input_snapshot: unknown;
    feed_id: string;
  }>(sql`
    SELECT r.id::text AS id, r.input_sha, r.feed_id::text AS feed_id,
           CASE WHEN jsonb_typeof(rs) = 'object' THEN jsonb_build_object(
             'inputSha', rs -> 'inputSha',
             'model', rs -> 'model',
             'enrich', jsonb_build_object('features', rs -> 'enrich' -> 'features'),
             'match', CASE WHEN jsonb_typeof(rs -> 'match' -> 'cards') = 'array'
               THEN jsonb_build_object('cards', (
                 SELECT coalesce(jsonb_agg(jsonb_build_object('cardId', c -> 'cardId', 'p', c -> 'p')
                                           ORDER BY o), '[]'::jsonb)
                   FROM jsonb_array_elements(rs -> 'match' -> 'cards')
                        WITH ORDINALITY AS m(c, o)
                  WHERE jsonb_typeof(c) = 'object')) END)
           END AS result_snapshot,
           CASE WHEN jsonb_typeof(ins) = 'object' THEN jsonb_build_object(
             'v', ins -> 'v',
             'article', CASE WHEN jsonb_typeof(ins -> 'article') = 'object' THEN
               jsonb_build_object(
                 'wordCount', ins -> 'article' -> 'wordCount',
                 'lang', ins -> 'article' -> 'lang',
                 'author', ins -> 'article' -> 'author',
                 'firstSeenAt', ins -> 'article' -> 'firstSeenAt',
                 'publishedAt', ins -> 'article' -> 'publishedAt',
                 'hasImage', ins -> 'article' -> 'hasImage',
                 'hasVideo', ins -> 'article' -> 'hasVideo',
                 'bodyImageCount', ins -> 'article' -> 'bodyImageCount',
                 'storyClusterId', ins -> 'article' -> 'storyClusterId',
                 'clusterSize', ins -> 'article' -> 'clusterSize') END,
             'cards', CASE WHEN jsonb_typeof(ins -> 'cards') = 'array' THEN (
               SELECT coalesce(jsonb_agg(jsonb_build_object('cardId', c -> 'cardId',
                                                            'kind', c -> 'kind',
                                                            'strength', c -> 'strength')
                                         ORDER BY o), '[]'::jsonb)
                 FROM jsonb_array_elements(ins -> 'cards') WITH ORDINALITY AS k(c, o)
                WHERE jsonb_typeof(c) = 'object') END)
           END AS input_snapshot
      FROM analysis_requests r
      -- Each snapshot is detoasted once here; every '->' on the stored column would decompress it
      -- again (the concatenation copies the value, OFFSET 0 keeps the subquery from being inlined).
      CROSS JOIN LATERAL (SELECT r.result_snapshot || '{}'::jsonb AS rs,
                                 r.input_snapshot || '{}'::jsonb AS ins OFFSET 0) d
     WHERE r.user_id = ${userId}::uuid AND r.status = 'complete' AND r.result_snapshot IS NOT NULL
       AND r.id = ANY(${sql.param(ids)}::uuid[])`);
  for (const row of rows.rows) {
    const result = row.result_snapshot;
    const model = isRecord(result) ? result.model : undefined;
    if (
      !isRecord(result) ||
      result.inputSha !== row.input_sha ||
      !isRecord(model) ||
      model.engine !== 'typesafe'
    ) {
      cacheAnalysis(row.id, null);
      continue;
    }
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
    const input = AnalysisLearnInputSchema.safeParse(row.input_snapshot);
    const frozen = input.success
      ? {
          feedId: row.feed_id,
          cards: input.data.cards.flatMap((c) =>
            c.kind === 'interest' && c.strength !== null
              ? [{ id: c.cardId, strength: c.strength }]
              : [],
          ),
          article: {
            wordCount: input.data.article.wordCount,
            lang: input.data.article.lang,
            author: input.data.article.author,
            firstSeenAt: new Date(input.data.article.firstSeenAt),
            publishedAt:
              input.data.article.publishedAt === null
                ? null
                : new Date(input.data.article.publishedAt),
            hasImage: input.data.article.hasImage,
            hasVideo: input.data.article.hasVideo,
            bodyImageCount: input.data.article.bodyImageCount,
            storyClusterId: input.data.article.storyClusterId,
            clusterSize: input.data.article.clusterSize,
          },
        }
      : undefined;
    cacheAnalysis(row.id, {
      inputSha: row.input_sha,
      ...(typeof model.model === 'string' ? { model: model.model } : {}),
      facets: features as Record<string, number> | null,
      cardP,
      ...(frozen === undefined ? {} : { frozen }),
    });
  }
}
