import { canonicalSha256 } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

import { captureDatasetTruth } from './experiments.js';

/**
 * Golden dataset versions (spec 10 §2.1, spec 02 §7, D-96). A version is a set of `eval.sample`
 * rows: an immutable article snapshot, its hash and its development/test split. The version being
 * built accepts new rows (the sample, then rating-app top-ups) until its first model run freezes it;
 * the freeze writes the manifest once. A later top-up creates the next version, which copies every
 * row of its parent unchanged and adds its own; earlier versions never change.
 *
 * The snapshot content is built by `apps/eval` (it needs the question builders); this module only
 * stores, copies, reads and hashes rows. Hashes are canonical-JSON SHA-256 over sorted rows.
 */

export type DatasetSplit = 'dev' | 'test';

export interface DatasetRow {
  version: string;
  parentVersion: string | null;
  seed: string;
  params: Record<string, unknown>;
  manifest: DatasetManifest | null;
  snapshotSha: string | null;
  splitSha: string | null;
  createdAt: Date;
  frozenAt: Date | null;
}

/** What a freeze records (spec 10 §2.1: the membership the first model run reads). */
export interface DatasetManifest {
  version: string;
  articles: number;
  byLang: Record<string, { dev: number; test: number }>;
  /** sha256 over sorted `[articleId, snapshotSha]`. */
  snapshotSha: string;
  /** sha256 over sorted `[articleId, split, storyGroupId]`. */
  splitSha: string;
  /** sha256 over sorted `[raterId, articleId, position]` of assignments of this version's articles. */
  assignmentsSha: string;
  assignments: number;
  /** sha256 over sorted `[raterId, cardId, strength]`. */
  raterCardsSha: string;
  raterCards: number;
}

export interface SampleRowInput {
  articleId: string;
  lang: string;
  snapshot: Record<string, unknown>;
  snapshotSha: string;
  split: DatasetSplit;
}

export interface SampleRow extends SampleRowInput {
  datasetVersion: string;
  createdAt: Date;
}

type DatasetDbRow = {
  version: string;
  parent_version: string | null;
  seed: string;
  params: Record<string, unknown>;
  manifest: DatasetManifest | null;
  snapshot_sha: string | null;
  split_sha: string | null;
  created_at: RawTimestamp;
  frozen_at: RawTimestamp | null;
};

const toDataset = (row: DatasetDbRow): DatasetRow => ({
  version: row.version,
  parentVersion: row.parent_version,
  seed: row.seed,
  params: row.params,
  manifest: row.manifest,
  snapshotSha: row.snapshot_sha,
  splitSha: row.split_sha,
  createdAt: toDate(row.created_at),
  frozenAt: toDateOrNull(row.frozen_at),
});

const DATASET_COLUMNS = sql`version, parent_version, seed, params, manifest, snapshot_sha,
  split_sha, created_at, frozen_at`;

/** Dataset version names: `golden-v1`, `golden-v2`, … (any `<name>-v<n>` continues the same way). */
export function nextDatasetVersion(version: string): string {
  const match = /^(.*-v)(\d+)$/.exec(version);
  return match === null ? `${version}-v2` : `${match[1]}${Number(match[2]) + 1}`;
}

/**
 * The next version name after `version` that no dataset uses yet. Versions are named per lineage
 * (`golden-v1` → `golden-v2`), but `eval sample --version` may already have taken a name for an
 * unrelated lineage, so the counter skips past it instead of failing on the unique key.
 */
export async function unusedDatasetVersion(db: Executor, version: string): Promise<string> {
  let next = nextDatasetVersion(version);
  while ((await getDataset(db, next)) !== null) next = nextDatasetVersion(next);
  return next;
}

export async function createDataset(
  tx: Executor,
  input: {
    version: string;
    seed: string;
    params: Record<string, unknown>;
    parentVersion?: string | null;
  },
): Promise<DatasetRow> {
  const result = await tx.execute<DatasetDbRow>(sql`
    INSERT INTO eval.datasets (version, parent_version, seed, params)
    VALUES (${input.version}, ${input.parentVersion ?? null}, ${input.seed},
            ${JSON.stringify(input.params)}::jsonb)
    RETURNING ${DATASET_COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('dataset insert returned no row');
  return toDataset(row);
}

export async function getDataset(db: Executor, version: string): Promise<DatasetRow | null> {
  const result = await db.execute<DatasetDbRow>(
    sql`SELECT ${DATASET_COLUMNS} FROM eval.datasets WHERE version = ${version}`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toDataset(row);
}

/** Serialize every addition to the golden dataset (sampling and top-ups) for this transaction. */
export async function lockDatasetAdditions(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('eval.dataset.additions'))`);
}

/** Lock a version's row for a top-up or freeze decision (`FOR UPDATE`). */
export async function lockDataset(tx: Transaction, version: string): Promise<DatasetRow | null> {
  const result = await tx.execute<DatasetDbRow>(
    sql`SELECT ${DATASET_COLUMNS} FROM eval.datasets WHERE version = ${version} FOR UPDATE`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toDataset(row);
}

/**
 * The head version: the newest version of the lineage (no other version names it as parent), or
 * null when no dataset exists. With several unrelated lineages the most recently created head wins.
 */
export async function headDataset(db: Executor): Promise<DatasetRow | null> {
  const result = await db.execute<DatasetDbRow>(sql`
    SELECT ${DATASET_COLUMNS} FROM eval.datasets d
     WHERE NOT EXISTS (SELECT 1 FROM eval.datasets c WHERE c.parent_version = d.version)
     ORDER BY d.created_at DESC, d.version DESC LIMIT 1`);
  const row = result.rows[0];
  return row === undefined ? null : toDataset(row);
}

export async function listDatasets(db: Executor): Promise<DatasetRow[]> {
  const result = await db.execute<DatasetDbRow>(
    sql`SELECT ${DATASET_COLUMNS} FROM eval.datasets ORDER BY created_at, version`,
  );
  return result.rows.map(toDataset);
}

/** Merge sampling bookkeeping into an unfrozen version's params (exclusions, availability). */
export async function updateDatasetParams(
  tx: Executor,
  version: string,
  params: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    UPDATE eval.datasets SET params = params || ${JSON.stringify(params)}::jsonb
     WHERE version = ${version} AND frozen_at IS NULL`);
}

/**
 * Insert sample rows into an unfrozen version. Rows already present (same version and article) are
 * kept as they are; returns the number inserted. The append-only trigger refuses a frozen version.
 */
export async function insertSampleRows(
  tx: Executor,
  version: string,
  rows: readonly SampleRowInput[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const result = await tx.execute(sql`
      INSERT INTO eval.sample (dataset_version, article_id, lang, snapshot, snapshot_sha, split)
      SELECT ${version}, r.article_id, r.lang, r.snapshot, r.snapshot_sha, r.split
        FROM jsonb_to_recordset(${JSON.stringify(
          chunk.map((row) => ({
            article_id: row.articleId,
            lang: row.lang,
            snapshot: row.snapshot,
            snapshot_sha: row.snapshotSha,
            split: row.split,
          })),
        )}::jsonb) AS r(article_id bigint, lang text, snapshot jsonb, snapshot_sha text, split text)
      ON CONFLICT (dataset_version, article_id) DO NOTHING`);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/** Copy every row of `fromVersion` unchanged into `toVersion` (a new version starts from its parent). */
export async function copySampleRows(
  tx: Executor,
  fromVersion: string,
  toVersion: string,
): Promise<number> {
  const result = await tx.execute(sql`
    INSERT INTO eval.sample (dataset_version, article_id, lang, snapshot, snapshot_sha, split)
    SELECT ${toVersion}, article_id, lang, snapshot, snapshot_sha, split
      FROM eval.sample WHERE dataset_version = ${fromVersion}
    ON CONFLICT (dataset_version, article_id) DO NOTHING`);
  return result.rowCount ?? 0;
}

type SampleDbRow = {
  dataset_version: string;
  article_id: string;
  lang: string;
  snapshot: Record<string, unknown>;
  snapshot_sha: string;
  split: DatasetSplit;
  created_at: RawTimestamp;
};

/** A version's rows, ordered by article id; optionally narrowed to articles or languages. */
export async function loadSample(
  db: Executor,
  version: string,
  filter: { articleIds?: readonly string[]; langs?: readonly string[] } = {},
): Promise<SampleRow[]> {
  const articles =
    filter.articleIds === undefined
      ? sql``
      : sql` AND article_id = ANY(${sql.param([...filter.articleIds])}::bigint[])`;
  const langs =
    filter.langs === undefined
      ? sql``
      : sql` AND lang = ANY(${sql.param([...filter.langs])}::text[])`;
  const result = await db.execute<SampleDbRow>(sql`
    SELECT dataset_version, article_id::text AS article_id, lang, snapshot, snapshot_sha, split,
           created_at
      FROM eval.sample WHERE dataset_version = ${version}${articles}${langs}
     ORDER BY article_id`);
  return result.rows.map((row) => ({
    datasetVersion: row.dataset_version,
    articleId: row.article_id,
    lang: row.lang,
    snapshot: row.snapshot,
    snapshotSha: row.snapshot_sha,
    split: row.split,
    createdAt: toDate(row.created_at),
  }));
}

/**
 * An article's sample row for display, wherever it was sampled: the head's row when the head holds
 * it, else the newest version's. Assignments are per (rater, article), not per version, so an
 * independent lineage started by `eval sample --version` must not strand a rater's assignments
 * from an older one.
 */
export async function loadSampleArticle(
  db: Executor,
  articleId: string,
  preferVersion: string | null,
): Promise<SampleRow | undefined> {
  const result = await db.execute<SampleDbRow>(sql`
    SELECT s.dataset_version, s.article_id::text AS article_id, s.lang, s.snapshot, s.snapshot_sha,
           s.split, s.created_at
      FROM eval.sample s JOIN eval.datasets d ON d.version = s.dataset_version
     WHERE s.article_id = ${articleId}::bigint
     ORDER BY (d.version = ${preferVersion}) IS TRUE DESC, d.created_at DESC, d.version DESC
     LIMIT 1`);
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        datasetVersion: row.dataset_version,
        articleId: row.article_id,
        lang: row.lang,
        snapshot: row.snapshot,
        snapshotSha: row.snapshot_sha,
        split: row.split,
        createdAt: toDate(row.created_at),
      };
}

/**
 * The split of every story group already present in a version (`snapshot.storyGroupId`), so a
 * top-up keeps a new copy of a known story on its group's side.
 */
export async function storyGroupSplits(
  db: Executor,
  version: string,
): Promise<Map<string, DatasetSplit>> {
  const result = await db.execute<{ group_id: string; split: DatasetSplit }>(sql`
    SELECT DISTINCT snapshot->>'storyGroupId' AS group_id, split
      FROM eval.sample
     WHERE dataset_version = ${version} AND snapshot ? 'storyGroupId'`);
  return new Map(result.rows.map((row) => [row.group_id, row.split]));
}

/** The manifest a freeze records, computed from the current rows. */
export async function computeDatasetManifest(
  db: Executor,
  version: string,
): Promise<DatasetManifest> {
  const rows = await db.execute<{
    article_id: string;
    lang: string;
    snapshot_sha: string;
    split: DatasetSplit;
    group_id: string | null;
  }>(sql`
    SELECT article_id::text AS article_id, lang, snapshot_sha, split,
           snapshot->>'storyGroupId' AS group_id
      FROM eval.sample WHERE dataset_version = ${version} ORDER BY article_id`);
  const byLang: Record<string, { dev: number; test: number }> = {};
  for (const row of rows.rows) {
    const counts = (byLang[row.lang] ??= { dev: 0, test: 0 });
    counts[row.split] += 1;
  }
  const assignments = await db.execute<{ rater_id: string; article_id: string; position: number }>(
    sql`
    SELECT a.rater_id::text AS rater_id, a.article_id::text AS article_id, a.position
      FROM eval.assignments a
      JOIN eval.sample s ON s.article_id = a.article_id AND s.dataset_version = ${version}
     ORDER BY a.rater_id, a.article_id`,
  );
  const cards = await db.execute<{ rater_id: string; card_id: string; strength: string }>(sql`
    SELECT rater_id::text AS rater_id, card_id::text AS card_id, strength
      FROM eval.rater_cards ORDER BY rater_id, card_id`);
  return {
    version,
    articles: rows.rows.length,
    byLang,
    snapshotSha: canonicalSha256(rows.rows.map((r) => [r.article_id, r.snapshot_sha])),
    splitSha: canonicalSha256(rows.rows.map((r) => [r.article_id, r.split, r.group_id])),
    assignmentsSha: canonicalSha256(
      assignments.rows.map((r) => [r.rater_id, r.article_id, r.position]),
    ),
    assignments: assignments.rows.length,
    raterCardsSha: canonicalSha256(cards.rows.map((r) => [r.rater_id, r.card_id, r.strength])),
    raterCards: cards.rows.length,
  };
}

/**
 * Freeze a version before its first model run (spec 10 §2.1): record the manifest once, capture the
 * version's ground truth (`eval.dataset_truth`, D-110 addendum) in the same transaction and close
 * the version to new rows. Idempotent: an already frozen version is returned unchanged (a legacy one
 * without captured truth gets it now). Callers hold the dataset-additions lock so no rating write
 * interleaves.
 */
export async function freezeDataset(tx: Transaction, version: string): Promise<DatasetRow> {
  const locked = await lockDataset(tx, version);
  if (locked === null) throw new Error(`dataset version ${version} does not exist`);
  if (locked.frozenAt !== null) {
    // A version frozen before ground-truth capture existed gets its snapshot now, once.
    await captureDatasetTruth(tx, version);
    return locked;
  }
  const manifest = await computeDatasetManifest(tx, version);
  const result = await tx.execute<DatasetDbRow>(sql`
    UPDATE eval.datasets
       SET frozen_at = now(), manifest = ${JSON.stringify(manifest)}::jsonb,
           snapshot_sha = ${manifest.snapshotSha}, split_sha = ${manifest.splitSha}
     WHERE version = ${version}
    RETURNING ${DATASET_COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('dataset freeze returned no row');
  await captureDatasetTruth(tx, version);
  return toDataset(row);
}

/** One carrier feed of an article, for the snapshot (shared metadata only). */
export interface CarrierFeed {
  feedId: string;
  title: string | null;
  firstSeenAt: Date;
}

/** The carrier feeds of each article, oldest association first (then feed id). */
export async function loadCarrierFeeds(
  db: Executor,
  articleIds: readonly string[],
): Promise<Map<string, CarrierFeed[]>> {
  const map = new Map<string, CarrierFeed[]>();
  if (articleIds.length === 0) return map;
  const result = await db.execute<{
    article_id: string;
    feed_id: string;
    title: string | null;
    first_seen_at: RawTimestamp;
  }>(sql`
    SELECT fi.article_id::text AS article_id, fi.feed_id::text AS feed_id, f.title, fi.first_seen_at
      FROM feed_items fi JOIN feeds f ON f.id = fi.feed_id
     WHERE fi.article_id = ANY(${sql.param([...articleIds])}::bigint[])
     ORDER BY fi.article_id, fi.first_seen_at, fi.feed_id`);
  for (const row of result.rows) {
    const list = map.get(row.article_id) ?? [];
    list.push({ feedId: row.feed_id, title: row.title, firstSeenAt: toDate(row.first_seen_at) });
    map.set(row.article_id, list);
  }
  return map;
}

/** The `articles.url` of each article (the rating page's "open original" link). */
export async function loadArticleUrls(
  db: Executor,
  articleIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (articleIds.length === 0) return new Map();
  const result = await db.execute<{ id: string; url: string | null }>(sql`
    SELECT id::text AS id, url FROM articles
     WHERE id = ANY(${sql.param([...articleIds])}::bigint[])`);
  return new Map(result.rows.map((row) => [row.id, row.url]));
}
