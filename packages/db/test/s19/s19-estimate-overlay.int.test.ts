import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGoldenWorld,
  captureUser,
  type Golden,
  type GoldenSection,
  type GoldenWorld,
  type UserKey,
} from '../support/s19-golden-world.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * S19 estimate overlay: the golden world with every unscored lane-`new` row turned into a stored
 * word estimate (source `estimate`, a P and its tier). The estimates are read in every view
 * (visible-learning §3.4), yet no unscoped lane, count or id list moves: only the New rows gain a
 * P, a tier and a digest that follows them, and a scoped view with `minTier > 1` lists the
 * estimates at or above it.
 */

const golden = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 's19-golden.json'),
    'utf8',
  ),
) as Golden;

const READERS = ['A', 'B', 'C'] as const;
const LANE_FIELDS = [
  'forYou',
  'maybe',
  'everything',
  'new',
  'bookmarks',
  'hidden',
  'scored',
  'total',
];
const SCORED_FIELDS = ['forYou', 'maybe', 'everything', 'bookmarks', 'hidden'];

interface ListValue {
  versions: string[];
  pending: boolean[];
  next: (string | null)[];
  pages: string[][];
}
type Counts = Record<string, number | boolean | string>;
type Unread = { feed: string; forYou: number; maybe: number; everything: number; new: number }[];

let ctx: DbTestContext;
let world: GoldenWorld;
let overlaid: Record<UserKey, number>;
const after = {} as Record<UserKey, GoldenSection>;

beforeAll(async () => {
  ctx = await setupDbTest();
  world = await buildGoldenWorld(ctx.owner);
  overlaid = { A: 0, B: 0, C: 0 };
  for (const key of READERS) {
    const result = await ctx.owner.query(
      `UPDATE user_article
          SET score_source = 'estimate',
              p_like = ((article_id % 19) + 1) / 20.0,
              tier = 1 + (((article_id % 19) + 1) / 20.0 >= 0.25)::int
                       + (((article_id % 19) + 1) / 20.0 >= 0.45)::int
                       + (((article_id % 19) + 1) / 20.0 >= 0.65)::int
                       + (((article_id % 19) + 1) / 20.0 >= 0.85)::int,
              rules_fired = '{estimate}'
        WHERE user_id = $1 AND lane = 'new' AND score_source = 'none'`,
      [world.users[key]],
    );
    overlaid[key] = result.rowCount ?? 0;
    after[key] = await captureUser(ctx.app, world, key);
  }
}, 600_000);

afterAll(async () => {
  await ctx.close();
});

const isGlobalList = (name: string): boolean => name.startsWith('list:');
const laneOf = (name: string): string => {
  const parts = name.split(':');
  return isGlobalList(name) ? parts[1]! : parts[parts.length - 2]!;
};
const sortOf = (name: string): string => {
  if (!isGlobalList(name)) return laneOf(name) === 'for_you' ? 'score' : 'date';
  const parts = name.split(':');
  return parts[4] ?? 'date';
};
const ids = (pages: string[][]): string[] =>
  pages
    .flat()
    .map((row) => row.split('|')[0]!)
    .sort((a, b) => Number(a) - Number(b));
const listKeys = (key: UserKey): string[] =>
  Object.keys(golden.users[key]).filter((name) => name.startsWith('list'));
const value = <T>(section: GoldenSection, name: string): T => section[name] as unknown as T;

describe('the overlay is live', () => {
  it.each(READERS)('reader %s has unscored New rows turned into estimates', (key) => {
    expect(overlaid[key]).toBeGreaterThan(0);
  });
});

describe('unscoped lanes, counts and id lists do not move (pins existing behaviour at the SQL level)', () => {
  it.each(READERS)(
    'reader %s: For you, Maybe and Everything lists are identical including digests',
    (key) => {
      const names = listKeys(key).filter((name) =>
        ['for_you', 'maybe', 'everything'].includes(laneOf(name)),
      );
      expect(names.length).toBeGreaterThan(20);
      const different = names.filter(
        (name) => JSON.stringify(after[key]![name]) !== JSON.stringify(golden.users[key][name]),
      );
      expect(different).toEqual([]);
    },
  );

  it.each(READERS)('reader %s: rows and order of date-sorted lists are identical', (key) => {
    const names = listKeys(key).filter(
      (name) =>
        sortOf(name) === 'date' && !['for_you', 'maybe', 'everything'].includes(laneOf(name)),
    );
    expect(names.length).toBeGreaterThan(20);
    const different = names.filter((name) => {
      const was = value<ListValue>(golden.users[key], name);
      const now = value<ListValue>(after[key]!, name);
      return (
        JSON.stringify([was.pages, was.pending, was.next]) !==
        JSON.stringify([now.pages, now.pending, now.next])
      );
    });
    expect(different).toEqual([]);
  });

  it.each(READERS)('reader %s: score and uncertainty orders keep the same rows', (key) => {
    const names = listKeys(key).filter(
      (name) =>
        ['score', 'uncertainty'].includes(sortOf(name)) &&
        !name.endsWith(':limit1') &&
        !['for_you', 'maybe', 'everything'].includes(laneOf(name)),
    );
    expect(names.length).toBeGreaterThan(0);
    const different = names.filter((name) => {
      const was = value<ListValue>(golden.users[key], name);
      const now = value<ListValue>(after[key]!, name);
      return JSON.stringify(ids(was.pages)) !== JSON.stringify(ids(now.pages));
    });
    expect(different).toEqual([]);
  });

  it.each(READERS)('reader %s: global lane counts and rankingPending are identical', (key) => {
    const names = Object.keys(golden.users[key]).filter((name) => name.startsWith('counts@global'));
    expect(names).toHaveLength(4);
    for (const name of names) {
      const was = value<Counts>(golden.users[key], name);
      const now = value<Counts>(after[key]!, name);
      expect({ name, fields: pick(now, [...LANE_FIELDS, 'rankingPending']) }).toEqual({
        name,
        fields: pick(was, [...LANE_FIELDS, 'rankingPending']),
      });
    }
  });

  it.each(READERS)('reader %s: scoped counts at minTier 0 are identical', (key) => {
    const names = Object.keys(golden.users[key]).filter(
      (name) =>
        name.startsWith('counts@') && name.endsWith(':t0') && !name.startsWith('counts@global'),
    );
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      const was = value<Counts>(golden.users[key], name);
      const now = value<Counts>(after[key]!, name);
      expect({ name, fields: pick(now, [...LANE_FIELDS, 'rankingPending']) }).toEqual({
        name,
        fields: pick(was, [...LANE_FIELDS, 'rankingPending']),
      });
    }
  });

  it.each(READERS)(
    'reader %s: lane mix, calibration, item contexts, per-feed badges at minTier 0 and the view ids are identical',
    (key) => {
      const exact = Object.keys(golden.users[key]).filter(
        (name) =>
          name.startsWith('lane-mix:') ||
          name === 'calibration' ||
          name.startsWith('contexts@') ||
          name === 'subscription-unread:t0',
      );
      expect(exact.length).toBeGreaterThan(5);
      const different = exact.filter(
        (name) => JSON.stringify(after[key]![name]) !== JSON.stringify(golden.users[key][name]),
      );
      expect(different).toEqual([]);
      for (const name of Object.keys(golden.users[key]).filter((n) => n.startsWith('view-ids:'))) {
        const was = value<{ ids: string[]; total: number }>(golden.users[key], name);
        const now = value<{ ids: string[]; total: number }>(after[key]!, name);
        expect({ name, ids: now.ids, total: now.total }).toEqual({
          name,
          ids: was.ids,
          total: was.total,
        });
      }
    },
  );
});

describe('the estimates show up where they must', () => {
  it.each(READERS)(
    'reader %s: the digest of a view with New rows follows their P and tier',
    (key) => {
      const names = listKeys(key).filter(
        (name) =>
          ['new', 'all'].includes(laneOf(name)) &&
          sortOf(name) === 'date' &&
          value<ListValue>(golden.users[key], name).pages.flat().length > 0,
      );
      expect(names.length).toBeGreaterThan(4);
      const same = names.filter(
        (name) =>
          JSON.stringify(value<ListValue>(after[key]!, name).versions) ===
          JSON.stringify(value<ListValue>(golden.users[key], name).versions),
      );
      // The global New views hold the converted rows; a scoped one only when one of them is in it.
      expect(same.filter((name) => isGlobalList(name) && laneOf(name) === 'new')).toEqual([]);
      expect(
        names.filter((name) => !isGlobalList(name) && !same.includes(name)).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each(READERS)('reader %s: the global counts digest follows the New rows', (key) => {
    const was = value<Counts>(golden.users[key], 'counts@global:unread:t0');
    const now = value<Counts>(after[key]!, 'counts@global:unread:t0');
    expect(now['datasetVersion']).not.toBe(was['datasetVersion']);
  });

  it.each(READERS)('reader %s: score order puts the estimated New rows by P', (key) => {
    const name = 'list:new:unread:t0:score';
    const was = value<ListValue>(golden.users[key], name);
    const now = value<ListValue>(after[key]!, name);
    expect(was.pages.flat().length).toBeGreaterThan(1);
    expect(JSON.stringify(now.pages)).not.toBe(JSON.stringify(was.pages));
  });

  it.each(READERS)(
    'reader %s: scoped counts at minTier 3 gain New rows and keep every other lane',
    (key) => {
      const names = Object.keys(golden.users[key]).filter(
        (name) =>
          name.startsWith('counts@') && name.endsWith(':t3') && !name.startsWith('counts@global'),
      );
      expect(names.length).toBeGreaterThan(10);
      let gained = 0;
      let moved = 0;
      for (const name of names) {
        const was = value<Counts>(golden.users[key], name);
        const now = value<Counts>(after[key]!, name);
        expect({ name, fields: pick(now, [...SCORED_FIELDS, 'scored', 'rankingPending']) }).toEqual(
          {
            name,
            fields: pick(was, [...SCORED_FIELDS, 'scored', 'rankingPending']),
          },
        );
        expect(now['new'] as number).toBeGreaterThanOrEqual(was['new'] as number);
        expect(now['total'] as number).toBe(
          (was['total'] as number) + (now['new'] as number) - (was['new'] as number),
        );
        if ((now['new'] as number) > (was['new'] as number)) gained += 1;
        if (now['datasetVersion'] !== was['datasetVersion']) moved += 1;
      }
      expect(gained).toBeGreaterThan(0);
      expect(moved).toBeGreaterThan(0);
    },
  );

  it.each(READERS)(
    'reader %s: per-feed badges at minTier 3 gain New rows and keep every other lane',
    (key) => {
      const was = value<Unread>(golden.users[key], 'subscription-unread:t3');
      const now = new Map(
        value<Unread>(after[key]!, 'subscription-unread:t3').map((r) => [r.feed, r]),
      );
      let gained = 0;
      for (const row of was) {
        const next = now.get(row.feed);
        expect(next).toBeDefined();
        expect([next!.forYou, next!.maybe, next!.everything]).toEqual([
          row.forYou,
          row.maybe,
          row.everything,
        ]);
        expect(next!.new).toBeGreaterThanOrEqual(row.new);
      }
      for (const row of now.values()) {
        const before = was.find((r) => r.feed === row.feed);
        if (row.new > (before?.new ?? 0)) gained += 1;
      }
      expect(gained).toBeGreaterThan(0);
    },
  );
});

function pick(source: Counts, fields: string[]): Counts {
  return Object.fromEntries(fields.map((field) => [field, source[field] ?? 'absent'])) as Counts;
}
