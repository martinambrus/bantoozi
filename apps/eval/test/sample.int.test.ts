import {
  computeDatasetManifest,
  freezeDataset,
  getDataset,
  loadSample,
  loadSampleCandidates,
} from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asSnapshot } from '../src/dataset/snapshot.js';
import {
  collected,
  goldenFeed,
  runCli,
  setupEvalTest,
  type EvalTestContext,
} from './sample-fixtures.js';

/**
 * M3a-T2 (spec 10 §2.1): `eval sample` stores up to N per language in `eval.sample` with frozen
 * snapshots, story-grouped development/test splits and reproducible hashes; it stratifies across
 * feeds with the per-feed cap, records exclusions, and never mutates a frozen version.
 */

let ctx: EvalTestContext;
const feedsByLang: Record<string, string[]> = { en: [], sk: [], cs: [] };
const storyTitles = ['Tram line approved', 'Council budget passed', 'Floods in the north'];
const excluded: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupEvalTest();
  // 12 feeds per language; feed 0 is prolific (40 articles), the others carry 6 each, over 3 days.
  for (const lang of ['en', 'sk', 'cs']) {
    for (let f = 0; f < 12; f += 1) {
      const feedId = await goldenFeed(ctx, `${lang}${f}`);
      feedsByLang[lang]!.push(feedId);
      const n = f === 0 ? 40 : 6;
      for (let i = 0; i < n; i += 1) {
        await collected(ctx, {
          feedIds: [feedId],
          lang,
          title: `${lang} feed ${f} story ${i}`,
          firstSeenAt: new Date(Date.UTC(2026, 8, 20 + (i % 3), 8)),
        });
      }
    }
  }
  // The same story under one title in two English feeds (a story group): both copies share a side.
  const [en1, en2] = [feedsByLang['en']![1]!, feedsByLang['en']![2]!];
  for (const title of storyTitles) {
    await collected(ctx, { feedIds: [en1], lang: 'en', title });
    await collected(ctx, { feedIds: [en2], lang: 'en', title: `${title}!` });
  }
  // Exclusions: stale, not yet extracted, failed, another language, no language, and an article
  // of a feed the evaluation user does not subscribe to.
  const en0 = feedsByLang['en']![0]!;
  excluded['stale'] = await collected(ctx, { feedIds: [en0], lang: 'en', state: 'stale' });
  excluded['pending'] = await collected(ctx, { feedIds: [en0], lang: 'en', state: 'ingested' });
  excluded['failed'] = await collected(ctx, { feedIds: [en0], lang: 'en', state: 'failed' });
  excluded['de'] = await collected(ctx, { feedIds: [en0], lang: 'de' });
  excluded['und'] = await collected(ctx, { feedIds: [en0], lang: null });
  const foreign = await ctx.owner.query<{ id: string }>(
    `INSERT INTO feeds (url, fetch_url) VALUES ('https://other.example.test/f', 'https://other.example.test/f')
     RETURNING id::text AS id`,
  );
  excluded['unsubscribed'] = await collected(ctx, { feedIds: [foreign.rows[0]!.id], lang: 'en' });
});

afterAll(async () => {
  await ctx?.close();
});

const sample = (args: string[]) => runCli(ctx, ['sample', ...args]);

describe('eval sample (M3a-T2)', () => {
  it('draws up to --per-lang per language with the per-feed cap, splits and exclusions recorded', async () => {
    const run = await sample(['--version', 'golden-a', '--seed', 's1', '--per-lang', '50']);
    expect(run.out).toContain('golden-a: created, 150 article(s) added (seed "s1")');
    const rows = await loadSample(ctx.db, 'golden-a');
    expect(rows).toHaveLength(150);
    for (const lang of ['en', 'sk', 'cs']) {
      const own = rows.filter((r) => r.lang === lang);
      expect(own).toHaveLength(50);
      // Cap: 10 % of 50 = 5 per feed, so the prolific feed (40 eligible) holds at most 5.
      const byFeed = new Map<string, number>();
      for (const row of own) {
        const feed = asSnapshot(row.snapshot).canonicalFeedId ?? '?';
        byFeed.set(feed, (byFeed.get(feed) ?? 0) + 1);
      }
      expect(Math.max(...byFeed.values())).toBeLessThanOrEqual(5);
      // 50 over 12 feeds: 4 or 5 each, the prolific feed included.
      expect(byFeed.get(feedsByLang[lang]![0]!)).toBeGreaterThanOrEqual(4);
      expect(Math.min(...byFeed.values())).toBeGreaterThanOrEqual(4);
      expect(byFeed.size).toBe(12);
      // 70 % development by story group, per language.
      const dev = own.filter((r) => r.split === 'dev').length;
      expect(dev).toBeGreaterThanOrEqual(33);
      expect(dev).toBeLessThanOrEqual(37);
    }
    const ids = new Set(rows.map((r) => r.articleId));
    for (const id of Object.values(excluded)) expect(ids.has(id)).toBe(false);

    // Frozen input snapshots with their hash.
    const first = rows[0]!;
    const snapshot = asSnapshot(first.snapshot);
    expect(snapshot).toMatchObject({ v: 1, articleId: first.articleId, lang: first.lang });
    expect(snapshot.input.title).toEqual(expect.any(String));
    expect(first.snapshotSha).toMatch(/^[0-9a-f]{64}$/);

    // Seed, timestamps, availability and exclusions are stored with the version.
    const dataset = await getDataset(ctx.db, 'golden-a');
    expect(dataset?.seed).toBe('s1');
    const sampling = dataset?.params['sampling'] as Record<string, unknown>[];
    expect(sampling).toHaveLength(1);
    expect(sampling[0]).toMatchObject({
      seed: 's1',
      perLang: 50,
      feedCapShare: 0.1,
      added: 150,
      exclusions: { otherLang: { de: 1 }, undetected: 1, skipped: [] },
      byLang: {
        en: {
          target: 50,
          size: 50,
          cap: 5,
          excluded: { pending: 1, stale: 1, failed: 1 },
          available: 40 + 11 * 6 + 6,
        },
      },
    });
    expect(Date.parse(String(sampling[0]!['at']))).not.toBeNaN();
  });

  it('keeps every copy of a story on one side of the split', async () => {
    await sample([
      '--version',
      'golden-all',
      '--seed',
      's1',
      '--per-lang',
      '500',
      '--feed-cap',
      '1',
    ]);
    const rows = await loadSample(ctx.db, 'golden-all', { langs: ['en'] });
    const byGroup = new Map<string, Set<string>>();
    for (const row of rows) {
      const group = asSnapshot(row.snapshot).storyGroupId;
      byGroup.set(group, (byGroup.get(group) ?? new Set()).add(row.split));
    }
    const grouped = rows.filter((r) =>
      storyTitles.some((t) => asSnapshot(r.snapshot).input.title.startsWith(t)),
    );
    expect(grouped).toHaveLength(6);
    expect(new Set(grouped.map((r) => asSnapshot(r.snapshot).storyGroupId)).size).toBe(3);
    for (const sides of byGroup.values()) expect(sides.size).toBe(1);
  });

  it('is reproducible: the same seed gives the same snapshot and split hashes, another seed does not', async () => {
    await sample(['--version', 'golden-b', '--seed', 's1', '--per-lang', '50']);
    await sample(['--version', 'golden-c', '--seed', 's2', '--per-lang', '50']);
    const [a, b, c] = await Promise.all(
      ['golden-a', 'golden-b', 'golden-c'].map((v) => computeDatasetManifest(ctx.db, v)),
    );
    expect(b!.snapshotSha).toBe(a!.snapshotSha);
    expect(b!.splitSha).toBe(a!.splitSha);
    expect(b!.byLang).toEqual(a!.byLang);
    expect(c!.snapshotSha).not.toBe(a!.snapshotSha);
    expect(c!.splitSha).not.toBe(a!.splitSha);
  });

  it('is idempotent on an open version and refuses a different seed', async () => {
    const before = await computeDatasetManifest(ctx.db, 'golden-a');
    const again = await sample(['--version', 'golden-a']);
    expect(again.out).toContain('golden-a: unchanged (nothing new to draw)');
    expect(await computeDatasetManifest(ctx.db, 'golden-a')).toEqual(before);
    await expect(sample(['--version', 'golden-a', '--seed', 'other'])).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: expect.stringContaining('drawn with seed "s1"'),
    });
  });

  it('fills an open version up when articles arrive, keeping the earlier rows and their splits', async () => {
    const before = await loadSample(ctx.db, 'golden-a');
    // Raise the target: the open version gains articles; existing rows stay as they were.
    const run = await sample(['--version', 'golden-a', '--per-lang', '60']);
    expect(run.out).toContain('golden-a: 30 article(s) added');
    const after = await loadSample(ctx.db, 'golden-a');
    expect(after).toHaveLength(180);
    const byId = new Map(after.map((r) => [r.articleId, r]));
    for (const row of before) {
      expect(byId.get(row.articleId)).toMatchObject({
        split: row.split,
        snapshotSha: row.snapshotSha,
      });
    }
    const dataset = await getDataset(ctx.db, 'golden-a');
    expect(dataset?.params['perLang']).toBe(60);
    expect((dataset?.params['sampling'] as unknown[]).length).toBe(2);
  });

  it('never mutates a frozen version; the next draw goes to a new version copied from it', async () => {
    await ctx.db.transaction((tx) => freezeDataset(tx, 'golden-c'));
    const frozen = await getDataset(ctx.db, 'golden-c');
    const named = await sample(['--version', 'golden-c', '--per-lang', '80']);
    expect(named.out).toContain('golden-c is frozen');
    expect(await getDataset(ctx.db, 'golden-c')).toEqual(frozen);

    // Without --version the head (the latest version created: golden-c) is frozen, so the draw
    // creates golden-c-v2 from it.
    const next = await sample(['--per-lang', '80']);
    expect(next.out).toContain('golden-c-v2: created from frozen golden-c');
    const parentRows = await loadSample(ctx.db, 'golden-c');
    const childRows = await loadSample(ctx.db, 'golden-c-v2');
    expect(childRows.length).toBeGreaterThan(parentRows.length);
    const child = new Map(childRows.map((r) => [r.articleId, r]));
    for (const row of parentRows) {
      expect(child.get(row.articleId)).toMatchObject({
        split: row.split,
        snapshotSha: row.snapshotSha,
      });
    }
    const v2 = await getDataset(ctx.db, 'golden-c-v2');
    expect(v2).toMatchObject({ parentVersion: 'golden-c', seed: 's2', frozenAt: null });
    expect(await getDataset(ctx.db, 'golden-c')).toEqual(frozen);

    // A frozen head with nothing new to draw creates no successor and reports itself, not the
    // name a successor would have had.
    await ctx.db.transaction((tx) => freezeDataset(tx, 'golden-c-v2'));
    const idle = await sample(['--per-lang', '80']);
    expect(idle.out).toContain('golden-c-v2: unchanged');
    expect(idle.out).not.toContain('golden-c-v3');
    expect(await getDataset(ctx.db, 'golden-c-v3')).toBeNull();
  });

  it('reports a language that runs short instead of filling it from one feed', async () => {
    const run = await sample(['--version', 'golden-short', '--per-lang', '500', '--langs', 'sk']);
    // 106 eligible, but 11 of the 12 feeds carry only 6: under a 10 % cap the largest sample the
    // feeds can fill is 73 (cap 7: 7 + 11 × 6), not 106 with 40 from one feed.
    expect(run.out).toMatch(/sk\s+73\/500/);
    expect(run.out).toContain('SHORT');
    expect(run.out).toMatch(/sk: only \d+ of 500 under the \d+-per-feed cap/);
    const rows = await loadSample(ctx.db, 'golden-short');
    const n = rows.length;
    expect(n).toBeLessThan(500);
    const cap = Math.floor(n * 0.1);
    const byFeed = new Map<string, number>();
    for (const row of rows) {
      const feed = asSnapshot(row.snapshot).canonicalFeedId ?? '?';
      byFeed.set(feed, (byFeed.get(feed) ?? 0) + 1);
    }
    expect(Math.max(...byFeed.values())).toBeLessThanOrEqual(cap);
  });

  it('refuses a re-run that narrows the recorded parameters and records a widening one', async () => {
    // golden-short holds Slovak rows drawn with a target of 500 and a 10 % cap.
    const before = await computeDatasetManifest(ctx.db, 'golden-short');
    const params = (await getDataset(ctx.db, 'golden-short'))?.params;
    for (const [args, reason] of [
      [['--langs', 'en'], 'drops sk'],
      [['--per-lang', '100'], '--per-lang 500 (now 100)'],
      [['--feed-cap', '0.05'], '--feed-cap 0.1 (now 0.05)'],
    ] as const) {
      await expect(sample(['--version', 'golden-short', ...args])).rejects.toMatchObject({
        name: 'EvalCommandError',
        message: expect.stringMatching(
          new RegExp(
            `golden-short was sampled with .*${reason.replace(/[.()]/g, '\\$&')}.*--version <new>`,
          ),
        ),
      });
    }
    // Nothing changed: rows and recorded parameters stay as they were.
    expect(await computeDatasetManifest(ctx.db, 'golden-short')).toEqual(before);
    expect((await getDataset(ctx.db, 'golden-short'))?.params).toEqual(params);

    // A superset of languages tops the version up and records the widened set.
    const skRows = await loadSample(ctx.db, 'golden-short', { langs: ['sk'] });
    const widened = await sample(['--version', 'golden-short', '--langs', 'sk,cs']);
    expect(widened.out).toMatch(/golden-short: \d+ article\(s\) added/);
    expect(await loadSample(ctx.db, 'golden-short', { langs: ['sk'] })).toEqual(skRows);
    expect((await loadSample(ctx.db, 'golden-short', { langs: ['cs'] })).length).toBeGreaterThan(0);
    expect((await getDataset(ctx.db, 'golden-short'))?.params['langs']).toEqual(['sk', 'cs']);
    // Dropping the language just added is refused too; a new version starts its own lineage.
    await expect(sample(['--version', 'golden-short', '--langs', 'sk'])).rejects.toMatchObject({
      message: expect.stringContaining('drops cs'),
    });
    const fresh = await sample([
      '--version',
      'golden-short-en',
      '--langs',
      'en',
      '--per-lang',
      '20',
    ]);
    expect(fresh.out).toContain('golden-short-en: created');

    // A widening that adds nothing still records its parameters.
    // (French has no articles and English is already at its target.)
    const unchanged = await sample(['--version', 'golden-short-en', '--langs', 'en,fr']);
    expect(unchanged.out).toContain('golden-short-en: unchanged');
    expect((await getDataset(ctx.db, 'golden-short-en'))?.params['langs']).toEqual(['en', 'fr']);
  });

  it('refuses a draw on a database without collected articles', async () => {
    await expect(sample(['--version', 'golden-none', '--langs', 'fr'])).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: expect.stringContaining('no eligible articles for fr'),
    });
    expect(await getDataset(ctx.db, 'golden-none')).toBeNull();
  });
  it('keeps the candidates locked until the draw commits, so the worker cannot change them', async () => {
    const feedId = feedsByLang['en']![3]!;
    const target = await ctx.owner.query<{ id: string }>(
      `SELECT fi.article_id::text AS id FROM feed_items fi WHERE fi.feed_id = $1 LIMIT 1`,
      [feedId],
    );
    const id = target.rows[0]!.id;
    await ctx.db.transaction(async (tx) => {
      await loadSampleCandidates(tx, ctx.evalUserId);
      const client = await ctx.owner.connect();
      try {
        await client.query(`SET lock_timeout = '200ms'`);
        await expect(
          client.query(`UPDATE articles SET lang = 'sk' WHERE id = $1`, [id]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        client.release(true);
      }
    });
  });
});
