import { applyClusterFold, retryTransaction, workerOutbox } from '@bantoozi/db';
import {
  CLUSTER_MAX_CANDIDATES,
  clusterQuestions,
  dynamicQuestionSet,
  type ClusterState,
} from '@bantoozi/questions';
import type * as Questions from '@bantoozi/questions';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClassifyHarness, HOUR, MINUTE, ago, type AskRecord } from './support/classify.js';

/**
 * M2-T9 `article.cluster` (spec 05 §6) through the real handler: the candidate SQL and the per-feed
 * rule, candidate authorization, merges with `mute_story` remapping, and cluster-set provenance.
 */

/** A second cluster set the worker's code knows, so a test can switch the active set. */
const CLUSTER_V2_VERSION = 'cluster-v2-test';

vi.mock('@bantoozi/questions', async (importOriginal) => {
  const original = await importOriginal<typeof Questions>();
  const v2 = original.dynamicQuestionSet({
    kind: 'cluster',
    version: 'cluster-v2-test',
    questions: original.clusterQuestions(original.CLUSTER_MAX_CANDIDATES),
    note: 'second cluster set of the cluster integration test',
  });
  return {
    ...original,
    questionSetByVersion: (version: string) =>
      version === v2.version ? v2 : original.questionSetByVersion(version),
  };
});

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  h.router.clusterChoice = 'c1';
  await h.clearOutbox();
});

/** A feed with one reader in `mode`. */
async function readerFeed(title: string, mode: 'off' | 'training' | 'active' = 'active') {
  const feedId = await h.feed(title);
  const userId = await h.user();
  await h.subscribe(userId, feedId, mode);
  return { feedId, userId, title };
}

/** An article with current primary facets (enriched at its revision). */
async function classified(feedIds: string[], title: string, firstSeenAt: Date = ago(2 * HOUR)) {
  const id = await h.article({ feedIds, title, firstSeenAt });
  await h.enrichDirect(id);
  return id;
}

const clusterAsk = (articleId: string): AskRecord | undefined =>
  h.router.asksFor(articleId, 'cluster').at(-1);

const stateOf = (ask: AskRecord | undefined): ClusterState => ask?.request.state as ClusterState;

describe('article.cluster candidates (spec 05 §6 steps 1–3)', () => {
  it('keeps at most two candidates per feed and five in all, by similarity', async () => {
    const title = 'Volcanic ash cloud grounds flights across northern Iceland';
    const reader = await readerFeed('Home desk');
    const a = await readerFeed('Feed A');
    const b = await readerFeed('Feed B');
    const c = await readerFeed('Feed C');
    // Similarity: A's candidates 1.0, B's about 0.8, C's about 0.6.
    const aIds: string[] = [];
    for (let i = 0; i < 3; i += 1) aIds.push(await classified([a.feedId], title));
    for (let i = 0; i < 3; i += 1) await classified([b.feedId], `${title}, officials say`);
    for (let i = 0; i < 2; i += 1) {
      await classified(
        [c.feedId],
        'Volcanic ash cloud: flights grounded across Iceland for a second day',
      );
    }
    const x = await classified([reader.feedId], title, ago(HOUR));

    const since = await h.mark();
    await h.dispatch('article.cluster', { articleId: x });

    const ask = clusterAsk(x);
    expect(ask).toMatchObject({
      kind: 'cluster',
      priority: 'bulk',
      articleRevision: '1',
      authorized: true,
    });
    const state = stateOf(ask);
    // Without the per-feed rule the five most similar would be A, A, A, B, B.
    expect(state.candidates.map((candidate) => candidate.feed)).toEqual([
      'Feed A',
      'Feed A',
      'Feed B',
      'Feed B',
      'Feed C',
    ]);
    expect(state.candidates.map((candidate) => candidate.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
    ]);
    expect(state.new.feed).toBe('Home desk');
    expect(Object.keys(ask?.request.questions ?? {}).sort()).toEqual(['is_followup', 'same_story']);
    expect(ask?.request.questionSetId).toBe(h.sets.cluster);

    // `c1` folds: a new story of the article and the most similar candidate (the lowest id of A).
    const placed = await h.articleRow(x);
    const target = await h.articleRow(aIds[0] as string);
    expect(placed.clusterId).not.toBeNull();
    expect(target.clusterId).toBe(placed.clusterId);
    expect(placed.clusterSetId).toBe(h.sets.cluster);
    expect(target.clusterSetId).toBe(h.sets.cluster);
    for (const other of aIds.slice(1)) expect((await h.articleRow(other)).clusterId).toBeNull();
    const story = await h.owner.query<{ size: number; representative: string }>(
      `SELECT size, representative_article_id::text AS representative FROM story_clusters
        WHERE id = $1`,
      [placed.clusterId],
    );
    expect(story.rows).toEqual([{ size: 2, representative: aIds[0] }]);
    // The story's readers are re-ranked in full: the new member may join a read or muted story.
    const ranked = await h.payloads('user.rank', since);
    expect(ranked.sort((p, q) => String(p['userId']).localeCompare(String(q['userId'])))).toEqual(
      [reader.userId, a.userId].sort().map((userId) => ({ userId, reason: 'cluster', full: true })),
    );

    // A duplicate delivery of the placed revision asks nothing.
    await h.dispatch('article.cluster', { articleId: x });
    expect(h.router.asksFor(x, 'cluster')).toHaveLength(1);
  });

  it('never offers an off or unselected training carrier’s article; an authorized one with old-model facets still is', async () => {
    const title = 'Central bank raises interest rates to curb inflation';
    const offReader = await readerFeed('Off feed', 'off');
    const home = await readerFeed('Active home');
    const offOnly = await readerFeed('Off carrier', 'off');
    const trainee = await readerFeed('Unselected training', 'training');
    const selector = await readerFeed('Selected training', 'training');
    const pinned = await readerFeed('Older model pin');
    const window = await readerFeed('Window edges');
    const stale = await readerFeed('Moved revision');
    // Active only since now: an earlier arrival is a hidden backlog, never context.
    const late = { feedId: await h.feed('Activated later'), userId: await h.user() };
    await h.subscribe(late.userId, late.feedId, 'active', new Date());

    const x0 = ago(HOUR);
    await classified([offOnly.feedId], title);
    await classified([trainee.feedId], title);
    const selected = await classified([selector.feedId], title);
    await h.select(selector.userId, selector.feedId, selected);
    // Facets from before a model-pin change: still an authorized, classified candidate.
    const oldModel = await h.article({
      feedIds: [offOnly.feedId],
      title,
      firstSeenAt: ago(3 * HOUR),
    });
    await h.carry(pinned.feedId, oldModel, ago(2 * HOUR));
    await h.enrichDirect(oldModel, { model: 'jev-test-0' });
    // The 72-hours-before to 1-hour-after window around the new article's first sighting.
    await classified([window.feedId], title, new Date(x0.getTime() - 71 * HOUR));
    await classified([window.feedId], title, new Date(x0.getTime() - 73 * HOUR));
    await classified([window.feedId], title, new Date(x0.getTime() + 30 * MINUTE));
    await classified([window.feedId], title, new Date(x0.getTime() + 2 * HOUR));
    // Facets of an older revision do not classify the current one.
    const moved = await classified([stale.feedId], title);
    await h.owner.query('UPDATE articles SET content_revision = 2 WHERE id = $1', [moved]);
    await classified([late.feedId], title);

    // The new article: an off carrier saw it first; the state names the authorized carrier only.
    const x = await h.article({ feedIds: [offReader.feedId], title, firstSeenAt: x0 });
    await h.carry(home.feedId, x, x0);
    await h.enrichDirect(x);
    h.router.clusterChoice = 'none';
    await h.dispatch('article.cluster', { articleId: x });

    const state = stateOf(clusterAsk(x));
    expect(state.new.feed).toBe('Active home');
    expect(state.candidates.map((candidate) => candidate.feed).sort()).toEqual(
      ['Older model pin', 'Selected training', 'Window edges', 'Window edges'].sort(),
    );
    // `none` wins: nothing folds.
    expect((await h.articleRow(x)).clusterId).toBeNull();

    // Without current article demand nothing is asked, even with authorized candidates around.
    const idle = await classified([offReader.feedId], title, ago(30 * MINUTE));
    await h.dispatch('article.cluster', { articleId: idle });
    expect(h.router.asksFor(idle)).toEqual([]);
  });
});

describe('article.cluster membership (spec 05 §6 steps 4–5)', () => {
  it('a merge moves every member to the older story, remaps mute_story rules and ranks the affected users in full', async () => {
    const title = 'Striker scores twice as the capital club wins the derby';
    const f1 = await readerFeed('Sports one');
    const f2 = await readerFeed('Sports two');
    const f3 = await readerFeed('Sports three');
    const t1 = await classified([f1.feedId], title, ago(5 * HOUR));
    const t2 = await classified([f1.feedId], title, ago(4 * HOUR));
    await h.dispatch('article.cluster', { articleId: t2 });
    const older = (await h.articleRow(t1)).clusterId as string;
    expect((await h.articleRow(t2)).clusterId).toBe(older);

    const y = await h.article({
      feedIds: [f2.feedId],
      title: 'Referee report criticised after the weekend fixture',
      firstSeenAt: ago(2 * HOUR),
    });
    const x = await classified([f3.feedId], title, ago(HOUR));
    const [u1, u2, u3, u4] = [await h.user(), await h.user(), await h.user(), await h.user()];
    const mute = (userId: string, clusterId: string, days: number) =>
      h.owner.query(
        `INSERT INTO user_rules (user_id, kind, value, expires_at)
         VALUES ($1, 'mute_story', $2, now() + make_interval(days => $3))`,
        [userId, clusterId, days],
      );
    await mute(u2, older, 1);
    await mute(u3, older, 3);
    await mute(u4, '999999999', 2);
    const revisions = async () =>
      Object.fromEntries(
        (
          await h.owner.query<{ id: string; rank_revision: string }>(
            'SELECT id::text AS id, rank_revision::text AS rank_revision FROM users WHERE id = ANY($1::uuid[])',
            [[u1, u2, u3, u4]],
          )
        ).rows.map((row) => [row.id, Number(row.rank_revision)]),
      );
    const before = await revisions();

    // While the call is in flight, another job folds `y` with `x` into a new story.
    let newer = '';
    h.router.respond = async (ask) => {
      if (ask.kind !== 'cluster' || ask.articleId !== x) return undefined;
      await retryTransaction(h.db, async (tx) => {
        const folded = await applyClusterFold(tx, workerOutbox(tx), {
          articleId: y,
          articleRevision: '1',
          targetArticleId: x,
          targetRevision: '1',
          clusterSetId: h.sets.cluster,
        });
        expect(folded.status).toBe('created');
      });
      newer = (await h.articleRow(x)).clusterId as string;
      await mute(u1, newer, 2);
      await mute(u2, newer, 5);
      return undefined;
    };
    // The first story's pending rank intents would coalesce with identical new ones.
    await h.clearOutbox();
    const since = await h.mark();
    await h.dispatch('article.cluster', { articleId: x });

    expect(BigInt(older) < BigInt(newer)).toBe(true);
    for (const id of [t1, t2, x, y]) {
      expect(await h.articleRow(id)).toMatchObject({
        clusterId: older,
        clusterSetId: h.sets.cluster,
      });
    }
    const stories = await h.owner.query<{
      id: string;
      size: number;
      representative: string | null;
    }>(
      `SELECT id::text AS id, size, representative_article_id::text AS representative
         FROM story_clusters WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[older, newer]],
    );
    expect(stories.rows).toEqual([
      { id: older, size: 4, representative: t1 },
      { id: newer, size: 0, representative: null },
    ]);

    const rules = await h.owner.query<{ user_id: string; value: string; days: number }>(
      `SELECT user_id::text AS user_id, value,
              round(extract(epoch FROM expires_at - now()) / 86400)::int AS days
         FROM user_rules WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, value`,
      [[u1, u2, u3, u4]],
    );
    const byUser = (userId: string) =>
      rules.rows.filter((row) => row.user_id === userId).map((row) => [row.value, row.days]);
    expect(byUser(u1)).toEqual([[older, 2]]);
    // Muted both stories: one survivor rule with the later expiry.
    expect(byUser(u2)).toEqual([[older, 5]]);
    expect(byUser(u3)).toEqual([[older, 3]]);
    expect(byUser(u4)).toEqual([['999999999', 2]]);

    const after = await revisions();
    for (const userId of [u1, u2, u3]) expect(after[userId]).toBe((before[userId] ?? 0) + 1);
    expect(after[u4]).toBe(before[u4]);
    const ranked = await h.payloads('user.rank', since);
    const reasons = (reason: string) =>
      ranked
        .filter((payload) => payload['reason'] === reason)
        .map((payload) => [payload['userId'], payload['full']])
        .sort();
    expect(reasons('cluster_merge')).toEqual([u1, u2, u3].sort().map((id) => [id, true]));
    expect(reasons('cluster')).toEqual(
      [f1.userId, f2.userId, f3.userId].sort().map((id) => [id, true]),
    );
  });

  it('records the cluster set on new memberships; switching the set leaves existing ones in place', async () => {
    const title = 'Wildfire forces evacuation of mountain villages near the coast';
    const reader = await readerFeed('Regional news');
    const p1 = await classified([reader.feedId], title, ago(3 * HOUR));
    const p2 = await classified([reader.feedId], title, ago(2 * HOUR));
    await h.dispatch('article.cluster', { articleId: p2 });
    const story = (await h.articleRow(p1)).clusterId;
    expect(story).not.toBeNull();
    for (const id of [p1, p2]) {
      expect(await h.articleRow(id)).toMatchObject({
        clusterId: story,
        clusterSetId: h.sets.cluster,
      });
    }

    const v2 = dynamicQuestionSet({
      kind: 'cluster',
      version: CLUSTER_V2_VERSION,
      questions: clusterQuestions(CLUSTER_MAX_CANDIDATES),
      note: 'second cluster set of the cluster integration test',
    });
    const inserted = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('cluster', $1, $2, $3::jsonb) RETURNING id::text AS id`,
      [v2.version, v2.sha256, JSON.stringify(v2.definition)],
    );
    const v2Id = inserted.rows[0]?.id as string;
    const active = (await h.setting('question_sets.active')) as Record<string, string>;
    await h.setSetting('question_sets.active', { ...active, cluster: v2Id });
    try {
      const p3 = await classified([reader.feedId], title, ago(HOUR));
      await h.dispatch('article.cluster', { articleId: p3 });
      expect(clusterAsk(p3)?.request).toMatchObject({
        questionSetId: v2Id,
        questionSetSha: v2.sha256,
      });
      expect(await h.articleRow(p3)).toMatchObject({ clusterId: story, clusterSetId: v2Id });
      // Existing memberships keep the set that placed them; nothing is re-clustered.
      for (const id of [p1, p2]) {
        expect(await h.articleRow(id)).toMatchObject({
          clusterId: story,
          clusterSetId: h.sets.cluster,
        });
      }
      const size = await h.owner.query<{ size: number }>(
        'SELECT size FROM story_clusters WHERE id = $1',
        [story],
      );
      expect(size.rows[0]?.size).toBe(3);
    } finally {
      await h.setSetting('question_sets.active', active);
    }
  });

  it('an unavailable engine or a weak decision leaves the article unclustered', async () => {
    const title = 'Harvest festival draws record crowds to the old town square';
    const reader = await readerFeed('Town paper');
    await classified([reader.feedId], title, ago(2 * HOUR));
    const x = await classified([reader.feedId], title, ago(HOUR));
    const since = await h.mark();
    h.router.respond = () => ({ ok: false, reason: 'circuit_open' });
    await h.dispatch('article.cluster', { articleId: x });
    expect(h.router.asksFor(x, 'cluster')).toHaveLength(1);
    expect((await h.articleRow(x)).clusterId).toBeNull();

    // A follow-up (is_followup ≥ 0.5) is a related but different story.
    h.router.respond = undefined;
    h.router.followupP = 0.8;
    await h.dispatch('article.cluster', { articleId: x });
    expect(h.router.asksFor(x, 'cluster')).toHaveLength(2);
    expect((await h.articleRow(x)).clusterId).toBeNull();
    expect(await h.payloads('user.rank', since)).toEqual([]);
  });
});
