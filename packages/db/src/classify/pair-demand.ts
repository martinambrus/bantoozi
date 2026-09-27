import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS, type InferenceWitness } from '../ingest/demand.js';

/** One current holder authorizing an article/card pair (spec 05 §1.1 single admission predicate). */
export interface PairHolder {
  userId: string;
  feedId: string;
  /** `interest` held through `user_cards` (with its strength) or `label` through `user_labels`. */
  holding: 'card' | 'label';
  strength: 'must' | 'love' | 'like' | 'never' | null;
  witness: InferenceWitness;
}

/** The live demand of one card on one article. */
export interface CardPairDemand {
  cardId: string;
  kind: 'interest' | 'label';
  visibility: 'public' | 'shared' | 'private';
  /** The owner of a private card (its only permitted holder); null for shared/public text. */
  ownerUserId: string | null;
  holders: PairHolder[];
}

/**
 * The article/card pairs with live demand at the article's current revision (spec 05 §1.1,
 * §5.3, §5.5 step 2): a non-deleted current holder of a non-retired card whose scope includes a
 * carrier, where that holder either has an `active` subscription to the carrier whose
 * `feed_items.first_seen_at` is at/after activation (a non-stale article), or a selected
 * `analysis_requests` row for exactly this article and feed, frozen at the current revision, with the
 * subscription still training/active at the request's inference version, pending/running/complete
 * and inside the 180-day window. A private card counts only for its owner, so a cross-tenant card id
 * never gains demand. With `cardIds`, only those cards are considered. Cards without demand are
 * absent from the result.
 */
export async function cardPairDemand(
  db: Executor,
  articleId: string,
  cardIds?: readonly string[],
): Promise<CardPairDemand[]> {
  const cardFilter =
    cardIds === undefined ? sql`` : sql`AND x.card_id = ANY(${sql.param([...cardIds])}::bigint[])`;
  const result = await db.execute<{
    card_id: string;
    kind: 'interest' | 'label';
    visibility: 'public' | 'shared' | 'private';
    owner_user_id: string | null;
    user_id: string;
    feed_id: string;
    holding: 'card' | 'label';
    strength: PairHolder['strength'];
    witness_kind: 'automatic' | 'manual';
    inference_version: string | null;
    request_id: string | null;
  }>(sql`
    WITH holdings AS (
      SELECT user_id, card_id, scope_feed_id, 'card' AS holding, strength FROM user_cards
      UNION ALL
      SELECT user_id, card_id, NULL::bigint, 'label', NULL::text FROM user_labels
    )
    SELECT c.id::text AS card_id, c.kind, c.visibility, c.owner_user_id::text AS owner_user_id,
           d.user_id::text AS user_id, d.feed_id::text AS feed_id, d.holding, d.strength,
           d.witness_kind, d.inference_version, d.request_id
      FROM (
        SELECT x.card_id, s.user_id, s.feed_id, x.holding, x.strength,
               'automatic' AS witness_kind, s.inference_version::text AS inference_version,
               NULL::text AS request_id
          FROM feed_items fi
          JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
          JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                              AND fi.first_seen_at >= s.inference_activated_at
          JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
          JOIN holdings x ON x.user_id = s.user_id
                         AND (x.scope_feed_id IS NULL OR x.scope_feed_id = fi.feed_id)
         WHERE fi.article_id = ${articleId}::bigint ${cardFilter}
        UNION
        SELECT x.card_id, r.user_id, r.feed_id, x.holding, x.strength,
               'manual', NULL::text, r.id::text
          FROM analysis_requests r
          JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
          JOIN feed_items fi ON fi.article_id = r.article_id AND fi.feed_id = r.feed_id
          JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                              AND s.inference_mode IN ('training', 'active')
                              AND s.inference_version = r.inference_version
          JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
          JOIN holdings x ON x.user_id = r.user_id
                         AND (x.scope_feed_id IS NULL OR x.scope_feed_id = r.feed_id)
         WHERE r.article_id = ${articleId}::bigint
           AND r.status IN ('pending', 'running', 'complete')
           AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
           ${cardFilter}
      ) d
      JOIN interest_cards c ON c.id = d.card_id AND c.retired_at IS NULL
                           AND (c.visibility <> 'private' OR c.owner_user_id = d.user_id)
                           AND (c.kind = 'label') = (d.holding = 'label')
     ORDER BY c.id, d.user_id, d.feed_id, d.witness_kind, d.request_id`);

  const byCard = new Map<string, CardPairDemand>();
  for (const row of result.rows) {
    let demand = byCard.get(row.card_id);
    if (demand === undefined) {
      demand = {
        cardId: row.card_id,
        kind: row.kind,
        visibility: row.visibility,
        ownerUserId: row.owner_user_id,
        holders: [],
      };
      byCard.set(row.card_id, demand);
    }
    demand.holders.push({
      userId: row.user_id,
      feedId: row.feed_id,
      holding: row.holding,
      strength: row.strength,
      witness:
        row.witness_kind === 'automatic'
          ? {
              kind: 'automatic',
              userId: row.user_id,
              feedId: row.feed_id,
              inferenceVersion: row.inference_version ?? '0',
            }
          : { kind: 'manual', analysisRequestId: row.request_id ?? '' },
    });
  }
  return [...byCard.values()];
}

/** A stable identity of a witness (deduplication and ordering). */
export function witnessKey(w: InferenceWitness): string {
  return w.kind === 'automatic'
    ? `a:${w.userId}:${w.feedId}:${w.inferenceVersion}`
    : `m:${w.analysisRequestId}`;
}

/** Distinct witnesses of several lists, in a stable order (a request's authorization). */
export function mergeWitnesses(
  ...lists: ReadonlyArray<readonly InferenceWitness[]>
): InferenceWitness[] {
  const seen = new Map<string, InferenceWitness>();
  for (const list of lists) {
    for (const w of list) {
      const key = witnessKey(w);
      if (!seen.has(key)) seen.set(key, w);
    }
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, w]) => w);
}

/** Distinct witnesses of a set of pair demands, in a stable order (the pack's authorization). */
export function pairWitnesses(demands: readonly CardPairDemand[]): InferenceWitness[] {
  return mergeWitnesses(...demands.map((demand) => demand.holders.map((h) => h.witness)));
}
