import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/**
 * Story-cluster bookkeeping after membership changes outside the cluster stage (resets, merges,
 * spec 02 §3.3): `size` is the actual count of current members and the representative must be a
 * member. A kept representative stays; otherwise the oldest `(first_seen_at, id)` member is chosen,
 * as clustering does (spec 05 §6). An emptied cluster keeps `size = 0` and no representative until
 * housekeeping deletes it (it may still be named by a `mute_story` rule, spec 11 §5).
 */
export async function reconcileClusters(
  tx: Transaction,
  clusterIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ids = [
    ...new Set(clusterIds.filter((id): id is string => id !== null && id !== undefined)),
  ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM story_clusters WHERE id = ANY(${sql.param(ids)}::bigint[])
     ORDER BY id FOR NO KEY UPDATE`);
  await tx.execute(sql`
    UPDATE story_clusters c
       SET size = m.n,
           representative_article_id = CASE WHEN m.keeps_rep THEN c.representative_article_id
                                            ELSE m.oldest END,
           updated_at = now()
      FROM (SELECT sc.id,
                   count(a.id)::int AS n,
                   bool_or(a.id = sc.representative_article_id) IS TRUE AS keeps_rep,
                   (array_agg(a.id ORDER BY a.first_seen_at, a.id) FILTER (WHERE a.id IS NOT NULL))[1] AS oldest
              FROM story_clusters sc
              LEFT JOIN articles a ON a.story_cluster_id = sc.id
             WHERE sc.id = ANY(${sql.param(ids)}::bigint[])
             GROUP BY sc.id) m
     WHERE c.id = m.id`);
}
