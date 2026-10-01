import {
  copySampleRows,
  createDataset,
  headDataset,
  insertSampleRows,
  loadArticleUrls,
  loadCarrierFeeds,
  loadClassificationArticles,
  loadSample,
  lockDataset,
  lockDatasetAdditions,
  nextDatasetVersion,
  type Database,
  type DatasetSplit,
  type SampleRowInput,
  type Transaction,
} from '@bantoozi/db';

import { buildSnapshot, snapshotSha, type EvalSnapshot } from './snapshot.js';
import { assignSplits } from './split.js';

/**
 * Adding articles to the golden dataset (spec 10 §2.1, §2.2): the sample itself and the rating app's
 * top-ups. Additions join the head version while it is open; once its first model run froze it, they
 * create the next version (`golden-v2`, …), which copies every row of the frozen one unchanged.
 * Every added article receives its frozen snapshot and story-group split before anyone is assigned
 * it. One advisory lock serializes additions, so two top-ups never race for the next version.
 */

export interface AddArticlesResult {
  version: string;
  /** The frozen version this call branched from, when it created `version`. */
  createdFrom: string | null;
  added: string[];
  /** Articles that are gone, or have no detected language, and were not added. */
  skipped: string[];
}

/** Snapshot rows for `articleIds` with their splits, given the version's known groups. */
export async function buildSampleRows(
  tx: Transaction,
  version: string,
  seed: string,
  articleIds: readonly string[],
): Promise<{ rows: SampleRowInput[]; skipped: string[] }> {
  const articles = await loadClassificationArticles(tx, articleIds);
  const carriers = await loadCarrierFeeds(tx, articleIds);
  const urls = await loadArticleUrls(tx, articleIds);
  const snapshots: EvalSnapshot[] = [];
  const skipped: string[] = [];
  for (const id of articleIds) {
    const article = articles.get(id);
    if (article === undefined || article.lang === null || article.lang === 'und') {
      skipped.push(id);
      continue;
    }
    snapshots.push(buildSnapshot(article, carriers.get(id) ?? [], urls.get(id) ?? null));
  }
  const existing = await loadSample(tx, version);
  const known = new Map<string, DatasetSplit>();
  const groupLang = new Map<string, string>();
  for (const row of existing) {
    const group = row.snapshot['storyGroupId'];
    if (typeof group !== 'string') continue;
    known.set(group, row.split);
    if (!groupLang.has(group)) groupLang.set(group, row.lang);
  }
  // Article counts per side, each article counted under its story group's language.
  const knownCounts = new Map<string, { dev: number; test: number }>();
  for (const row of existing) {
    const group = row.snapshot['storyGroupId'];
    const lang = typeof group === 'string' ? (groupLang.get(group) ?? row.lang) : row.lang;
    const counts = knownCounts.get(lang) ?? { dev: 0, test: 0 };
    counts[row.split] += 1;
    knownCounts.set(lang, counts);
  }
  const splits = assignSplits(
    snapshots.map((s) => ({ articleId: s.articleId, lang: s.lang, storyGroupId: s.storyGroupId })),
    seed,
    known,
    knownCounts,
    groupLang,
  );
  const rows = snapshots.map((snapshot) => ({
    articleId: snapshot.articleId,
    lang: snapshot.lang,
    snapshot: snapshot as unknown as Record<string, unknown>,
    snapshotSha: snapshotSha(snapshot),
    split: splits.get(snapshot.articleId) ?? 'dev',
  }));
  return { rows, skipped };
}

/** Add articles to the head version (or to the next one when the head is frozen). */
export async function addArticlesToDataset(
  db: Database,
  articleIds: readonly string[],
): Promise<AddArticlesResult> {
  return db.transaction(async (tx) => {
    await lockDatasetAdditions(tx);
    const head = await headDataset(tx);
    if (head === null) throw new Error('no golden dataset yet: run `eval sample` first');
    let version = head.version;
    let createdFrom: string | null = null;
    const locked = await lockDataset(tx, head.version);
    if (locked !== null && locked.frozenAt !== null) {
      version = nextDatasetVersion(head.version);
      await createDataset(tx, {
        version,
        parentVersion: head.version,
        seed: head.seed,
        params: { ...head.params, topUpOf: head.version },
      });
      await copySampleRows(tx, head.version, version);
      createdFrom = head.version;
    }
    const present = new Set(
      (await loadSample(tx, version, { articleIds })).map((r) => r.articleId),
    );
    const missing = [...new Set(articleIds)].filter((id) => !present.has(id));
    const { rows, skipped } = await buildSampleRows(tx, version, head.seed, missing);
    await insertSampleRows(tx, version, rows);
    return { version, createdFrom, added: rows.map((r) => r.articleId), skipped };
  });
}
