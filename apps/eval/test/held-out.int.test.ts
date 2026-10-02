import { dropCreatedTestDatabases } from '@bantoozi/testing';
import {
  ClosedRoundError,
  createDataset,
  freezeDataset,
  headDataset,
  listDatasets,
  rateAssignment,
  sampleFootprint,
  insertSampleRows,
  loadSample,
  setRaterFeeds,
} from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addArticlesToDataset, buildSampleRows } from '../src/dataset/topup.js';
import { EarlierRoundError, ensureAssignments } from '../src/rating-server/assignments.js';
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

  it('refuses a rater of an earlier round instead of leaving them without articles', async () => {
    const rater = await raterOnBothFeeds();
    // An assignment of a golden-v1 article: this context rated the earlier round.
    await rdb.owner.query(
      'INSERT INTO eval.assignments (rater_id, article_id, position) VALUES ($1, $2, 0)',
      [rater.id, v1Ids[0]],
    );
    await expect(
      ensureAssignments(rdb.db, { raterId: rater.id, langs: ['en'], now }),
    ).rejects.toBeInstanceOf(EarlierRoundError);

    // A rating of that earlier-round article would reopen golden-v1 and take the head off the
    // held-out version: refused, and nothing is created.
    const before = (await listDatasets(rdb.db)).map((d) => d.version);
    await expect(
      rdb.db.transaction((tx) =>
        rateAssignment(tx, { raterId: rater.id, position: 0, rating: 1, reason: null, now }),
      ),
    ).rejects.toBeInstanceOf(ClosedRoundError);
    expect((await listDatasets(rdb.db)).map((d) => d.version)).toEqual(before);
    expect((await headDataset(rdb.db))?.version).toBe('golden-v2');
  });

  it('never makes a closed round the head, even when it is the newest tip', async () => {
    // A child of golden-v1 created after the held-out version (as a correction would have).
    await createDataset(rdb.db, {
      version: 'golden-v1-late',
      parentVersion: 'golden-v1',
      seed: 'seed-1',
      params: {},
    });
    expect((await headDataset(rdb.db))?.version).toBe('golden-v2');
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

  it("excludes the whole round: articles of an excluded version's descendants too", async () => {
    // A frozen round with a top-up child whose extra article is not in the parent (last test:
    // the open child becomes the head).
    const [r1] = await addArticles(
      rdb,
      feeds[0]!.id,
      'en',
      1,
      new Date(now.getTime() - DAY),
      () => 'round parent',
    );
    const [r2] = await addArticles(
      rdb,
      feeds[0]!.id,
      'en',
      1,
      new Date(now.getTime() - DAY),
      () => 'round child only',
    );
    const fp = async (versions: string[]) => (await sampleFootprint(rdb.db, versions)).articleIds;
    await createDataset(rdb.db, { version: 'round-a', seed: 'ra', params: {} });
    await rdb.db.transaction(async (tx) => {
      await insertSampleRows(
        tx,
        'round-a',
        (await buildSampleRows(tx, 'round-a', 'ra', [r1!])).rows,
      );
      await freezeDataset(tx, 'round-a');
    });
    await createDataset(rdb.db, {
      version: 'round-a-v2',
      parentVersion: 'round-a',
      seed: 'ra',
      params: {},
    });
    await rdb.db.transaction(async (tx) =>
      insertSampleRows(
        tx,
        'round-a-v2',
        (await buildSampleRows(tx, 'round-a-v2', 'ra', [r2!])).rows,
      ),
    );
    expect([...(await fp(['round-a']))].sort()).toEqual([r1!, r2!].sort());
  });
});
