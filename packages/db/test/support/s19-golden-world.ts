import { createCard, createFeed, createUser } from '@bantoozi/testing';
import type pg from 'pg';

import {
  articleContexts,
  articleViewIds,
  calibrationArticles,
  countArticles,
  countSubscriptionUnread,
  listArticlePage,
  readerLaneMix,
  type ArticleContext,
  type ArticleListKey,
  type ArticleListSort,
  type ArticleScope,
} from '../../src/api/articles.js';
import type { Database } from '../../src/client.js';
import { withTenant } from '../../src/tenant.js';

/**
 * S19 golden world: a small, fully deterministic database (fixed timestamps relative to ANCHOR,
 * a seeded generator, fresh identity sequences) with three readers whose subscriptions cover every
 * inference mode, hidden feeds, folders, duplicate policies, shared articles whose carriers arrive
 * at different times (the display feed is a choice), folded clusters, selected analysis requests
 * (matching, stale-version, wrong-revision and out-of-window), outdated ranks, read/archived/
 * bookmarked/labelled rows and tie-heavy sort keys.
 *
 * `captureGolden` runs every reader view function over a grid of inputs and returns compact,
 * JSON-serializable outputs. The committed fixture `fixtures/s19-golden.json` was produced by
 * `s19/generate-golden.ts` on the code BEFORE the projection rewrite; the equivalence test asserts
 * the functions still produce exactly that.
 */

export const ANCHOR = new Date('2026-10-01T12:00:00.000Z');
export const SCORE_VERSION = '1:0';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number): Date => new Date(ANCHOR.getTime() + offsetMs);

export const USER_IDS = {
  A: '01a12a81-0000-7000-8000-00000000000a',
  B: '01a12a81-0000-7000-8000-00000000000b',
  C: '01a12a81-0000-7000-8000-00000000000c',
} as const;
export type UserKey = keyof typeof USER_IDS;

interface SubSpec {
  feed: number;
  mode: 'off' | 'training' | 'active';
  version?: number;
  /** Activation offset from ANCHOR (active only). */
  activated?: number;
  hidden?: boolean;
  allowDuplicates?: boolean;
  folder?: string;
  titleOverride?: string;
}

const SUBS: Record<UserKey, SubSpec[]> = {
  A: [
    { feed: 1, mode: 'active', activated: -60 * DAY },
    { feed: 2, mode: 'active', activated: -6 * DAY },
    { feed: 3, mode: 'training' },
    { feed: 4, mode: 'off' },
    { feed: 5, mode: 'active', activated: -30 * DAY, hidden: true },
    { feed: 6, mode: 'active', activated: -30 * DAY, allowDuplicates: true },
    { feed: 7, mode: 'active', activated: -30 * DAY, folder: 'tech' },
    { feed: 8, mode: 'training', version: 2, folder: 'tech' },
    {
      feed: 9,
      mode: 'active',
      activated: -30 * DAY,
      folder: 'news',
      titleOverride: 'India Override',
    },
    { feed: 10, mode: 'training' },
    { feed: 11, mode: 'off', folder: 'news' },
  ],
  B: [
    { feed: 1, mode: 'training' },
    { feed: 2, mode: 'off' },
    { feed: 3, mode: 'active', activated: -3 * DAY },
    { feed: 5, mode: 'active', activated: -30 * DAY },
    { feed: 6, mode: 'active', activated: -30 * DAY },
    { feed: 7, mode: 'active', activated: -30 * DAY, folder: 'tech' },
    { feed: 9, mode: 'active', activated: -30 * DAY },
    { feed: 12, mode: 'off' },
  ],
  C: [
    { feed: 1, mode: 'active', activated: 1 * DAY },
    { feed: 4, mode: 'off' },
    { feed: 11, mode: 'off' },
  ],
};

const FEED_COUNT = 12;
const ARTICLE_COUNT = 150;

/** mulberry32: a tiny seeded generator, so the world is identical on every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GoldenWorld {
  users: Record<UserKey, string>;
  feedIds: string[];
  articleIds: string[];
  subs: Record<UserKey, SubSpec[]>;
  labelIds: string[];
}

async function insert(owner: pg.Pool | pg.PoolClient, text: string, values: unknown[]) {
  return owner.query(text, values);
}

export async function buildGoldenWorld(owner: pg.Pool): Promise<GoldenWorld> {
  const random = rng(19);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const users = {} as Record<UserKey, string>;
  for (const key of ['A', 'B', 'C'] as const) {
    users[key] = (
      await createUser(owner, { id: USER_IDS[key], email: `s19-${key}@example.test` })
    ).id;
  }
  await owner.query(`UPDATE users SET rank_revision = 3 WHERE id = $1`, [users.A]);
  await owner.query(`UPDATE users SET rank_revision = 5 WHERE id = $1`, [users.B]);

  const labelIds: string[] = [];
  for (const title of ['Label one', 'Label two']) {
    const card = await createCard(owner, { kind: 'label', visibility: 'public', title });
    labelIds.push(card.id);
    for (const key of ['A', 'B', 'C'] as const) {
      await owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)`, [
        users[key],
        card.id,
        title,
      ]);
    }
  }
  const LABEL_IDS = labelIds;

  const feedIds: string[] = [];
  for (let n = 1; n <= FEED_COUNT; n += 1) {
    const feed = await createFeed(owner, {
      url: `https://s19.example.test/feed-${n}.xml`,
      title: `Feed ${String.fromCharCode(64 + n)}`,
    });
    feedIds.push(feed.id);
  }
  if (feedIds[0] !== '1') throw new Error('the golden world needs fresh identity sequences');

  for (const key of ['A', 'B', 'C'] as const) {
    for (const sub of SUBS[key]) {
      const version = sub.version ?? (sub.mode === 'off' ? 0 : 1);
      await insert(
        owner,
        `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version,
                                   inference_activated_at, hidden, allow_duplicates, folder,
                                   title_override)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          users[key],
          sub.feed,
          sub.mode,
          version,
          sub.mode === 'active' ? at(sub.activated ?? -30 * DAY) : null,
          sub.hidden ?? false,
          sub.allowDuplicates ?? false,
          sub.folder ?? null,
          sub.titleOverride ?? null,
        ],
      );
    }
  }

  // Articles: arrivals quantized to 6 hours (ties), a few on the window edges and after asOf.
  const articleIds: string[] = [];
  const carriers: { article: number; feed: number; seen: Date }[] = [];
  for (let n = 1; n <= ARTICLE_COUNT; n += 1) {
    let seenOffset = -Math.floor(random() * 16 * 4) * 6 * HOUR;
    if (n === 7) seenOffset = -14 * DAY; // exactly on the window start
    if (n === 8) seenOffset = -14 * DAY - 1; // one millisecond outside
    if (n === 9) seenOffset = 0; // exactly asOf
    if (n === 10) seenOffset = HOUR; // after asOf
    const seen = at(seenOffset);
    const published = random() < 0.25 ? null : at(seenOffset - Math.floor(random() * 30) * HOUR);
    const result = await insert(
      owner,
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, published_at,
                            first_seen_at, content_hash, content_revision, pipeline_state)
       VALUES ($1, $1, $2, $3, lower($3), $4, $5, $6, $7, $8) RETURNING id::text AS id`,
      [
        `https://s19.example.test/a/${n}`,
        `s19.example.test/a/${n}`,
        `Article ${n}`,
        published,
        seen,
        `hash-${n}`,
        n % 17 === 0 ? 2 : 1,
        n % 11 === 0 ? 'stale' : 'enriched',
      ],
    );
    const id = (result.rows[0] as { id: string }).id;
    articleIds.push(id);
    const carrierCount = random() < 0.55 ? 1 : random() < 0.6 ? 2 : 3;
    const chosen = new Set<number>();
    while (chosen.size < carrierCount) chosen.add(1 + Math.floor(random() * FEED_COUNT));
    for (const feed of [...chosen].sort((a, b) => a - b)) {
      // Later carriers arrive up to a day after the first sighting, never after asOf + 1 h.
      const seenHere = new Date(
        Math.min(seen.getTime() + Math.floor(random() * 5) * 6 * HOUR, ANCHOR.getTime() + HOUR),
      );
      carriers.push({ article: n, feed, seen: seenHere });
      await insert(
        owner,
        `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)`,
        [feed, id, `g-${n}-${feed}`, seenHere],
      );
    }
  }

  // Story clusters: consecutive runs of 2-4 articles, many spanning feeds with mixed policies.
  for (let n = 1; n + 3 <= ARTICLE_COUNT; n += 6) {
    const size = 2 + Math.floor(random() * 3);
    const members = articleIds.slice(n - 1, n - 1 + size);
    const cluster = await insert(
      owner,
      `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2) RETURNING id::text AS id`,
      [members[0], members.length],
    );
    const clusterId = (cluster.rows[0] as { id: string }).id;
    await insert(owner, `UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`, [
      clusterId,
      members,
    ]);
  }

  // Reader state: ~80 % of the articles of the feeds a reader subscribes to, plus the lone bookmarks.
  const lanes = [
    'new',
    'new',
    'for_you',
    'for_you',
    'maybe',
    'maybe',
    'everything',
    'everything',
    'everything',
    'hidden',
  ] as const;
  for (const key of ['A', 'B', 'C'] as const) {
    const subscribed = new Set(SUBS[key].map((sub) => sub.feed));
    const rankRevision = key === 'A' ? 3 : key === 'B' ? 5 : 0;
    const reach = new Set(carriers.filter((c) => subscribed.has(c.feed)).map((c) => c.article));
    for (let n = 1; n <= ARTICLE_COUNT; n += 1) {
      const bookmarkOnly = key === 'C' && !reach.has(n) && n % 9 === 0;
      if (!(reach.has(n) && random() < 0.8) && !bookmarkOnly) continue;
      const lane = pick(lanes);
      const p = lane === 'new' ? null : Math.round((0.05 + random() * 0.9) * 20) / 20;
      const tier = p === null ? null : Math.min(5, 1 + Math.floor(p * 5));
      const hideRule =
        lane === 'hidden'
          ? [pick(['mute_keyword:x', 'block_feed', 'mute_story', 'block_domain', 'boost_x'])]
          : [];
      const outdated = random();
      const rated = random() < 0.1;
      const bookmarked = bookmarkOnly || random() < 0.1;
      await insert(
        owner,
        `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, rules_fired,
                                  score_version, rank_revision, next_rank_at, read_at, archived_at,
                                  label_ids, rating, rated_at, bookmarked_at, bookmark_capture_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          users[key],
          articleIds[n - 1],
          lane,
          tier,
          p,
          p === null ? 'none' : 'cards',
          hideRule,
          outdated < 0.08 ? '0:9' : SCORE_VERSION,
          outdated > 0.92 ? Math.max(0, rankRevision - 1) : rankRevision,
          outdated > 0.84 && outdated <= 0.88
            ? at(-DAY)
            : outdated > 0.88 && outdated <= 0.92
              ? at(DAY * 30)
              : null,
          random() < 0.25 ? at(-HOUR) : null,
          random() < 0.05 ? at(-HOUR) : null,
          random() < 0.12 ? (random() < 0.5 ? [LABEL_IDS[0]] : LABEL_IDS) : [],
          rated ? 1 : null,
          rated ? at(-HOUR) : null,
          bookmarked ? at(-2 * HOUR) : null,
          bookmarked ? 'pending' : null,
        ],
      );
    }
  }

  // Selected analysis requests of training feeds: current, wrong-version, wrong-revision, stale.
  const client = await owner.connect();
  try {
    for (const key of ['A', 'B'] as const) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [users[key]]);
      const training = SUBS[key].filter((sub) => sub.mode === 'training');
      let counter = 0;
      for (const carrier of carriers) {
        const sub = training.find((s) => s.feed === carrier.feed);
        if (sub === undefined) continue;
        counter += 1;
        if (counter % 3 !== 0) continue;
        // 0 pending, 1 pending, 2 pending, 3 older than the selection window, 4 failed,
        // 5 running. (Wrong revision / version are made afterwards by bumping them.)
        const kind = (counter / 3) % 6;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                          inference_version, input_snapshot, input_sha, created_at)
           SELECT gen_random_uuid(), $1, $2, a.id, a.content_revision, s.inference_version,
                  '{}'::jsonb, encode(sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'hex'),
                  CASE WHEN $4::int = 3 THEN now() - interval '400 days'
                       ELSE now() - interval '1 day' END
             FROM articles a JOIN subscriptions s ON s.user_id = $1 AND s.feed_id = $2
            WHERE a.id = $3
           ON CONFLICT DO NOTHING RETURNING id`,
          [users[key], carrier.feed, articleIds[carrier.article - 1], kind],
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) continue;
        if (kind === 4) {
          await client.query(
            `UPDATE analysis_requests SET status = 'failed', completed_at = now() WHERE id = $1`,
            [id],
          );
        } else if (kind === 5) {
          await client.query(
            `UPDATE analysis_requests SET status = 'running', lease_token = gen_random_uuid(),
                    lease_until = now() + interval '1 hour' WHERE id = $1`,
            [id],
          );
        }
      }
      await client.query('COMMIT');
    }
    // Requests that no longer cover the current revision or inference version.
    await client.query(
      `UPDATE articles SET content_revision = content_revision + 1 WHERE id % 13 = 0`,
    );
    await client.query(
      `UPDATE subscriptions SET inference_version = inference_version + 1
        WHERE user_id = $1 AND feed_id = 8`,
      [users.A],
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { users, feedIds, articleIds, subs: SUBS, labelIds };
}

// --------------------------------------------------------------------------------------------
// Capture

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type GoldenSection = Record<string, Json>;
export interface Golden {
  version: 1;
  users: Record<UserKey, GoldenSection>;
}

const rowText = (row: ArticleContext): string =>
  [
    row.articleId,
    row.eligible ? 'e' : '-',
    row.displayFeedId ?? '-',
    row.arrival.toISOString(),
    row.cluster === null
      ? '-'
      : `${row.cluster.id}:${row.cluster.size}:${row.cluster.otherFeeds.join(';')}`,
  ].join('|');

const keyText = (key: ArticleListKey | null): string | null =>
  key === null ? null : `${String(key.k1)}|${key.k2}|${key.id}`;

interface ListCombo {
  scope: ArticleScope;
  lane: 'for_you' | 'maybe' | 'everything' | 'new' | 'all' | 'bookmarks' | 'hidden';
  status: 'unread' | 'all';
  minTier: number;
  sort: ArticleListSort;
  limit: number;
}

const defaultSort = (lane: ListCombo['lane']): ArticleListSort =>
  lane === 'for_you' ? 'score' : lane === 'maybe' ? 'uncertainty' : 'date';

async function captureList(db: Database, userId: string, combo: ListCombo): Promise<Json> {
  const pages: Json[] = [];
  const versions = new Set<string>();
  const pendings = new Set<boolean>();
  const nexts: Json[] = [];
  let after: ArticleListKey | null = null;
  for (let guard = 0; guard < 40; guard += 1) {
    const page = await withTenant(db, userId, (tx) =>
      listArticlePage(tx, {
        scope: combo.scope,
        lane: combo.lane,
        status: combo.status,
        minTier: combo.minTier,
        asOf: ANCHOR,
        scoreVersion: SCORE_VERSION,
        sort: combo.sort,
        limit: combo.limit,
        after,
      }),
    );
    versions.add(page.datasetVersion);
    pendings.add(page.rankingPending);
    pages.push(page.rows.map(rowText));
    nexts.push(keyText(page.nextKey));
    after = page.nextKey;
    if (after === null) break;
  }
  return {
    versions: [...versions],
    pending: [...pendings],
    next: nexts,
    pages,
  };
}

function scopeName(scope: ArticleScope): string {
  return (
    [
      scope.feedId === undefined ? '' : `feed${scope.feedId}`,
      scope.folder === undefined ? '' : `folder:${scope.folder}`,
      scope.labelId === undefined ? '' : `label${scope.labelId}`,
    ]
      .filter(Boolean)
      .join('+') || 'global'
  );
}

/** Every scope a reader of this world can open (plus one feed they do not subscribe to). */
export function scopesOf(world: GoldenWorld, key: UserKey): ArticleScope[] {
  const feeds = world.subs[key].map((sub) => sub.feed);
  const folders = [
    ...new Set(world.subs[key].flatMap((sub) => (sub.folder === undefined ? [] : [sub.folder]))),
  ];
  const scopes: ArticleScope[] = [{}];
  for (const feed of feeds) scopes.push({ feedId: String(feed) });
  scopes.push({ feedId: '12' }, { feedId: '4' });
  for (const folder of folders) scopes.push({ folder });
  scopes.push({ labelId: world.labelIds[0]! }, { labelId: world.labelIds[1]! });
  scopes.push({ feedId: '7', folder: 'tech' }, { feedId: '9', folder: 'tech' });
  scopes.push({ folder: 'tech', labelId: world.labelIds[0]! });
  return scopes.filter(
    (scope, index, all) => all.findIndex((s) => scopeName(s) === scopeName(scope)) === index,
  );
}

const LANES = ['for_you', 'maybe', 'everything', 'new', 'all', 'bookmarks', 'hidden'] as const;

export async function captureUser(
  db: Database,
  world: GoldenWorld,
  key: UserKey,
): Promise<GoldenSection> {
  const userId = world.users[key];
  const out: GoldenSection = {};

  // 1. Global grid: lane x status x minTier with the lane's natural sort, plus every sort.
  for (const lane of LANES) {
    for (const status of ['unread', 'all'] as const) {
      for (const minTier of [0, 3, 5]) {
        const combo: ListCombo = {
          scope: {},
          lane,
          status,
          minTier,
          sort: defaultSort(lane),
          limit: 7,
        };
        out[`list:${lane}:${status}:t${minTier}:${combo.sort}`] = await captureList(
          db,
          userId,
          combo,
        );
      }
    }
    for (const sort of ['score', 'uncertainty', 'date'] as const) {
      if (sort === defaultSort(lane)) continue;
      const combo: ListCombo = { scope: {}, lane, status: 'unread', minTier: 0, sort, limit: 7 };
      out[`list:${lane}:unread:t0:${sort}`] = await captureList(db, userId, combo);
    }
  }
  // A page size larger than the view, and one row per page.
  out['list:all:all:t0:date:limit200'] = await captureList(db, userId, {
    scope: {},
    lane: 'all',
    status: 'all',
    minTier: 0,
    sort: 'date',
    limit: 200,
  });
  out['list:all:unread:t0:score:limit1'] = await captureList(db, userId, {
    scope: {},
    lane: 'all',
    status: 'unread',
    minTier: 0,
    sort: 'score',
    limit: 1,
  });

  // 2. Scopes.
  const scopes = scopesOf(world, key);
  for (const scope of scopes) {
    if (scopeName(scope) === 'global') continue;
    for (const lane of ['for_you', 'everything', 'new', 'all', 'hidden', 'bookmarks'] as const) {
      for (const status of ['unread', 'all'] as const) {
        const combo: ListCombo = {
          scope,
          lane,
          status,
          minTier: 0,
          sort: defaultSort(lane),
          limit: 20,
        };
        out[`list@${scopeName(scope)}:${lane}:${status}`] = await captureList(db, userId, combo);
      }
    }
  }

  // 3. Counts (the same scopes, both statuses, two tiers).
  for (const scope of scopes) {
    for (const status of ['unread', 'all'] as const) {
      for (const minTier of [0, 3]) {
        out[`counts@${scopeName(scope)}:${status}:t${minTier}`] = (await withTenant(
          db,
          userId,
          (tx) =>
            countArticles(tx, {
              scope,
              status,
              minTier,
              asOf: ANCHOR,
              scoreVersion: SCORE_VERSION,
            }),
        )) as unknown as Json;
      }
    }
  }
  for (const minTier of [0, 3]) {
    const unread = await withTenant(db, userId, (tx) =>
      countSubscriptionUnread(tx, { asOf: ANCHOR, minTier, scoreVersion: SCORE_VERSION }),
    );
    out[`subscription-unread:t${minTier}`] = [...unread.entries()].map(([feed, counts]) => ({
      feed,
      ...counts,
    }));
    out[`lane-mix:t${minTier}`] = (await withTenant(db, userId, (tx) =>
      readerLaneMix(tx, { asOf: ANCHOR, minTier }),
    )) as unknown as Json;
  }
  out['calibration'] = (
    await withTenant(db, userId, (tx) =>
      calibrationArticles(tx, { now: ANCHOR, scoreVersion: SCORE_VERSION }),
    )
  ).map(rowText);
  for (const [name, scope, lane, status] of [
    ['global-all-unread', {}, 'all', 'unread'],
    ['global-for_you-all', {}, 'for_you', 'all'],
    ['tech-all-unread', { folder: 'tech' }, 'all', 'unread'],
    ['bookmarks', {}, 'bookmarks', 'all'],
  ] as const) {
    out[`view-ids:${name}`] = (await withTenant(db, userId, (tx) =>
      articleViewIds(
        tx,
        { scope, lane, status, minTier: 0, asOf: ANCHOR, scoreVersion: SCORE_VERSION },
        { maxIds: 25 },
      ),
    )) as unknown as Json;
  }

  // 4. Item contexts (detail and action responses): every article, global and per source feed.
  const contextViews: (string | undefined)[] = [
    undefined,
    ...world.subs[key].map((s) => String(s.feed)),
    '12',
  ];
  for (const feed of contextViews) {
    const contexts = await withTenant(db, userId, (tx) =>
      articleContexts(tx, world.articleIds, feed === undefined ? {} : { sourceFeedId: feed }),
    );
    out[`contexts@${feed ?? 'global'}`] = contexts
      .map(rowText)
      .sort((a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]));
  }
  return out;
}

export async function captureGolden(db: Database, world: GoldenWorld): Promise<Golden> {
  const users = {} as Record<UserKey, GoldenSection>;
  for (const key of ['A', 'B', 'C'] as const) users[key] = await captureUser(db, world, key);
  return { version: 1, users };
}
