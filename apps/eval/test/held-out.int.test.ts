import { dropCreatedTestDatabases } from '@bantoozi/testing';
import {
  createDataset,
  freezeDataset,
  insertSampleRows,
  loadSample,
  setRaterFeeds,
} from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addArticlesToDataset, buildSampleRows } from '../src/dataset/topup.js';
import { ensureAssignments } from '../src/rating-server/assignments.js';
import {
  addArticles,
  addGoldenFeeds,
  addRater,
  createGoldenDataset,
  setupRatingDb,
  type GoldenFeedFixture,
  type RatingDb,
} from './rating-server-support.js';

/**
 * D-145: a held-out version (`params.excludeVersions`) never gains an article or a story group an
 * excluded version sampled, whichever path adds rows: rating top-ups, added articles, or a direct
 * insert.
 */

const DAY = 86_400_000;
const now = new Date();

let rdb: RatingDb;
let feeds: GoldenFeedFixture[];
let v1Ids: string[];
let copyId: string;
let fresh: string[];

beforeAll(async () => {
  rdb = await setupRatingDb('eval-held-out');
  feeds = await addGoldenFeeds(rdb, 'en', 2);
  // golden-v1 (frozen) sampled ten articles of feed 1, newer than everything else in the top-up
  // window, so an unfiltered newest-first pool would hold only excluded articles.
  const newest = new Date(now.getTime() - 3_600_000);
  const older = new Date(now.getTime() - DAY);
  v1Ids = await addArticles(rdb, feeds[0]!.id, 'en', 10, newest, (i) => `v1 story ${i}`);
  await createGoldenDataset(rdb, v1Ids);
  await rdb.db.transaction((tx) => freezeDataset(tx, 'golden-v1'));
  // Feed 2 republishes one of them under a new id (same story group), and has older fresh stories.
  copyId = (await addArticles(rdb, feeds[1]!.id, 'en', 1, newest, () => 'v1 story 3'))[0]!;
  fresh = await addArticles(rdb, feeds[1]!.id, 'en', 12, older, (i) => `fresh story ${i}`);
  // The held-out successor, now the head, starts with two fresh rows.
  await createDataset(rdb.db, {
    version: 'golden-v2',
    seed: 'seed-2',
    params: { excludeVersions: ['golden-v1'] },
  });
  await addArticlesToDataset(rdb.db, fresh.slice(0, 2));
});

async function raterOnBothFeeds() {
  const { rater } = await addRater(rdb, { langs: ['en'], now });
  await rdb.db.transaction((tx) =>
    setRaterFeeds(
      tx,
      rater.id,
      feeds.map((f) => f.id),
    ),
  );
  return rater;
}

afterAll(async () => {
  await rdb?.close();
  await dropCreatedTestDatabases();
});

describe('held-out versions (D-145)', () => {
  it('filters the top-up pool before its limit, so newer excluded articles take no slots', async () => {
    const rater = await raterOnBothFeeds();
    // Target 5: the sample holds 2; the 5 newest recent articles are all excluded ones.
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: ['en'],
      now,
      target: 5,
    });
    expect(result).toMatchObject({ added: 5, total: 5, datasetVersion: 'golden-v2' });
    expect(result.toppedUp).toHaveLength(3);
    for (const id of result.toppedUp) expect(fresh).toContain(id);
  });

  it('tops a rater up without the excluded articles or story groups', async () => {
    const rater = await raterOnBothFeeds();
    const result = await ensureAssignments(rdb.db, { raterId: rater.id, langs: ['en'], now });
    expect(result.datasetVersion).toBe('golden-v2');
    // Every fresh story ends up in the sample; nothing of golden-v1 or its story groups does.
    const rows = await loadSample(rdb.db, 'golden-v2');
    const ids = new Set(rows.map((r) => r.articleId));
    expect(fresh.every((id) => ids.has(id))).toBe(true);
    for (const id of [...v1Ids, copyId]) expect(ids.has(id)).toBe(false);
    expect(result.total).toBe(fresh.length);
  });

  it('skips excluded articles added to the version, and refuses a direct insert', async () => {
    const added = await addArticlesToDataset(rdb.db, [v1Ids[0]!, copyId]);
    expect(added.added).toEqual([]);
    expect([...added.skipped].sort()).toEqual([v1Ids[0]!, copyId].sort());

    const rows = await rdb.db.transaction(
      async (tx) => (await buildSampleRows(tx, 'golden-v2', 'seed-2', [copyId])).rows,
    );
    expect(rows).toHaveLength(1);
    await expect(
      rdb.db.transaction((tx) => insertSampleRows(tx, 'golden-v2', rows)),
    ).rejects.toThrow(`golden-v2 excludes article ${copyId}`);
  });
});
