import { cardTextHash } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import { parseCardBody, serializeCardBody } from '../cards/body.js';
import {
  validateCardExample,
  validateCardInterest,
  validateCardLang,
  validateCardNotFor,
  validateCardStrength,
  validateCardTitle,
  type CardStrength,
} from '../cards/validation.js';
import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';
import {
  copySampleRows,
  createDataset,
  getDataset,
  headDataset,
  lockDatasetAdditions,
  unusedDatasetVersion,
  type DatasetRow,
} from './datasets.js';
import { SAMPLE_EXCLUDED_STATES } from './collection.js';
import { EVAL_USER_EMAIL } from './system-user.js';

/**
 * The rating app's data (spec 10 §2.2–§2.4, spec 02 §7): rater cards, picked feeds, assignments,
 * ratings and facet labels. Every function takes the rater id (or the labeller) from the caller's
 * authenticated session and scopes each read and write to it: the worker role bypasses RLS, so these
 * ownership filters are the only isolation between raters.
 */

// ── Cards (step 1) ────────────────────────────────────────────────────────────────────────────────

export interface RaterCardInput {
  /** Defaults to the first 60 characters of `interest` (spec 05 §5.1). */
  title: string | null;
  interest: string;
  notFor: string | null;
  strength: CardStrength;
  examplesYes: readonly string[];
  examplesNo: readonly string[];
  /** ISO 639-1 code or `und` (spec 07 §5: `interest_cards.lang`). */
  lang: string;
}

export interface RaterCard {
  cardId: string;
  title: string;
  interest: string;
  notFor: string | null;
  interestEn: string | null;
  notForEn: string | null;
  examplesYes: string[];
  examplesNo: string[];
  lang: string;
  strength: CardStrength;
}

type RaterCardDbRow = {
  card_id: string;
  title: string;
  body: unknown;
  lang: string;
  strength: CardStrength;
};

/** A rater's cards in the order they were written (card id). */
export async function listRaterCards(db: Executor, raterId: string): Promise<RaterCard[]> {
  const result = await db.execute<RaterCardDbRow>(sql`
    SELECT c.id::text AS card_id, c.title, c.body, c.lang, rc.strength
      FROM eval.rater_cards rc JOIN interest_cards c ON c.id = rc.card_id
     WHERE rc.rater_id = ${raterId}::bigint
     ORDER BY c.id`);
  return result.rows.map((row) => {
    const body = parseCardBody(row.body);
    return {
      cardId: row.card_id,
      title: row.title,
      interest: body.interest,
      notFor: body.notFor,
      interestEn: body.interestEn,
      notForEn: body.notForEn,
      examplesYes: body.examplesYes,
      examplesNo: body.examplesNo,
      lang: row.lang,
      strength: row.strength,
    };
  });
}

/**
 * Store a card the rater wrote (spec 10 §2.2): a real `interest_cards` row with visibility `shared`
 * (reused by `text_hash` when identical text exists, un-retired if needed) plus the
 * `eval.rater_cards` link with its strength. Writing the same text again only changes the strength.
 * Rows are immutable, so the card text a run froze can never change underneath it. When the head
 * dataset version is frozen, the next open version is created first, so the change reaches the next
 * runs ({@link openDatasetForCorrection}).
 */
export async function addRaterCard(
  tx: Transaction,
  raterId: string,
  input: RaterCardInput,
): Promise<{ cardId: string; reused: boolean }> {
  const interest = validateCardInterest(input.interest);
  const notFor = validateCardNotFor(input.notFor);
  const title = validateCardTitle(
    input.title === null || input.title.trim() === ''
      ? [...interest].slice(0, 60).join('').trim()
      : input.title,
  );
  const strength = validateCardStrength(input.strength);
  const lang = validateCardLang(input.lang);
  const examplesYes = input.examplesYes.map((e) => validateCardExample(e, 'examplesYes'));
  const examplesNo = input.examplesNo.map((e) => validateCardExample(e, 'examplesNo'));
  const textHash = cardTextHash({
    kind: 'interest',
    title,
    interest,
    not_for: notFor,
    examples_yes: examplesYes,
    examples_no: examplesNo,
    visibility: 'shared',
  });
  const body = serializeCardBody({
    interest,
    notFor,
    interestEn: null,
    notForEn: null,
    examplesYes,
    examplesNo,
  });
  await openDatasetForCorrection(tx, 'cards');
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO interest_cards (kind, title, body, text_hash, lang, origin, visibility,
                                creator_user_id)
    VALUES ('interest', ${title}, ${JSON.stringify(body)}::jsonb, ${textHash}, ${lang}, 'user',
            'shared', (SELECT id FROM users WHERE email = ${EVAL_USER_EMAIL}))
    ON CONFLICT (text_hash) DO NOTHING
    RETURNING id::text AS id`);
  let cardId = inserted.rows[0]?.id;
  const reused = cardId === undefined;
  if (cardId === undefined) {
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM interest_cards WHERE text_hash = ${textHash} FOR NO KEY UPDATE`);
    cardId = existing.rows[0]?.id;
    if (cardId === undefined) throw new Error('card vanished after a text_hash conflict');
    await tx.execute(sql`
      UPDATE interest_cards SET retired_at = NULL
       WHERE id = ${cardId}::bigint AND retired_at IS NOT NULL`);
  }
  await tx.execute(sql`
    INSERT INTO eval.rater_cards (rater_id, card_id, strength)
    VALUES (${raterId}::bigint, ${cardId}::bigint, ${strength})
    ON CONFLICT (rater_id, card_id) DO UPDATE SET strength = EXCLUDED.strength`);
  return { cardId, reused };
}

/**
 * Remove one of the rater's cards (the card row stays: other raters or runs may use it). Like
 * {@link addRaterCard}, a removal under a frozen head first creates the next open version.
 */
export async function removeRaterCard(
  tx: Transaction,
  raterId: string,
  cardId: string,
): Promise<boolean> {
  const linked = await tx.execute(sql`
    SELECT 1 FROM eval.rater_cards WHERE rater_id = ${raterId}::bigint AND card_id = ${cardId}::bigint`);
  if ((linked.rowCount ?? 0) === 0) return false;
  await openDatasetForCorrection(tx, 'cards');
  const result = await tx.execute(sql`
    DELETE FROM eval.rater_cards WHERE rater_id = ${raterId}::bigint AND card_id = ${cardId}::bigint`);
  return (result.rowCount ?? 0) > 0;
}

// ── Feeds (step 2) ────────────────────────────────────────────────────────────────────────────────

export interface GoldenFeed {
  feedId: string;
  title: string | null;
  url: string;
  siteUrl: string | null;
  langHint: string | null;
}

/** The golden feeds: those the evaluation user is subscribed to (spec 10 §2.1), by language hint. */
export async function listGoldenFeeds(db: Executor): Promise<GoldenFeed[]> {
  const result = await db.execute<{
    feed_id: string;
    title: string | null;
    url: string;
    site_url: string | null;
    lang_hint: string | null;
  }>(sql`
    SELECT f.id::text AS feed_id, f.title, f.url, f.site_url, f.lang_hint
      FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN feeds f ON f.id = s.feed_id
     WHERE u.email = ${EVAL_USER_EMAIL}
     ORDER BY f.lang_hint NULLS LAST, lower(coalesce(f.title, f.url)), f.id`);
  return result.rows.map((row) => ({
    feedId: row.feed_id,
    title: row.title,
    url: row.url,
    siteUrl: row.site_url,
    langHint: row.lang_hint,
  }));
}

export async function listRaterFeedIds(db: Executor, raterId: string): Promise<string[]> {
  const result = await db.execute<{ feed_id: string }>(sql`
    SELECT feed_id::text AS feed_id FROM eval.rater_feeds
     WHERE rater_id = ${raterId}::bigint ORDER BY feed_id`);
  return result.rows.map((row) => row.feed_id);
}

/**
 * Replace the rater's picked feeds. Only golden feeds are kept (anything else is ignored); returns
 * the stored ids.
 */
export async function setRaterFeeds(
  tx: Transaction,
  raterId: string,
  feedIds: readonly string[],
): Promise<string[]> {
  await tx.execute(sql`DELETE FROM eval.rater_feeds WHERE rater_id = ${raterId}::bigint`);
  const result = await tx.execute<{ feed_id: string }>(sql`
    INSERT INTO eval.rater_feeds (rater_id, feed_id)
    SELECT ${raterId}::bigint, s.feed_id
      FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE u.email = ${EVAL_USER_EMAIL}
       AND s.feed_id = ANY(${sql.param([...feedIds])}::bigint[])
    ON CONFLICT DO NOTHING
    RETURNING feed_id::text AS feed_id`);
  return result.rows
    .map((row) => row.feed_id)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
}

// ── Assignments (step 3) ──────────────────────────────────────────────────────────────────────────

/** Serialize assignment building and the card/feed steps of one rater (`FOR UPDATE`). */
export async function lockRater(tx: Transaction, raterId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT 1 FROM eval.raters WHERE id = ${raterId}::bigint FOR UPDATE`,
  );
  return result.rows.length > 0;
}

export interface AssignedArticle {
  articleId: string;
  position: number;
  status: 'pending' | 'rated' | 'skipped';
  /** The language of the article's sample row in `version` (`articles.lang` if it has none). */
  lang: string | null;
}

/** The rater's assignments in position order, with each article's language. */
export async function listAssignments(
  db: Executor,
  raterId: string,
  version: string | null,
): Promise<AssignedArticle[]> {
  const result = await db.execute<{
    article_id: string;
    position: number;
    status: AssignedArticle['status'];
    lang: string | null;
  }>(sql`
    SELECT a.article_id::text AS article_id, a.position, a.status,
           coalesce(s.lang, ar.lang) AS lang
      FROM eval.assignments a
      JOIN articles ar ON ar.id = a.article_id
      LEFT JOIN eval.sample s ON s.article_id = a.article_id AND s.dataset_version = ${version}
     WHERE a.rater_id = ${raterId}::bigint
     ORDER BY a.position`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    position: row.position,
    status: row.status,
    lang: row.lang,
  }));
}

export interface AssignmentCandidate {
  articleId: string;
  lang: string;
}

/**
 * Sample rows of `version` in the rater's languages whose frozen snapshot names one of `feedIds` as
 * a carrier feed (spec 10 §2.2: "articles from eval.sample carried by the rater's picked feeds").
 * A carrier merged into a picked feed after sampling still counts: the snapshot keeps the source id
 * while the rater's feeds were remapped to the survivor, so the merge chain is followed back (at
 * most 20 merges, as in the golden collection).
 */
export async function sampleCandidates(
  db: Executor,
  input: { version: string; langs: readonly string[]; feedIds: readonly string[] },
): Promise<AssignmentCandidate[]> {
  if (input.feedIds.length === 0 || input.langs.length === 0) return [];
  const result = await db.execute<{ article_id: string; lang: string }>(sql`
    WITH RECURSIVE carriers AS (
      SELECT unnest(${sql.param([...input.feedIds])}::bigint[]) AS id, 0 AS depth
      UNION
      SELECT f.id, c.depth + 1
        FROM carriers c JOIN feeds f ON f.merged_into_id = c.id
       WHERE c.depth < 20)
    SELECT s.article_id::text AS article_id, s.lang
      FROM eval.sample s
     WHERE s.dataset_version = ${input.version}
       AND s.lang = ANY(${sql.param([...input.langs])}::text[])
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'carrierFeeds') cf
                    WHERE cf->>'feedId' IN (SELECT id::text FROM carriers))
     ORDER BY s.article_id`);
  return result.rows.map((row) => ({ articleId: row.article_id, lang: row.lang }));
}

/**
 * Recent articles of the rater's feeds that `version` does not hold yet, newest first and at most
 * `limit` per language: the top-up pool when the sample runs short (spec 10 §2.2). Stale and failed
 * articles are left out.
 */
export async function recentUnsampledCandidates(
  db: Executor,
  input: {
    version: string;
    langs: readonly string[];
    feedIds: readonly string[];
    since: Date;
    limit: number;
  },
): Promise<AssignmentCandidate[]> {
  if (input.feedIds.length === 0 || input.langs.length === 0 || input.limit <= 0) return [];
  // The limit applies per language, so a language with many newer articles cannot crowd the others
  // out of the pool before the planner applies its equal language shares.
  const result = await db.execute<{ article_id: string; lang: string }>(sql`
    SELECT article_id, lang FROM (
      SELECT a.id::text AS article_id, a.lang, recent.seen, a.id,
             row_number() OVER (PARTITION BY a.lang ORDER BY recent.seen DESC, a.id DESC) AS rank
        FROM articles a
        JOIN (SELECT fi.article_id, max(fi.first_seen_at) AS seen
                FROM feed_items fi
               WHERE fi.feed_id = ANY(${sql.param([...input.feedIds])}::bigint[])
                 AND fi.first_seen_at >= ${input.since.toISOString()}::timestamptz
               GROUP BY fi.article_id) recent ON recent.article_id = a.id
       WHERE a.lang = ANY(${sql.param([...input.langs])}::text[])
         AND a.pipeline_state <> ALL(${sql.param([...SAMPLE_EXCLUDED_STATES])}::text[])
         AND NOT EXISTS (SELECT 1 FROM eval.sample s
                          WHERE s.dataset_version = ${input.version} AND s.article_id = a.id)
    ) ranked
     WHERE rank <= ${input.limit}
     ORDER BY seen DESC, id DESC`);
  return result.rows.map((row) => ({ articleId: row.article_id, lang: row.lang }));
}

/**
 * Share-lock planned top-up articles (`FOR SHARE OF a`, in id order) and return those that still
 * qualify: the same language as planned, and extracted or later (not ingested, stale or failed, as
 * in the sample draw). The ingest-only worker cannot
 * change a locked article until the transaction ends, so the snapshots built afterwards in the same
 * transaction see exactly what was revalidated here. Must run inside a transaction.
 */
export async function lockTopUpArticles(
  tx: Transaction,
  candidates: ReadonlyArray<{ articleId: string; lang: string }>,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const planned = new Map(candidates.map((c) => [c.articleId, c.lang]));
  const result = await tx.execute<{ id: string; lang: string | null; pipeline_state: string }>(sql`
    SELECT a.id::text AS id, a.lang, a.pipeline_state
      FROM articles a
     WHERE a.id = ANY(${sql.param([...planned.keys()])}::bigint[])
     ORDER BY a.id
       FOR SHARE OF a`);
  return result.rows
    .filter(
      (row) =>
        row.lang !== null &&
        row.lang === planned.get(row.id) &&
        !(SAMPLE_EXCLUDED_STATES as readonly string[]).includes(row.pipeline_state),
    )
    .map((row) => row.id);
}

/** Append assignments after the rater's last position; returns the number inserted. */
export async function appendAssignments(
  tx: Transaction,
  raterId: string,
  articleIds: readonly string[],
): Promise<number> {
  if (articleIds.length === 0) return 0;
  const result = await tx.execute(sql`
    INSERT INTO eval.assignments (rater_id, article_id, position)
    SELECT ${raterId}::bigint, x.article_id,
           (SELECT coalesce(max(position) + 1, 0) FROM eval.assignments
             WHERE rater_id = ${raterId}::bigint) + x.ord - 1
      FROM unnest(${sql.param([...articleIds])}::bigint[]) WITH ORDINALITY AS x(article_id, ord)
    ON CONFLICT (rater_id, article_id) DO NOTHING`);
  return result.rowCount ?? 0;
}

// ── Rating ────────────────────────────────────────────────────────────────────────────────────────

/** Dislike reasons (spec 09 §3.3 reason bar; the `user_article.reason` set of spec 02). */
export const DISLIKE_REASONS = [
  'off_topic',
  'clickbait',
  'seen',
  'shallow',
  'promo',
  'other',
] as const;
export type DislikeReason = (typeof DISLIKE_REASONS)[number];

export interface AssignmentView {
  articleId: string;
  position: number;
  status: AssignedArticle['status'];
  rating: 1 | -1 | null;
  reason: DislikeReason | null;
  /** The rater's optional note on a skip (only while `status = 'skipped'`). */
  skipReason: string | null;
}

/** Longest skip reason (the `assignments_skip_reason_check` limit). */
export const SKIP_REASON_MAX = 500;

type AssignmentViewRow = {
  article_id: string;
  position: number;
  status: AssignedArticle['status'];
  rating: number | null;
  reason: DislikeReason | null;
  skip_reason: string | null;
};

const toView = (row: AssignmentViewRow): AssignmentView => ({
  articleId: row.article_id,
  position: row.position,
  status: row.status,
  rating: row.rating === 1 ? 1 : row.rating === -1 ? -1 : null,
  reason: row.reason,
  skipReason: row.skip_reason,
});

/** The rater's assignment at `position` with its current rating; null when there is none. */
export async function assignmentAt(
  db: Executor,
  raterId: string,
  position: number,
): Promise<AssignmentView | null> {
  const result = await db.execute<AssignmentViewRow>(sql`
    SELECT a.article_id::text AS article_id, a.position, a.status, g.rating, g.reason,
           a.skip_reason
      FROM eval.assignments a
      LEFT JOIN eval.ratings g ON g.rater_id = a.rater_id AND g.article_id = a.article_id
     WHERE a.rater_id = ${raterId}::bigint AND a.position = ${position}`);
  const row = result.rows[0];
  return row === undefined ? null : toView(row);
}

export interface AssignmentProgress {
  total: number;
  pending: number;
  rated: number;
  skipped: number;
  likes: number;
  dislikes: number;
}

export async function assignmentProgress(
  db: Executor,
  raterId: string,
): Promise<AssignmentProgress> {
  const result = await db.execute<{ [K in keyof AssignmentProgress]: number }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE a.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE a.status = 'rated')::int AS rated,
           count(*) FILTER (WHERE a.status = 'skipped')::int AS skipped,
           count(*) FILTER (WHERE g.rating = 1)::int AS likes,
           count(*) FILTER (WHERE g.rating = -1)::int AS dislikes
      FROM eval.assignments a
      LEFT JOIN eval.ratings g ON g.rater_id = a.rater_id AND g.article_id = a.article_id
     WHERE a.rater_id = ${raterId}::bigint`);
  return result.rows[0] ?? { total: 0, pending: 0, rated: 0, skipped: 0, likes: 0, dislikes: 0 };
}

/**
 * The first pending position after `after` (wrapping to the start), or null when nothing is
 * pending. `after = -1` finds the first pending position.
 */
export async function nextPendingPosition(
  db: Executor,
  raterId: string,
  after: number,
): Promise<number | null> {
  const result = await db.execute<{ position: number }>(sql`
    SELECT position FROM eval.assignments
     WHERE rater_id = ${raterId}::bigint AND status = 'pending'
     ORDER BY (position <= ${after}), position LIMIT 1`);
  return result.rows[0]?.position ?? null;
}

/**
 * Before a rating correction (spec 10 §2.1: "once frozen, … rating corrections … create a new
 * version manifest"), before new assignments (the manifest's assignment membership, `cause`
 * `'assignments'`), before a rater's card change (`'cards'`) or before a facet label change
 * (`'facets'`; runs read cards and labels from the version's freeze-time ground truth): when the
 * head dataset version is frozen, create the next open version in this transaction, copying every
 * row unchanged (the top-up path). Every caller takes the additions lock first and then shares the
 * open head's row, so a concurrent freeze waits until this transaction commits and its ground truth
 * then includes the change. Earlier runs keep the exact ratings they froze in their own config.
 * Returns the version created, or null when none was.
 */
export async function openDatasetForCorrection(
  tx: Transaction,
  cause: 'rating' | 'assignments' | 'cards' | 'facets' = 'rating',
  /**
   * The rated, labelled or newly assigned articles. Ratings are per (rater, article) and
   * assignments record no version, so the change is ground truth for every lineage whose tip holds
   * one of them (`eval sample --version` may have started several): each such frozen tip gets its
   * next open version, the head's (or else the newest tip's) last. With no tip holding one, the head
   * is used. Cards are ground truth for every article, so a `'cards'` change opens every tip.
   */
  articleIds?: string | readonly string[],
): Promise<{ version: string; createdFrom: string } | null> {
  // The additions lock first, then the dataset row: the same order as the freeze and top-up paths,
  // so a mutation racing a run's freeze waits instead of deadlocking.
  await lockDatasetAdditions(tx);
  const head = await headDataset(tx);
  const ids = articleIds === undefined ? [] : [articleIds].flat();
  const tips =
    cause === 'cards'
      ? await lineageTips(tx, head, null)
      : ids.length === 0
        ? []
        : await lineageTips(tx, head, ids);
  if (tips.length === 0) return head === null ? null : openNextVersion(tx, head, cause);
  // A head that holds the change but is open gets no next version: the other lineages' new
  // versions are dated just before it, so it stays the head. A head that holds none of the
  // articles yields to the newest lineage that does, so a later freeze captures the change.
  const keepHead =
    head !== null && head.frozenAt === null && tips.some((t) => t.version === head.version)
      ? head.version
      : undefined;
  let opened: { version: string; createdFrom: string } | null = null;
  for (const tip of tips) opened = await openNextVersion(tx, tip, cause, keepHead);
  // The preferred tip's (last) result: the head's next version, or null when the head was open.
  return opened;
}

/** Create the next open version of `base` when it is frozen (see {@link openDatasetForCorrection}). */
async function openNextVersion(
  tx: Transaction,
  base: DatasetRow,
  cause: 'rating' | 'assignments' | 'cards' | 'facets',
  createdBefore?: string,
): Promise<{ version: string; createdFrom: string } | null> {
  if (base.frozenAt === null) {
    const locked = await tx.execute<{ frozen: boolean }>(sql`
      SELECT frozen_at IS NOT NULL AS frozen FROM eval.datasets
       WHERE version = ${base.version} FOR SHARE`);
    if (locked.rows[0]?.frozen !== true) return null;
  }
  const current = await getDataset(tx, base.version);
  if (current === null || current.frozenAt === null) return null;
  const version = await unusedDatasetVersion(tx, current.version);
  await createDataset(tx, {
    version,
    parentVersion: current.version,
    ...(createdBefore === undefined ? {} : { createdBefore }),
    seed: current.seed,
    params: {
      ...current.params,
      ...(cause === 'rating'
        ? { correctionOf: current.version }
        : cause === 'assignments'
          ? { assignmentsAfter: current.version }
          : cause === 'cards'
            ? { cardsChangedAfter: current.version }
            : { facetsChangedAfter: current.version }),
    },
  });
  await copySampleRows(tx, current.version, version);
  return { version, createdFrom: current.version };
}

/**
 * Every lineage tip (a version no other version names as parent), or only those whose sample holds
 * one of `articleIds`, the preferred one last: the head when it is one, else the newest such tip.
 */
async function lineageTips(
  tx: Transaction,
  head: DatasetRow | null,
  articleIds: readonly string[] | null,
): Promise<DatasetRow[]> {
  const holding =
    articleIds === null
      ? sql``
      : sql` AND EXISTS (SELECT 1 FROM eval.sample s
                          WHERE s.dataset_version = d.version
                            AND s.article_id = ANY(${sql.param([...articleIds])}::bigint[]))`;
  const result = await tx.execute<{ version: string }>(sql`
    SELECT d.version FROM eval.datasets d
     WHERE NOT EXISTS (SELECT 1 FROM eval.datasets c WHERE c.parent_version = d.version)${holding}
     ORDER BY (d.version = ${head?.version ?? null}) IS TRUE, d.created_at, d.version`);
  const tips: DatasetRow[] = [];
  for (const row of result.rows) {
    const tip = await getDataset(tx, row.version);
    if (tip !== null) tips.push(tip);
  }
  return tips;
}

/** Whether the rater has an assignment at `position`, its article, and whether it has a rating. */
async function assignmentState(
  tx: Transaction,
  raterId: string,
  position: number,
): Promise<{ rated: boolean; articleId: string } | null> {
  const result = await tx.execute<{ rated: boolean; article_id: string }>(sql`
    SELECT EXISTS (SELECT 1 FROM eval.ratings g
                    WHERE g.rater_id = a.rater_id AND g.article_id = a.article_id) AS rated,
           a.article_id::text AS article_id
      FROM eval.assignments a
     WHERE a.rater_id = ${raterId}::bigint AND a.position = ${position}`);
  const row = result.rows[0];
  return row === undefined ? null : { rated: row.rated, articleId: row.article_id };
}

/**
 * Rate the article at the rater's `position` (spec 10 §2.2): upsert `eval.ratings` (a later rating
 * replaces the earlier one; a reason only goes with a dislike) and mark the assignment `rated`.
 * Returns null when the rater has no assignment at that position. When the head dataset version is
 * frozen, the next open version is created first ({@link openDatasetForCorrection}).
 */
export async function rateAssignment(
  tx: Transaction,
  input: {
    raterId: string;
    position: number;
    rating: 1 | -1;
    reason: DislikeReason | null;
    now: Date;
  },
): Promise<AssignmentView | null> {
  const reason = input.rating === -1 ? input.reason : null;
  // Every rating (new or changed) is ground truth: never mutate a frozen version's in place.
  const state = await assignmentState(tx, input.raterId, input.position);
  if (state === null) return null;
  await openDatasetForCorrection(tx, 'rating', state.articleId);
  const assignment = await tx.execute<{ article_id: string }>(sql`
    UPDATE eval.assignments SET status = 'rated', skip_reason = NULL
     WHERE rater_id = ${input.raterId}::bigint AND position = ${input.position}
    RETURNING article_id::text AS article_id`);
  const articleId = assignment.rows[0]?.article_id;
  if (articleId === undefined) return null;
  await tx.execute(sql`
    INSERT INTO eval.ratings (rater_id, article_id, rating, reason, created_at)
    VALUES (${input.raterId}::bigint, ${articleId}::bigint, ${input.rating}, ${reason},
            ${input.now.toISOString()}::timestamptz)
    ON CONFLICT (rater_id, article_id) DO UPDATE
      SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`);
  return {
    articleId,
    position: input.position,
    status: 'rated',
    rating: input.rating,
    reason,
    skipReason: null,
  };
}

/**
 * Skip the article at `position` (spec 10 §2.2): status `skipped` with the optional reason (trimmed,
 * blank → NULL, at most {@link SKIP_REASON_MAX} characters) and no rating, so a skip is never read
 * as a dislike. A rating given earlier is withdrawn by the explicit skip; a later rating clears the
 * skip reason in the same UPDATE that changes the status.
 */
export async function skipAssignment(
  tx: Transaction,
  input: { raterId: string; position: number; reason?: string | null },
): Promise<AssignmentView | null> {
  const trimmed = input.reason?.trim() ?? '';
  if ([...trimmed].length > SKIP_REASON_MAX) {
    throw new RangeError(`a skip reason has at most ${SKIP_REASON_MAX} characters`);
  }
  const skipReason = trimmed === '' ? null : trimmed;
  const state = await assignmentState(tx, input.raterId, input.position);
  if (state === null) return null;
  // A skip that withdraws a rating is a rating correction too.
  if (state.rated) await openDatasetForCorrection(tx, 'rating', state.articleId);
  const assignment = await tx.execute<{ article_id: string }>(sql`
    UPDATE eval.assignments SET status = 'skipped', skip_reason = ${skipReason}
     WHERE rater_id = ${input.raterId}::bigint AND position = ${input.position}
    RETURNING article_id::text AS article_id`);
  const articleId = assignment.rows[0]?.article_id;
  if (articleId === undefined) return null;
  await tx.execute(sql`
    DELETE FROM eval.ratings WHERE rater_id = ${input.raterId}::bigint
       AND article_id = ${articleId}::bigint`);
  return {
    articleId,
    position: input.position,
    status: 'skipped',
    rating: null,
    reason: null,
    skipReason,
  };
}

export interface RatingRow {
  raterId: string;
  articleId: string;
  rating: 1 | -1;
  reason: DislikeReason | null;
  createdAt: Date;
}

/** Current ratings, optionally of some raters (the ground truth a run freezes into its config). */
export async function listRatings(
  db: Executor,
  raterIds?: readonly string[],
): Promise<RatingRow[]> {
  const filter =
    raterIds === undefined
      ? sql``
      : sql` WHERE rater_id = ANY(${sql.param([...raterIds])}::bigint[])`;
  const result = await db.execute<{
    rater_id: string;
    article_id: string;
    rating: number;
    reason: DislikeReason | null;
    created_at: RawTimestamp;
  }>(sql`
    SELECT rater_id::text AS rater_id, article_id::text AS article_id, rating, reason, created_at
      FROM eval.ratings${filter} ORDER BY rater_id, article_id`);
  return result.rows.map((row) => ({
    raterId: row.rater_id,
    articleId: row.article_id,
    rating: row.rating === 1 ? 1 : -1,
    reason: row.reason,
    createdAt: toDate(row.created_at),
  }));
}

// ── Facet labels (spec 10 §2.3) ───────────────────────────────────────────────────────────────────

/** `[articleId, lang]` of every sample row of `version` (facet set selection input). */
export async function sampleArticleLangs(
  db: Executor,
  version: string,
): Promise<AssignmentCandidate[]> {
  const result = await db.execute<{ article_id: string; lang: string }>(sql`
    SELECT article_id::text AS article_id, lang FROM eval.sample
     WHERE dataset_version = ${version} ORDER BY article_id`);
  return result.rows.map((row) => ({ articleId: row.article_id, lang: row.lang }));
}

/** Articles the labeller has labelled at least one field of. */
export async function labelledArticleIds(db: Executor, labeler: string): Promise<string[]> {
  const result = await db.execute<{ article_id: string }>(sql`
    SELECT DISTINCT article_id::text AS article_id FROM eval.facet_labels
     WHERE labeler = ${labeler} ORDER BY 1`);
  return result.rows.map((row) => row.article_id);
}

/** The labeller's values for one article, by question key. */
export async function facetLabelsOf(
  db: Executor,
  labeler: string,
  articleId: string,
): Promise<Record<string, string>> {
  const result = await db.execute<{ question_key: string; value: string }>(sql`
    SELECT question_key, value FROM eval.facet_labels
     WHERE labeler = ${labeler} AND article_id = ${articleId}::bigint`);
  return Object.fromEntries(result.rows.map((row) => [row.question_key, row.value]));
}

/**
 * Upsert all fields of one article for one labeller (one row per field). A change first opens the
 * next version of every frozen lineage holding the article ({@link openDatasetForCorrection}), so it
 * reaches the next runs; saving unchanged values creates none.
 */
export async function saveFacetLabels(
  tx: Transaction,
  input: {
    labeler: string;
    articleId: string;
    values: Readonly<Record<string, string>>;
    now: Date;
  },
): Promise<void> {
  const current = await facetLabelsOf(tx, input.labeler, input.articleId);
  const entries = Object.entries(input.values);
  if (entries.every(([questionKey, value]) => current[questionKey] === value)) return;
  await openDatasetForCorrection(tx, 'facets', input.articleId);
  for (const [questionKey, value] of entries) {
    await tx.execute(sql`
      INSERT INTO eval.facet_labels (labeler, article_id, question_key, value, created_at)
      VALUES (${input.labeler}, ${input.articleId}::bigint, ${questionKey}, ${value},
              ${input.now.toISOString()}::timestamptz)
      ON CONFLICT (article_id, question_key, labeler) DO UPDATE
        SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`);
  }
}

export interface FacetLabelRow {
  labeler: string;
  articleId: string;
  questionKey: string;
  value: string;
  createdAt: Date;
}

/** Every facet label (ordered), for runs to freeze and the report to score. */
export async function listFacetLabels(db: Executor): Promise<FacetLabelRow[]> {
  const result = await db.execute<{
    labeler: string;
    article_id: string;
    question_key: string;
    value: string;
    created_at: RawTimestamp;
  }>(sql`
    SELECT labeler, article_id::text AS article_id, question_key, value, created_at
      FROM eval.facet_labels ORDER BY labeler, article_id, question_key`);
  return result.rows.map((row) => ({
    labeler: row.labeler,
    articleId: row.article_id,
    questionKey: row.question_key,
    value: row.value,
    createdAt: toDate(row.created_at),
  }));
}
