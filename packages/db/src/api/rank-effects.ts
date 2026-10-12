import {
  autoFlagCounts,
  DEMOTION_FLAGS,
  demotionStateOf,
  RANK_WINDOW_DAYS,
  type DemotionFlag,
  type DemotionState,
  type JobSender,
  type RankerConfig,
  type UserPreferences,
} from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import { recordRankIntents } from '../ingest/rank-intents.js';
import { loadRecentDislikes } from '../rank/context.js';
import { rankWindowMembers } from '../rank/window.js';
import type { TenantTx } from '../tenant.js';

/**
 * What a reader action does to the ranking (S22, owner decision 2026-10-11): it makes exactly the
 * rows whose ranking can differ due, and enqueues one incremental, debounced `user.rank`. The one
 * action that still ranks everything is a flip of an automatic demotion flag, and a bulk mark-read
 * of more than {@link BULK_FULL_RANK_TARGETS} targets.
 *
 * The reader state the ranker reads (spec 06 §7 step 1) and how a change reaches the rows:
 *
 * - `read_at`: a cluster's seen state (`readClusterIds`, the latest read of the cluster). Every
 *   non-archived row of the cluster is made due, and a placeholder row is made for every cluster
 *   member the user's subscriptions carry in the window that has no row yet (a run that is writing
 *   its stale result for that member would otherwise insert it with no deadline).
 * - `archived_at` set to null (unhide, unread, undo): the article re-enters the window; its own row.
 * - `label_ids` shrinking (unlabel, undo of a label): the label suggestion may return; its own row.
 * - dislikes (rating, reason, rated_at, the stale-at-feedback snapshot): the demotion state. An
 *   `auto` flag crossing `autoMinDislikes` either way changes every row: one full rank with a
 *   revision bump. A flag that stays active but whose deadline moved earlier makes the rows that
 *   fired `demote:<flag>` due.
 *
 * Marking is `next_rank_at = clock_timestamp()`: the dirty set treats `next_rank_at <= now` as
 * dirty, the API list reports `rankingPending` from it, and `writeRankBatch` keeps a mark newer than
 * the run's context time.
 */

/** A mark-read of more targets than this records one full rank instead of marking rows. */
export const BULK_FULL_RANK_TARGETS = 2_000;

/** What one article target changed, derived from its row before the action and the applied patch. */
export interface ReaderRankChange {
  articleId: string;
  clusterId: string | null;
  /** `read_at` set, cleared or moved. */
  readChanged: boolean;
  /** `archived_at` went from set to null. */
  unarchived: boolean;
  /** At least one `label_ids` entry was removed. */
  labelRemoved: boolean;
}

interface RowBefore {
  readAt: Date | null;
  archivedAt: Date | null;
  labelIds: readonly string[];
}

interface PatchLike {
  readAt?: Date | null | undefined;
  archivedAt?: Date | null | undefined;
  labelIds?: readonly string[] | undefined;
}

/** The rank-relevant change of applying `patch` to a row (`null`: the article had no row yet). */
export function rankChangeOf(
  article: { articleId: string; storyClusterId: string | null },
  row: RowBefore | null,
  patch: PatchLike,
): ReaderRankChange {
  const beforeRead = row?.readAt?.getTime() ?? null;
  const readChanged =
    patch.readAt !== undefined && (patch.readAt?.getTime() ?? null) !== beforeRead;
  const unarchived =
    patch.archivedAt !== undefined && patch.archivedAt === null && row?.archivedAt != null;
  const labelRemoved =
    patch.labelIds !== undefined &&
    (row?.labelIds ?? []).some((id) => !(patch.labelIds ?? []).includes(id));
  return {
    articleId: article.articleId,
    clusterId: article.storyClusterId,
    readChanged,
    unarchived,
    labelRemoved,
  };
}

/** The user's auto-demotion state at one moment (before or after an action). */
export interface DemotionProbe {
  state: DemotionState;
  /** The flags that are `auto` for the user and whose count reaches `autoMinDislikes`. */
  active: ReadonlySet<DemotionFlag>;
}

/** Load the demotion state from the user's current dislikes (a tenant read). */
export async function probeDemotion(
  tx: TenantTx,
  input: {
    user: string;
    now: Date;
    config: Pick<RankerConfig, 'demotion'>;
    prefs: Pick<UserPreferences, 'demote'>;
  },
): Promise<DemotionProbe> {
  const { autoMinDislikes, autoWindowDays } = input.config.demotion;
  const since = new Date(input.now.getTime() - autoWindowDays * 86_400_000);
  const dislikes = await loadRecentDislikes(tx, input.user, since);
  const state = demotionStateOf(dislikes, { autoMinDislikes, autoWindowDays });
  const active = new Set<DemotionFlag>(
    DEMOTION_FLAGS.filter(
      (flag) => input.prefs.demote[flag] === 'auto' && autoFlagCounts(flag, state, autoMinDislikes),
    ),
  );
  return { state, active };
}

/** The `rules_fired` code of a demotion flag (`RULE_CODES.demote*` of the ranker). */
const demoteCode = (flag: DemotionFlag): string => `demote:${flag}`;

/** The flags whose activation flipped, and those that stay active with an earlier deadline. */
function demotionDiff(
  before: DemotionProbe,
  after: DemotionProbe,
): { flipped: boolean; earlier: DemotionFlag[] } {
  const flipped = DEMOTION_FLAGS.some((flag) => before.active.has(flag) !== after.active.has(flag));
  const earlier = DEMOTION_FLAGS.filter((flag) => {
    if (!before.active.has(flag) || !after.active.has(flag)) return false;
    const was = before.state.demotionDeadlines[flag]?.getTime();
    const now = after.state.demotionDeadlines[flag]?.getTime();
    return now !== undefined && (was === undefined || now < was);
  });
  return { flipped, earlier };
}

export interface ReaderRankEffects {
  user: string;
  outbox: JobSender;
  /** The action's name; the intent's reason is `feedback:<action>`. */
  action: string;
  now: Date;
  changes: readonly ReaderRankChange[];
  /** The demotion state before and after the action, for the actions that change ratings. */
  demotion?: { before: DemotionProbe; after: DemotionProbe } | undefined;
}

/**
 * Record the ranking effects of a reader action inside its transaction (the caller holds the
 * user row `FOR NO KEY UPDATE`, which the rank write fence and `loadRankUser` order against).
 * Returns what was recorded, for tests and logs.
 */
export async function recordReaderRankEffects(
  tx: TenantTx,
  input: ReaderRankEffects,
): Promise<'full' | 'marked' | 'none'> {
  const reason = `feedback:${input.action}`;
  const diff =
    input.demotion === undefined
      ? { flipped: false, earlier: [] as DemotionFlag[] }
      : demotionDiff(input.demotion.before, input.demotion.after);
  const readChanges = input.changes.filter((c) => c.readChanged);
  if (diff.flipped || readChanges.length > BULK_FULL_RANK_TARGETS) {
    await recordRankIntents(tx, input.outbox, [input.user], { reason, full: true });
    return 'full';
  }
  const clusters = [
    ...new Set(readChanges.flatMap((c) => (c.clusterId === null ? [] : [c.clusterId]))),
  ];
  const selves = input.changes
    .filter((c) => c.unarchived || c.labelRemoved)
    .map((c) => c.articleId);
  const codes = diff.earlier.map(demoteCode);
  if (clusters.length === 0 && selves.length === 0 && codes.length === 0) return 'none';

  const marked = await markRowsDue(tx, input.user, input.now, { clusters, selves, codes });
  const created =
    clusters.length === 0
      ? 0
      : await insertClusterPlaceholders(tx, input.user, clusters, input.now);
  if (marked + created === 0) return 'none';
  await recordRankIntents(tx, input.outbox, [input.user], { reason });
  return 'marked';
}

/**
 * `next_rank_at = clock_timestamp()` on the non-archived rows of the clusters, selves and codes that
 * are in the user's rank window (the rows a run visits); a mark outside it could never be cleared.
 */
async function markRowsDue(
  tx: TenantTx,
  user: string,
  now: Date,
  targets: { clusters: string[]; selves: string[]; codes: string[] },
): Promise<number> {
  const candidates = sql`
    SELECT x FROM unnest(${sql.param(targets.selves)}::bigint[]) AS x
    UNION SELECT a.id FROM articles a
           WHERE a.story_cluster_id = ANY(${sql.param(targets.clusters)}::bigint[])
    UNION SELECT c.article_id FROM user_article c
           WHERE c.user_id = ${user}::uuid AND c.rules_fired && ${sql.param(targets.codes)}::text[]`;
  const members = rankWindowMembers(
    { userId: user, now, windowDays: RANK_WINDOW_DAYS },
    sql`WITH cand(id) AS (${candidates}) SELECT id FROM cand`,
  );
  const result = await tx.execute<{ article_id: string }>(sql`
    UPDATE user_article ua SET next_rank_at = clock_timestamp()
     WHERE ua.user_id = ${user}::uuid AND ua.archived_at IS NULL
       AND ua.article_id IN ${members}
    RETURNING ua.article_id::text AS article_id`);
  return result.rows.length;
}

/**
 * A due placeholder row for every member of the clusters that is in the user's rank window and has no
 * row yet. A concurrent run that is about to insert its (stale) result for such a member then updates
 * this row, and `writeRankBatch` keeps the mark.
 */
async function insertClusterPlaceholders(
  tx: TenantTx,
  user: string,
  clusters: string[],
  now: Date,
): Promise<number> {
  const members = rankWindowMembers(
    { userId: user, now, windowDays: RANK_WINDOW_DAYS },
    sql`SELECT a.id FROM articles a WHERE a.story_cluster_id = ANY(${sql.param(clusters)}::bigint[])`,
  );
  const result = await tx.execute<{ article_id: string }>(sql`
    INSERT INTO user_article (user_id, article_id, next_rank_at)
    SELECT ${user}::uuid, m.article_id, clock_timestamp()
      FROM ${members} m
     ORDER BY m.article_id
    ON CONFLICT (user_id, article_id) DO NOTHING
    RETURNING article_id::text AS article_id`);
  return result.rows.length;
}
