import { dropCreatedTestDatabases } from '@bantoozi/testing';
import {
  addRaterCard,
  freezeDataset,
  getDataset,
  headDataset,
  listAssignments,
  listDatasets,
  loadSample,
  lockDatasetAdditions,
  lockTopUpArticles,
  openDatasetForCorrection,
  removeRaterCard,
  sampleCandidates,
  saveFacetLabels,
  setRaterFeeds,
} from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureAssignments, NotReadyError } from '../src/rating-server/assignments.js';
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
 * M3a-T3 (spec 10 §2.2): assignment building against the database: 300 per rater split equally
 * across languages from the sample of the rater's feeds, top-ups from recent non-sampled articles
 * that join the open dataset version, a top-up after the freeze that creates the next version and
 * leaves the frozen one unchanged, idempotence and the deterministic order.
 */

const DAY = 86_400_000;
const now = new Date();

let rdb: RatingDb;
let en: GoldenFeedFixture[];
let sk: GoldenFeedFixture[];
const sampled: string[] = [];

beforeAll(async () => {
  rdb = await setupRatingDb('eval-assign');
  en = await addGoldenFeeds(rdb, 'en', 6);
  sk = await addGoldenFeeds(rdb, 'sk', 6);
  // 20 sampled articles per feed (120 per language) and 10 recent non-sampled ones per feed.
  for (const feed of [...en, ...sk]) {
    sampled.push(
      ...(await addArticles(rdb, feed.id, feed.lang, 20, new Date(now.getTime() - 2 * DAY))),
    );
    await addArticles(
      rdb,
      feed.id,
      feed.lang,
      10,
      new Date(now.getTime() - DAY),
      (i) => `recent ${feed.id}-${i}`,
    );
  }
  // One old article that is too old for a top-up.
  await addArticles(rdb, en[0]!.id, 'en', 1, new Date(now.getTime() - 90 * DAY), () => 'ancient');
  const created = await createGoldenDataset(rdb, sampled);
  expect(created.added).toHaveLength(240);
});

afterAll(async () => {
  await rdb?.close();
  await dropCreatedTestDatabases();
});

async function pick(raterId: string, feeds: GoldenFeedFixture[]) {
  await rdb.db.transaction((tx) =>
    setRaterFeeds(
      tx,
      raterId,
      feeds.map((f) => f.id),
    ),
  );
}

describe('ensureAssignments', () => {
  it('assigns 300 split equally across languages, topping up from recent articles into the open version', async () => {
    const { rater } = await addRater(rdb, { langs: ['sk', 'en'], now });
    await pick(rater.id, [...en, ...sk]);
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
    });
    expect(result).toMatchObject({
      added: 300,
      total: 300,
      datasetVersion: 'golden-v1',
      createdFrom: null,
    });
    expect(result.toppedUp).toHaveLength(60);
    const assigned = await listAssignments(rdb.db, rater.id, 'golden-v1');
    expect(assigned.map((a) => a.position)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(assigned.filter((a) => a.lang === 'sk')).toHaveLength(150);
    expect(assigned.filter((a) => a.lang === 'en')).toHaveLength(150);
    expect(assigned.every((a) => a.status === 'pending')).toBe(true);
    // Every top-up received its frozen snapshot and split before it was assigned.
    const rows = await loadSample(rdb.db, 'golden-v1', { articleIds: result.toppedUp });
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.split === 'dev' || r.split === 'test')).toBe(true);
    expect(rows.every((r) => typeof r.snapshot['storyGroupId'] === 'string')).toBe(true);

    // Idempotent: nothing more to add once the target is reached.
    const again = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
    });
    expect(again.added).toBe(0);
    expect(await listAssignments(rdb.db, rater.id, 'golden-v1')).toEqual(assigned);
  });

  it('assigns only articles of the picked feeds and languages, in a deterministic order', async () => {
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, en.slice(0, 2));
    await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 30,
    });
    const first = await listAssignments(rdb.db, rater.id, 'golden-v1');
    expect(first).toHaveLength(30);
    const sample = await loadSample(rdb.db, 'golden-v1', {
      articleIds: first.map((a) => a.articleId),
    });
    const picked = new Set(en.slice(0, 2).map((f) => f.id));
    for (const row of sample) {
      expect(row.lang).toBe('en');
      const carriers = row.snapshot['carrierFeeds'] as Array<{ feedId: string }>;
      expect(carriers.some((c) => picked.has(c.feedId))).toBe(true);
    }
    // Rebuilding from the same inputs gives the same queue (seeded by the rater id).
    await rdb.owner.query('DELETE FROM eval.assignments WHERE rater_id = $1', [rater.id]);
    await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 30,
    });
    const second = await listAssignments(rdb.db, rater.id, 'golden-v1');
    expect(second.map((a) => a.articleId)).toEqual(first.map((a) => a.articleId));
  });

  it('a top-up after the first model run creates a new dataset version and leaves the frozen one unchanged', async () => {
    const frozen = await rdb.db.transaction((tx) => freezeDataset(tx, 'golden-v1'));
    const frozenRows = await loadSample(rdb.db, 'golden-v1');
    expect(frozenRows).toHaveLength(300);

    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, en);
    // The sample holds 150 English articles of these feeds; 30 recent ones remain outside it.
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 170,
    });
    expect(result).toMatchObject({
      added: 170,
      datasetVersion: 'golden-v2',
      createdFrom: 'golden-v1',
    });
    expect(result.toppedUp).toHaveLength(20);

    const after = await getDataset(rdb.db, 'golden-v1');
    expect(after?.frozenAt?.getTime()).toBe(frozen.frozenAt?.getTime());
    expect(after?.manifest).toEqual(frozen.manifest);
    expect(after?.snapshotSha).toBe(frozen.snapshotSha);
    expect(await loadSample(rdb.db, 'golden-v1')).toEqual(frozenRows);

    const v2 = await loadSample(rdb.db, 'golden-v2');
    expect(v2).toHaveLength(320);
    const v2ById = new Map(v2.map((r) => [r.articleId, r]));
    for (const row of frozenRows) {
      expect(v2ById.get(row.articleId)).toMatchObject({
        snapshotSha: row.snapshotSha,
        split: row.split,
      });
    }
    for (const id of result.toppedUp) expect(v2ById.has(id)).toBe(true);
    const assigned = await listAssignments(rdb.db, rater.id, 'golden-v2');
    expect(assigned.every((a) => v2ById.has(a.articleId))).toBe(true);
  });

  it('assigns everything available when the pools run dry (fewer than the target)', async () => {
    const { rater } = await addRater(rdb, { langs: ['sk'], now });
    await pick(rater.id, sk.slice(0, 1));
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
    });
    // 20 sampled + 10 recent articles, all of which are in the sample by now.
    expect(result.total).toBe(30);
  });

  it('tops up every language equally when one language has many newer articles', async () => {
    // New golden feeds with no sampled articles: English is much newer than Slovak.
    const newEn = await addGoldenFeeds(rdb, 'en', 3);
    const oldSk = await addGoldenFeeds(rdb, 'sk', 3);
    for (const feed of newEn) {
      await addArticles(
        rdb,
        feed.id,
        'en',
        20,
        new Date(now.getTime() - 3_600_000),
        (i) => `fresh ${feed.id}-${i}`,
      );
    }
    for (const feed of oldSk) {
      await addArticles(
        rdb,
        feed.id,
        'sk',
        20,
        new Date(now.getTime() - 5 * DAY),
        (i) => `older ${feed.id}-${i}`,
      );
    }
    const { rater } = await addRater(rdb, { langs: ['en', 'sk'], now });
    await pick(rater.id, [...newEn, ...oldSk]);
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 40,
    });
    expect(result.added).toBe(40);
    expect(result.toppedUp).toHaveLength(40);
    const assigned = await listAssignments(rdb.db, rater.id, result.datasetVersion);
    expect(assigned.filter((a) => a.lang === 'en')).toHaveLength(20);
    expect(assigned.filter((a) => a.lang === 'sk')).toHaveLength(20);
  });

  it('rechecks card and feed readiness under the rater lock', async () => {
    const { rater } = await addRater(rdb, { langs: ['en', 'sk'], now });
    await pick(rater.id, [...en, ...sk]);
    const cardIds: string[] = [];
    await rdb.db.transaction(async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        const card = await addRaterCard(tx, rater.id, {
          title: null,
          interest: `Readiness interest number ${i} about science`,
          notFor: null,
          strength: 'like',
          examplesYes: [],
          examplesNo: [],
          lang: 'en',
        });
        cardIds.push(card.cardId);
      }
    });
    // Hold the rater lock (as a concurrent card deletion would) and delete a card under it while
    // ensureAssignments waits for the lock.
    const client = await rdb.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM eval.raters WHERE id = $1 FOR UPDATE', [rater.id]);
      const pending = ensureAssignments(rdb.db, {
        raterId: rater.id,
        langs: rater.langs,
        now,
        target: 10,
        requireReady: true,
      });
      const settled = pending.then(
        () => 'ok',
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('DELETE FROM eval.rater_cards WHERE rater_id = $1 AND card_id = $2', [
        rater.id,
        cardIds[0],
      ]);
      await client.query('COMMIT');
      expect(await settled).toBeInstanceOf(NotReadyError);
    } finally {
      client.release();
    }
    expect(await listAssignments(rdb.db, rater.id, null)).toEqual([]);
    // Not ready from the start: refused before any top-up is added.
    await expect(
      ensureAssignments(rdb.db, {
        raterId: rater.id,
        langs: rater.langs,
        now,
        target: 10,
        requireReady: true,
      }),
    ).rejects.toBeInstanceOf(NotReadyError);
  });

  it('chooses top-ups from the feeds read under the rater lock, so a dropped feed adds nothing', async () => {
    // Two golden feeds with only recent, non-sampled articles: every assignment is a top-up.
    const [keep, drop] = await addGoldenFeeds(rdb, 'en', 2);
    const keptIds = await addArticles(
      rdb,
      keep!.id,
      'en',
      8,
      new Date(now.getTime() - DAY),
      (i) => `kept ${i}`,
    );
    const droppedIds = await addArticles(
      rdb,
      drop!.id,
      'en',
      8,
      new Date(now.getTime() - DAY),
      (i) => `dropped ${i}`,
    );
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, [keep!, drop!]);
    // Hold the rater lock (as a concurrent feed change would) and drop a feed under it while
    // ensureAssignments waits for the lock.
    const client = await rdb.owner.connect();
    let pending: ReturnType<typeof ensureAssignments> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM eval.raters WHERE id = $1 FOR UPDATE', [rater.id]);
      pending = ensureAssignments(rdb.db, {
        raterId: rater.id,
        langs: rater.langs,
        now,
        target: 10,
      });
      pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query('DELETE FROM eval.rater_feeds WHERE rater_id = $1 AND feed_id = $2', [
        rater.id,
        drop!.id,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const result = await pending;
    expect(result.added).toBe(8);
    expect([...result.toppedUp].sort()).toEqual([...keptIds].sort());
    const inSample = await rdb.owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM eval.sample WHERE article_id = ANY($1::bigint[])',
      [droppedIds],
    );
    expect(inSample.rows[0]!.n).toBe('0');
    const assigned = await listAssignments(rdb.db, rater.id, result.datasetVersion);
    expect(assigned.map((a) => a.articleId).sort()).toEqual([...keptIds].sort());
  });

  it('share-locks the top-up articles until their snapshots are written', async () => {
    const [feed] = await addGoldenFeeds(rdb, 'en', 1);
    const ids = await addArticles(
      rdb,
      feed!.id,
      'en',
      3,
      new Date(now.getTime() - DAY),
      (i) => `locked top-up ${i}`,
    );
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, [feed!]);
    // Share-lock the dataset rows, so ensureAssignments stops after locking its top-up articles,
    // where addTopUps locks the head version's row for update (the additions lock is taken first
    // and would stop it before the articles are locked).
    const holder = await rdb.owner.connect();
    const worker = await rdb.owner.connect();
    let pending: ReturnType<typeof ensureAssignments> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM eval.datasets FOR SHARE');
      pending = ensureAssignments(rdb.db, {
        raterId: rater.id,
        langs: rater.langs,
        now,
        target: 3,
      });
      pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The ingest worker cannot turn a selected article stale before its snapshot is written.
      await worker.query('BEGIN');
      await worker.query(`SET LOCAL lock_timeout = '200ms'`);
      await expect(
        worker.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [ids[0]]),
      ).rejects.toMatchObject({ code: '55P03' });
      await worker.query('ROLLBACK');
      await holder.query('COMMIT');
    } finally {
      holder.release();
      worker.release();
    }
    const result = await pending;
    expect([...result.toppedUp].sort()).toEqual([...ids].sort());
    expect(result.added).toBe(3);
  });

  it('assigns nothing from top-up picks that are all rejected when they are locked', async () => {
    const [feed] = await addGoldenFeeds(rdb, 'en', 1);
    const ids = await addArticles(
      rdb,
      feed!.id,
      'en',
      3,
      new Date(now.getTime() - DAY),
      (i) => `rejected top-up ${i}`,
    );
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, [feed!]);
    // The ingest worker turns every candidate stale after the eligibility query has seen them, so
    // the share lock waits for its commit and then rejects all of them.
    const worker = await rdb.owner.connect();
    let pending: ReturnType<typeof ensureAssignments> | undefined;
    try {
      await worker.query('BEGIN');
      await worker.query(
        `UPDATE articles SET pipeline_state = 'stale' WHERE id = ANY($1::bigint[])`,
        [ids],
      );
      pending = ensureAssignments(rdb.db, {
        raterId: rater.id,
        langs: rater.langs,
        now,
        target: 3,
      });
      pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await worker.query('COMMIT');
    } finally {
      worker.release();
    }
    const result = await pending;
    expect(result).toMatchObject({ added: 0, total: 0, toppedUp: [] });
    expect(await listAssignments(rdb.db, rater.id, result.datasetVersion)).toEqual([]);
  });

  it('drops a planned top-up article that no longer qualifies when it is locked', async () => {
    const [feed] = await addGoldenFeeds(rdb, 'en', 1);
    const [stale, moved, fine, pending] = await addArticles(
      rdb,
      feed!.id,
      'en',
      4,
      new Date(now.getTime() - DAY),
      (i) => `revalidated top-up ${i}`,
    );
    await rdb.owner.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [stale]);
    await rdb.owner.query(`UPDATE articles SET lang = 'sk' WHERE id = $1`, [moved]);
    // A content update sent this one back to extraction: its body and metadata are not current.
    await rdb.owner.query(`UPDATE articles SET pipeline_state = 'ingested' WHERE id = $1`, [
      pending,
    ]);
    const kept = await rdb.db.transaction((tx) =>
      lockTopUpArticles(tx, [
        { articleId: stale!, lang: 'en' },
        { articleId: moved!, lang: 'en' },
        { articleId: fine!, lang: 'en' },
        { articleId: pending!, lang: 'en' },
      ]),
    );
    expect(kept).toEqual([fine]);
  });

  it('opens the next version before assigning from a frozen head, even without top-ups', async () => {
    const head = (await headDataset(rdb.db))!;
    const frozen = await rdb.db.transaction((tx) => freezeDataset(tx, head.version));
    const frozenRows = await loadSample(rdb.db, head.version);
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    await pick(rater.id, en.slice(0, 2));
    // 40 sampled English articles of these feeds: no top-up is needed for 10.
    const result = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 10,
    });
    expect(result).toMatchObject({ added: 10, toppedUp: [], createdFrom: head.version });
    expect(result.datasetVersion).not.toBe(head.version);
    const next = (await getDataset(rdb.db, result.datasetVersion))!;
    expect(next).toMatchObject({ parentVersion: head.version, frozenAt: null });
    expect(next.params).toMatchObject({ assignmentsAfter: head.version });
    const after = (await getDataset(rdb.db, head.version))!;
    expect(after.manifest).toEqual(frozen.manifest);
    expect(await loadSample(rdb.db, head.version)).toEqual(frozenRows);
    // Nothing to add: no version is created, even after the next freeze.
    await rdb.db.transaction((tx) => freezeDataset(tx, next.version));
    const versions = (await listDatasets(rdb.db)).length;
    const again = await ensureAssignments(rdb.db, {
      raterId: rater.id,
      langs: rater.langs,
      now,
      target: 10,
    });
    expect(again.added).toBe(0);
    expect((await listDatasets(rdb.db)).length).toBe(versions);
  });

  it('opens the next version before a card change under a frozen head', async () => {
    const head = (await headDataset(rdb.db))!;
    if (head.frozenAt === null) await rdb.db.transaction((tx) => freezeDataset(tx, head.version));
    const { rater } = await addRater(rdb, { langs: ['en'], now });
    const card = await rdb.db.transaction((tx) =>
      addRaterCard(tx, rater.id, {
        title: null,
        interest: 'Rail infrastructure investment and timetables',
        notFor: null,
        strength: 'like',
        lang: 'en',
        examplesYes: [],
        examplesNo: [],
      }),
    );
    const added = (await headDataset(rdb.db))!;
    expect(added).toMatchObject({ parentVersion: head.version, frozenAt: null });
    expect(added.params).toMatchObject({ cardsChangedAfter: head.version });
    // An open head takes the removal without another version; a frozen one branches again.
    await rdb.db.transaction((tx) => freezeDataset(tx, added.version));
    expect(await rdb.db.transaction((tx) => removeRaterCard(tx, rater.id, card.cardId))).toBe(true);
    const removed = (await headDataset(rdb.db))!;
    expect(removed).toMatchObject({ parentVersion: added.version, frozenAt: null });
    // Removing a card the rater does not hold changes nothing.
    const versions = (await listDatasets(rdb.db)).length;
    expect(await rdb.db.transaction((tx) => removeRaterCard(tx, rater.id, card.cardId))).toBe(
      false,
    );
    expect((await listDatasets(rdb.db)).length).toBe(versions);
  });

  it('opens the next version before a facet label change under a frozen head', async () => {
    const head = (await headDataset(rdb.db))!;
    if (head.frozenAt === null) await rdb.db.transaction((tx) => freezeDataset(tx, head.version));
    const articleId = sampled[0]!;
    const save = (value: string) =>
      rdb.db.transaction((tx) =>
        saveFacetLabels(tx, {
          labeler: 'owner',
          articleId,
          values: { 'facet.test': value },
          now,
        }),
      );
    await save('yes');
    const changed = (await headDataset(rdb.db))!;
    expect(changed).toMatchObject({ parentVersion: head.version, frozenAt: null });
    expect(changed.params).toMatchObject({ facetsChangedAfter: head.version });
    await rdb.db.transaction((tx) => freezeDataset(tx, changed.version));
    // Saving the same values again changes nothing and creates no version.
    const versions = (await listDatasets(rdb.db)).length;
    await save('yes');
    expect((await listDatasets(rdb.db)).length).toBe(versions);
    await save('no');
    expect((await listDatasets(rdb.db)).length).toBe(versions + 1);
  });

  it('takes the additions lock before the dataset row, so a mutation racing a freeze waits', async () => {
    const articleId = sampled[1]!;
    await rdb.db.transaction((tx) =>
      saveFacetLabels(tx, { labeler: 'owner', articleId, values: { 'facet.lock': 'a' }, now }),
    );
    const head = (await headDataset(rdb.db))!;
    expect(head.frozenAt).toBeNull();
    // A run's freeze holds the additions lock and then takes the row FOR UPDATE. A mutation that
    // shares the row first and then needs the additions lock (a correction followed by a top-up)
    // would close a lock cycle with it.
    const client = await rdb.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('eval.dataset.additions'))`);
      const mutation = rdb.db.transaction(async (tx) => {
        await openDatasetForCorrection(tx, 'assignments');
        await lockDatasetAdditions(tx);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query(`SET LOCAL lock_timeout = '3s'`);
      await client.query(`SELECT 1 FROM eval.datasets WHERE version = $1 FOR UPDATE`, [
        head.version,
      ]);
      await client.query('COMMIT');
      await expect(mutation).resolves.toBeUndefined();
    } finally {
      client.release();
    }
  });

  it('counts a carrier merged into a picked feed after sampling', async () => {
    const version = (await headDataset(rdb.db))!.version;
    const [survivor, source] = [sk[4]!, sk[5]!];
    const { status } = (
      await rdb.owner.query<{ status: string }>('SELECT status FROM feeds WHERE id = $1', [
        source.id,
      ])
    ).rows[0]!;
    const before = await sampleCandidates(rdb.db, {
      version,
      langs: ['sk'],
      feedIds: [survivor.id],
    });
    const both = await sampleCandidates(rdb.db, {
      version,
      langs: ['sk'],
      feedIds: [survivor.id, source.id],
    });
    expect(both.length).toBeGreaterThan(before.length);
    await rdb.owner.query("UPDATE feeds SET merged_into_id = $1, status = 'dead' WHERE id = $2", [
      survivor.id,
      source.id,
    ]);
    try {
      const after = await sampleCandidates(rdb.db, {
        version,
        langs: ['sk'],
        feedIds: [survivor.id],
      });
      // The source feed's sampled articles now count for the survivor.
      expect(after).toEqual(both);
    } finally {
      await rdb.owner.query('UPDATE feeds SET merged_into_id = NULL, status = $2 WHERE id = $1', [
        source.id,
        status,
      ]);
    }
  });
});
