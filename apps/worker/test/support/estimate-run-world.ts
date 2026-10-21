import { deleteEstimateModels, insertEstimateModel, lockEstimateUser } from '@bantoozi/db';
import {
  DEFAULT_RANKER_CONFIG,
  ESTIMATE_SPEC,
  estimateFeatures,
  seededRandom,
  tierFromP,
  trainEstimateModel,
  type EstimateModel,
  type EstimateSample,
} from '@bantoozi/ranker';
import { parseJobPayload, type Explain } from '@bantoozi/shared';

import { createUserRankHandler, type UserRankOptions } from '../../src/handlers/user-rank.js';
import type { WorkerDeps } from '../../src/handlers/deps.js';
import { DAY, HOUR, MINUTE, ago, type ClassifyHarness } from './classify.js';

/**
 * EST-3b fixtures: a small world with every kind of row the estimate refresh meets (Off, Training,
 * over-cap and pending-card rows to estimate; analysed and rule-hidden rows to leave alone), models
 * written by hand so a test knows each row's P and tier, and the bulk scale world.
 */

// ── Hand-written models ──────────────────────────────────────────────────────────────────────────

/** One title word per probability: the model's weight for the word is the logit of its P. */
export const WORD_P = {
  alpha: 0.1,
  bravo: 0.3,
  cobalt: 0.55,
  delta: 0.7,
  epsilon: 0.9,
  foxtrot: 0.652,
} as const;
export type Word = keyof typeof WORD_P;
export const WORDS = Object.keys(WORD_P) as Word[];

const logit = (p: number): number => Math.log(p / (1 - p));

/** The model's key of a title word (`t:` + the stem). */
export function featureOf(word: Word): string {
  const features = estimateFeatures({ title: word, excerpt: null, feedId: null });
  const [feature] = features;
  if (features.length !== 1 || feature === undefined || !feature.startsWith('t:')) {
    throw new Error(`the word ${word} is not a single title feature`);
  }
  return feature;
}

export const tierOf = (p: number): number => tierFromP(p, DEFAULT_RANKER_CONFIG);

/** A model of the current spec scoring a title word as `p[word]` (intercept 0, identity Platt). */
export function buildModel(p: Readonly<Record<Word, number>> = WORD_P): EstimateModel {
  const weights: Record<string, number> = {};
  for (const word of WORDS) weights[featureOf(word)] = logit(p[word]);
  return {
    spec: ESTIMATE_SPEC,
    intercept: 0,
    weights: Object.fromEntries(Object.entries(weights).sort(([a], [b]) => (a < b ? -1 : 1))),
    platt: { a: 1, b: 0 },
    metrics: { n: 12, nPos: 6, nNeg: 6, folds: 0, auc: null, feeds: {} },
  };
}

/** `WORD_P` with some probabilities replaced. */
export const withP = (over: Partial<Record<Word, number>>): Record<Word, number> => ({
  ...WORD_P,
  ...over,
});

/** `WORD_P` with every probability moved by `delta` (the tiers stay). */
export function nudged(delta: number): Record<Word, number> {
  return Object.fromEntries(WORDS.map((word) => [word, WORD_P[word] + delta])) as Record<
    Word,
    number
  >;
}

/** Stores `model` as the user's next version, as `user.estimate` does, and returns the version. */
export async function storeModel(
  h: ClassifyHarness,
  userId: string,
  model: EstimateModel,
  spec: string = model.spec,
): Promise<number> {
  return h.db.transaction(async (tx) => {
    if (!(await lockEstimateUser(tx, userId))) throw new Error('the reader is gone');
    return insertEstimateModel(tx, {
      userId,
      spec,
      n: model.metrics.n,
      nPos: model.metrics.nPos,
      nNeg: model.metrics.nNeg,
      intercept: model.intercept,
      weights: model.weights,
      platt: model.platt,
      metrics: model.metrics,
    });
  });
}

export async function dropModels(h: ClassifyHarness, userId: string): Promise<void> {
  await h.db.transaction(async (tx) => {
    await lockEstimateUser(tx, userId);
    await deleteEstimateModels(tx, userId);
  });
}

export async function setEstimates(
  h: ClassifyHarness,
  userId: string,
  value: 'on' | 'off',
): Promise<void> {
  await h.owner.query(
    `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [userId, JSON.stringify({ estimates: value })],
  );
}

// ── Running the handler ──────────────────────────────────────────────────────────────────────────

export interface RankRun {
  log: Record<string, unknown>;
  outcome: string;
  ranked: number;
  written: number;
}

export interface RunOptions {
  /** Starts (or, with fields, continues) an estimate refresh. */
  estimate?: { version?: number; up?: number; down?: number };
  full?: boolean;
  now?: Date;
  /** A continuation payload recorded by an earlier run (its fields win). */
  continuation?: Record<string, unknown> | undefined;
  handler?: UserRankOptions;
  deps?: WorkerDeps;
}

/** Runs `user.rank` for the user and returns its summary log line. */
export async function runRank(
  h: ClassifyHarness,
  userId: string,
  options: RunOptions = {},
): Promise<RankRun> {
  const logs: Array<Record<string, unknown>> = [];
  const { now } = options;
  const handle = createUserRankHandler(
    {
      ...(options.deps ?? h.deps),
      logger: { info: (obj) => logs.push(obj as Record<string, unknown>), warn() {}, error() {} },
      ...(now === undefined ? {} : { now: () => now }),
    },
    options.handler,
  );
  await handle(
    parseJobPayload('user.rank', {
      userId,
      reason: options.estimate === undefined ? 'test' : 'estimate',
      ...(options.full === true ? { full: true } : {}),
      ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
      ...options.continuation,
    }),
    { queue: 'user.rank', jobId: 'test' },
  );
  const log = logs.find((entry) => entry['job'] === 'user.rank') ?? {};
  return {
    log,
    outcome: String(log['outcome'] ?? 'none'),
    ranked: Number(log['ranked'] ?? 0),
    written: Number(log['written'] ?? 0),
  };
}

/** The estimate refresh's continuation recorded after `since`, if any. */
export async function continuationOf(
  h: ClassifyHarness,
  userId: string,
  since: string,
): Promise<Record<string, unknown> | undefined> {
  const payloads = await h.payloads('user.rank', since);
  return payloads.find((p) => p['userId'] === userId && p['reason'] === 'continuation');
}

// ── Stored rows ──────────────────────────────────────────────────────────────────────────────────

export interface StoredRow {
  articleId: string;
  lane: string;
  tier: number | null;
  p: number | null;
  source: string;
  rules: string[];
  explain: Explain | null;
  scoredAt: Date | null;
  readAt: Date | null;
  labelSuggestions: string[];
}

export async function storedRows(
  h: ClassifyHarness,
  userId: string,
): Promise<Map<string, StoredRow>> {
  const result = await h.owner.query<{
    article_id: string;
    lane: string;
    tier: number | null;
    p_like: number | null;
    score_source: string;
    rules_fired: string[];
    explain: Explain | null;
    scored_at: Date | null;
    read_at: Date | null;
    label_suggestions: string[] | null;
  }>(
    `SELECT article_id::text AS article_id, lane, tier, p_like, score_source, rules_fired, explain,
            scored_at, read_at, label_suggestions::text[] AS label_suggestions
       FROM user_article WHERE user_id = $1`,
    [userId],
  );
  return new Map(
    result.rows.map((row) => [
      row.article_id,
      {
        articleId: row.article_id,
        lane: row.lane,
        tier: row.tier,
        p: row.p_like,
        source: row.score_source,
        rules: row.rules_fired,
        explain: row.explain,
        scoredAt: row.scored_at,
        readAt: row.read_at,
        labelSuggestions: row.label_suggestions ?? [],
      },
    ]),
  );
}

export async function storedRow(
  h: ClassifyHarness,
  userId: string,
  id: string,
): Promise<StoredRow> {
  const row = (await storedRows(h, userId)).get(id);
  if (row === undefined) throw new Error(`no stored row for ${id}`);
  return row;
}

/** A row's stored ranking as one comparable value (everything a run could write). */
export function fingerprint(row: StoredRow): string {
  return JSON.stringify([
    row.lane,
    row.tier,
    row.p,
    row.source,
    row.rules,
    row.explain,
    row.scoredAt?.toISOString() ?? null,
    row.labelSuggestions,
  ]);
}

export async function lastRunOf(
  h: ClassifyHarness,
  userId: string,
  version: number,
): Promise<{ at: string; movedUp: number; movedDown: number } | undefined> {
  const result = await h.owner.query<{
    last_run: { at: string; movedUp: number; movedDown: number } | null;
  }>(
    `SELECT metrics->'lastRun' AS last_run FROM user_estimate_models
      WHERE user_id = $1 AND version = $2`,
    [userId, version],
  );
  return result.rows[0]?.last_run ?? undefined;
}

// ── The small world ──────────────────────────────────────────────────────────────────────────────

/** `overCap`, `off` and `training` rows exit at 1b; `pending` rows at 4d. The rest are analysed. */
export type Kind = 'overCap' | 'off' | 'training' | 'pending' | 'cards' | 'degraded' | 'hidden';
export const ESTIMATE_KINDS = ['overCap', 'off', 'training', 'pending'] as const;
export type EstimateKind = (typeof ESTIMATE_KINDS)[number];

export const RULES_1B = ['inference_not_requested', 'estimate'];
export const RULES_4D = ['estimate'];
export const rulesOf = (kind: EstimateKind): string[] => (kind === 'pending' ? RULES_4D : RULES_1B);

export interface WorldRow {
  id: string;
  kind: Kind;
  word: Word | null;
}

const INTEREST = 'harbor crane automation';
let readers = 0;

/** One reader with an active, an off and a training feed and one held interest card. */
export class RunReader {
  private seq = 0;
  readonly rows: WorldRow[] = [];

  private constructor(
    readonly h: ClassifyHarness,
    readonly userId: string,
    readonly activeFeed: string,
    readonly offFeed: string,
    readonly trainingFeed: string,
    readonly cardId: string,
  ) {}

  static async create(h: ClassifyHarness): Promise<RunReader> {
    readers += 1;
    const userId = await h.user();
    const activeFeed = await h.feed(`Active ${readers}`);
    const offFeed = await h.feed(`Off ${readers}`);
    const trainingFeed = await h.feed(`Training ${readers}`);
    await h.subscribe(userId, activeFeed, 'active', ago(30 * DAY));
    await h.subscribe(userId, offFeed, 'off');
    await h.subscribe(userId, trainingFeed, 'training');
    const cardId = await h.heldCard(userId, { interest: `${INTEREST} ${readers}` });
    return new RunReader(h, userId, activeFeed, offFeed, trainingFeed, cardId);
  }

  /** Newest first in the order rows are added, all hours old (no input is within a recheck margin). */
  private nextArrival(): Date {
    this.seq += 1;
    return ago(2 * HOUR + this.seq * MINUTE);
  }

  /**
   * Adds one article of `kind`. `word` is the title word the hand-written model weighs; analysed
   * kinds carry their own titles. `read` marks the stored row read once it exists (see `markRead`).
   */
  async add(
    kind: Kind,
    word: Word | null,
    options: { title?: string; cardP?: number } = {},
  ): Promise<string> {
    const h = this.h;
    const firstSeenAt = this.nextArrival();
    const titleWord = word ?? 'plain';
    const title = options.title ?? `${titleWord} dispatch ${this.seq}`;
    let id: string;
    switch (kind) {
      case 'overCap':
        id = await h.article({ feedIds: [this.activeFeed], title, firstSeenAt });
        await h.owner.query(`UPDATE feed_items SET over_cap_limit = 800 WHERE article_id = $1`, [
          id,
        ]);
        break;
      case 'off':
        id = await h.article({ feedIds: [this.offFeed], title, firstSeenAt });
        break;
      case 'training':
        id = await h.article({ feedIds: [this.trainingFeed], title, firstSeenAt });
        break;
      case 'pending':
        id = await h.article({ feedIds: [this.activeFeed], title, firstSeenAt });
        await h.queue(id, [this.cardId]);
        break;
      case 'cards':
        id = await h.article({ feedIds: [this.activeFeed], title, firstSeenAt });
        await h.enrichDirect(id, { state: 'matched' });
        await h.answerCard(id, this.cardId, { engine: 'typesafe', p: options.cardP ?? 0.5 });
        break;
      case 'degraded':
        id = await h.article({
          feedIds: [this.activeFeed],
          state: 'degraded',
          title,
          excerpt: 'Ports automate their cranes.',
          firstSeenAt,
        });
        break;
      case 'hidden':
        id = await h.article({ feedIds: [this.activeFeed], title, firstSeenAt });
        break;
    }
    await h.owner.query(
      `UPDATE articles SET updated_at = now() - interval '3 hours' WHERE id = $1`,
      [id],
    );
    this.rows.push({ id, kind, word });
    return id;
  }

  async muteKeyword(value: string): Promise<void> {
    await this.h.owner.query(
      `INSERT INTO user_rules (user_id, kind, value) VALUES ($1, 'mute_keyword', $2)`,
      [this.userId, value],
    );
  }

  async markRead(articleId: string): Promise<void> {
    await this.h.owner.query(
      `UPDATE user_article SET read_at = now() WHERE user_id = $1 AND article_id = $2`,
      [this.userId, articleId],
    );
  }

  of(...kinds: Kind[]): WorldRow[] {
    return this.rows.filter((row) => kinds.includes(row.kind));
  }

  estimateRows(): WorldRow[] {
    return this.of(...ESTIMATE_KINDS);
  }

  analysedRows(): WorldRow[] {
    return this.of('cards', 'degraded', 'hidden');
  }

  /**
   * The standard small world: one row of every estimate kind for every word (24), three card
   * answers, a degraded row and a rule-hidden row, all ranked once without a model.
   */
  static async standard(h: ClassifyHarness): Promise<RunReader> {
    const r = await RunReader.create(h);
    for (const word of WORDS) {
      for (const kind of ESTIMATE_KINDS) await r.add(kind, word);
    }
    await r.muteKeyword('quarantine');
    await r.add('hidden', 'alpha', { title: 'quarantine alpha dispatch' });
    for (const [title, p] of [
      ['Harbor fees rise', 0.5],
      ['Crane makers merge', 0.9],
      ['Weather at sea', 0.2],
    ] as const) {
      await r.add('cards', null, { title, cardP: p });
    }
    await r.add('degraded', null, { title: 'Harbor crane automation spreads' });
    await runRank(h, r.userId);
    await r.assertUnscored();
    return r;
  }

  /** The plain run left every estimate-kind row as `{new, none}` and the analysed rows scored. */
  async assertUnscored(): Promise<void> {
    const stored = await storedRows(this.h, this.userId);
    for (const row of this.estimateRows()) {
      const found = stored.get(row.id);
      if (found?.lane !== 'new' || found.source !== 'none') {
        throw new Error(`world: ${row.kind} row ${row.id} is ${found?.lane}/${found?.source}`);
      }
    }
    const expect = { cards: 'cards', degraded: 'degraded', hidden: 'none' } as const;
    for (const row of this.analysedRows()) {
      const found = stored.get(row.id);
      const want = expect[row.kind as 'cards' | 'degraded' | 'hidden'];
      if (
        found === undefined ||
        found.source !== want ||
        (row.kind !== 'hidden' && found.lane === 'new')
      ) {
        throw new Error(`world: ${row.kind} row ${row.id} is ${found?.lane}/${found?.source}`);
      }
      if (row.kind === 'hidden' && found.lane !== 'hidden') throw new Error('world: hidden row');
    }
  }
}

// ── The scale world ──────────────────────────────────────────────────────────────────────────────

export const SCALE = {
  overCap: 9_000,
  training: 1_500,
  pending: 2_200,
  analysed: 3_500,
  /** Fraction of rows that are read. */
  readShare: 0.35,
  ratings: 5_000,
  vocabulary: 6_000,
} as const;
export const SCALE_CANDIDATES = SCALE.overCap + SCALE.training + SCALE.pending;

export interface ScaleArticle {
  id: string;
  kind: 'overCap' | 'training' | 'pending' | 'analysed';
  title: string;
  excerpt: string;
  feedId: string;
  read: boolean;
}

export interface ScaleWorld {
  userId: string;
  activeFeed: string;
  trainingFeed: string;
  articles: ScaleArticle[];
  candidates: ScaleArticle[];
  model1: EstimateModel;
  model2: EstimateModel;
  seedMs: number;
}

const SYLLABLES = (() => {
  const out: string[] = [];
  for (const c of 'bdfgklmnprstvz') for (const v of 'aeiou') out.push(c + v);
  return out;
})();

function vocabulary(size: number): string[] {
  const rand = seededRandom('scale-vocabulary');
  const words = new Set<string>();
  while (words.size < size) {
    const length = 2 + Math.floor(rand() * 3);
    let word = '';
    for (let i = 0; i < length; i += 1) {
      word += SYLLABLES[Math.floor(rand() * SYLLABLES.length)] ?? 'ba';
    }
    words.add(word);
  }
  return [...words];
}

/** Draws word indexes with Zipf weights `1 / (rank + 1)`. */
function zipf(size: number, rand: () => number): () => number {
  const cumulative = new Float64Array(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    total += 1 / (i + 1);
    cumulative[i] = total;
  }
  return () => {
    const x = rand() * total;
    let lo = 0;
    let hi = size - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] ?? 0) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

interface Text {
  title: string;
  excerpt: string;
  /** -1, 0 or 1: the lexicon the text leans on. */
  lean: -1 | 0 | 1;
}

function textGenerator(words: readonly string[], seed: string) {
  const rand = seededRandom(seed);
  const draw = zipf(words.length, rand);
  const word = () => words[draw()] ?? 'baba';
  const liked = words.slice(20, 80);
  const disliked = words.slice(100, 160);
  const pick = (lexicon: readonly string[]) =>
    lexicon[Math.floor(rand() * lexicon.length)] ?? 'baba';
  return (leanShare: number): Text => {
    const r = rand();
    const lean: -1 | 0 | 1 = r < leanShare ? 1 : r < 2 * leanShare ? -1 : 0;
    const title: string[] = [];
    const excerpt: string[] = [];
    const titleLength = 5 + Math.floor(rand() * 5);
    const excerptLength = 35 + Math.floor(rand() * 25);
    for (let i = 0; i < titleLength; i += 1) title.push(word());
    for (let i = 0; i < excerptLength; i += 1) excerpt.push(word());
    if (lean !== 0) {
      const lexicon = lean === 1 ? liked : disliked;
      title[Math.floor(rand() * titleLength)] = pick(lexicon);
      title[Math.floor(rand() * titleLength)] = pick(lexicon);
      for (let i = 0; i < 4; i += 1) excerpt[Math.floor(rand() * excerptLength)] = pick(lexicon);
    }
    return { title: title.join(' '), excerpt: excerpt.join(' '), lean };
  };
}

/** The trainer's input: 5,000 ratings over the same vocabulary, half of them leaning each way. */
function ratingSamples(words: readonly string[], feedIds: readonly string[]): EstimateSample[] {
  const make = textGenerator(words, 'scale-ratings');
  const rand = seededRandom('scale-rating-times');
  const samples: EstimateSample[] = [];
  const now = Date.now();
  for (let i = 0; i < SCALE.ratings; i += 1) {
    const text = make(0.3);
    const rating = text.lean === 1 ? 1 : text.lean === -1 ? -1 : rand() < 0.5 ? 1 : -1;
    samples.push({
      articleId: String(900_000 + i),
      rating,
      ratedAt: new Date(now - (1 + rand() * 120) * DAY),
      title: text.title,
      excerpt: text.excerpt,
      feedId: feedIds[Math.floor(rand() * feedIds.length)] ?? null,
    });
  }
  return samples;
}

/**
 * The second model of the scale world: the first one's weights with a small intercept shift (no row
 * moves by 0.01) and a few mid-frequency words re-weighted by 3 logits, so a few percent of the rows
 * change tier or P.
 */
function secondModel(first: EstimateModel, articles: readonly ScaleArticle[]): EstimateModel {
  const frequency = new Map<string, number>();
  for (const article of articles) {
    for (const feature of new Set(
      estimateFeatures({ title: article.title, excerpt: article.excerpt, feedId: null }),
    )) {
      frequency.set(feature, (frequency.get(feature) ?? 0) + 1);
    }
  }
  const chosen = Object.keys(first.weights)
    .filter((feature) => feature.startsWith('t:') || feature.startsWith('e:'))
    .filter((feature) => {
      const df = frequency.get(feature) ?? 0;
      return df >= 40 && df <= 160;
    })
    .slice(0, 6);
  const weights = { ...first.weights };
  chosen.forEach((feature, index) => {
    weights[feature] = (weights[feature] ?? 0) + (index % 2 === 0 ? 3 : -3);
  });
  return { ...first, intercept: first.intercept + 0.0005, weights };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

/**
 * One reader with 12,700 estimate-set rows (9,000 over-cap Active arrivals, 1,500 rows of a Training
 * feed and 2,200 pending-card Active arrivals, stored `{new, none}`), 3,500 analysed rows (stored card
 * results) and about 35 % of all rows read; articles are generated in JS from a Zipf vocabulary and
 * inserted in bulk, then the tables are ANALYZEd. The first model is the real trainer's over 5,000
 * synthetic ratings, the second a variation of it. Neither is stored.
 */
export async function buildScaleWorld(h: ClassifyHarness): Promise<ScaleWorld> {
  const started = Date.now();
  const userId = await h.user();
  const activeFeed = await h.feed('Scale active');
  const trainingFeed = await h.feed('Scale training');
  await h.subscribe(userId, activeFeed, 'active', ago(40 * DAY));
  await h.subscribe(userId, trainingFeed, 'training');
  const cardId = await h.heldCard(userId, { interest: 'harbor crane automation' });

  const words = vocabulary(SCALE.vocabulary);
  const make = textGenerator(words, 'scale-articles');
  const rand = seededRandom('scale-layout');
  const total = SCALE_CANDIDATES + SCALE.analysed;
  const kinds = shuffled(
    [
      ...Array.from({ length: SCALE.overCap }, () => 'overCap' as const),
      ...Array.from({ length: SCALE.training }, () => 'training' as const),
      ...Array.from({ length: SCALE.pending }, () => 'pending' as const),
      ...Array.from({ length: SCALE.analysed }, () => 'analysed' as const),
    ],
    rand,
  );
  const now = Date.now();
  const urls: string[] = [];
  const titles: string[] = [];
  const excerpts: string[] = [];
  const seen: string[] = [];
  const meta: Array<{ kind: ScaleArticle['kind']; read: boolean }> = [];
  for (let i = 0; i < total; i += 1) {
    const text = make(0.3);
    urls.push(`https://scale.example.test/a/${i}`);
    titles.push(text.title);
    excerpts.push(text.excerpt);
    seen.push(new Date(now - (i + 1) * 60_000).toISOString());
    meta.push({ kind: kinds[i] ?? 'overCap', read: rand() < SCALE.readShare });
  }

  await h.owner.query(
    `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                           content_hash, pipeline_state, lang, word_count)
     SELECT u.url, u.url, replace(u.url, 'https://', ''), u.title, u.title, u.excerpt,
            u.seen::timestamptz, encode(sha256(convert_to(u.url, 'UTF8')), 'hex'), 'extracted', 'en', 420
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(url, title, excerpt, seen)`,
    [urls, titles, excerpts, seen],
  );
  const inserted = await h.owner.query<{ id: string; url: string }>(
    `SELECT id::text AS id, url FROM articles WHERE url LIKE 'https://scale.example.test/a/%'`,
  );
  const idOfUrl = new Map(inserted.rows.map((row) => [row.url, row.id]));
  const articles: ScaleArticle[] = urls.map((url, i) => {
    const kind = meta[i]?.kind ?? 'overCap';
    return {
      id: idOfUrl.get(url) ?? '',
      kind,
      title: titles[i] ?? '',
      excerpt: excerpts[i] ?? '',
      feedId: kind === 'training' ? trainingFeed : activeFeed,
      read: meta[i]?.read ?? false,
    };
  });
  if (articles.some((article) => article.id === ''))
    throw new Error('the scale articles are missing');

  const ids = articles.map((article) => article.id);
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at, over_cap_limit)
     SELECT CASE WHEN x.kind = 'training' THEN $2::bigint ELSE $1::bigint END, x.id,
            'scale-' || x.id, a.first_seen_at, CASE WHEN x.kind = 'overCap' THEN 800 END
       FROM unnest($3::bigint[], $4::text[]) AS x(id, kind)
       JOIN articles a ON a.id = x.id`,
    [activeFeed, trainingFeed, ids, articles.map((article) => article.kind)],
  );
  const pending = articles.filter((article) => article.kind === 'pending').map((a) => a.id);
  await h.owner.query(
    `INSERT INTO match_queue (article_id, card_id, article_revision, priority)
     SELECT a.id, $2::bigint, a.content_revision, 5 FROM articles a WHERE a.id = ANY($1::bigint[])`,
    [pending, cardId],
  );

  const user = await h.owner.query<{ rank_revision: string }>(
    `SELECT rank_revision::text AS rank_revision FROM users WHERE id = $1`,
    [userId],
  );
  const revision = user.rows[0]?.rank_revision ?? '0';
  const stored = (kind: ScaleArticle['kind']) => articles.filter((a) => a.kind === kind);
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, score_version,
                               rank_revision, scored_at, read_at, rules_fired)
     SELECT $1, x.id, 'new', NULL, NULL, 'none', 'scale-seed', $3::bigint,
            now() - interval '1 day', CASE WHEN x.read THEN now() - interval '1 hour' END,
            CASE WHEN x.kind = 'pending' THEN ARRAY[]::text[]
                 ELSE ARRAY['inference_not_requested']::text[] END
       FROM unnest($2::bigint[], $4::text[], $5::boolean[]) AS x(id, kind, read)`,
    [
      userId,
      [...stored('overCap'), ...stored('training'), ...stored('pending')].map((a) => a.id),
      revision,
      [...stored('overCap'), ...stored('training'), ...stored('pending')].map((a) => a.kind),
      [...stored('overCap'), ...stored('training'), ...stored('pending')].map((a) => a.read),
    ],
  );
  const analysed = stored('analysed');
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, score_version,
                               rank_revision, scored_at, read_at)
     SELECT $1, x.id,
            CASE x.n % 3 WHEN 0 THEN 'for_you' WHEN 1 THEN 'maybe' ELSE 'everything' END,
            1 + (x.n % 5), 0.1 + (x.n % 9) / 10.0, 'cards', 'scale-seed', $3::bigint,
            now() - interval '1 day', CASE WHEN x.read THEN now() - interval '1 hour' END
       FROM unnest($2::bigint[], $4::boolean[]) WITH ORDINALITY AS x(id, read, n)`,
    [userId, analysed.map((a) => a.id), revision, analysed.map((a) => a.read)],
  );
  for (const table of ['articles', 'feed_items', 'match_queue', 'user_article', 'subscriptions']) {
    await h.owner.query(`ANALYZE ${table}`);
  }

  const model1Result = trainEstimateModel(ratingSamples(words, [activeFeed, trainingFeed]));
  if (!model1Result.ok) throw new Error('the scale ratings do not open the estimate gate');
  const model2 = secondModel(model1Result.model, articles);
  return {
    userId,
    activeFeed,
    trainingFeed,
    articles,
    candidates: articles.filter((article) => article.kind !== 'analysed'),
    model1: model1Result.model,
    model2,
    seedMs: Date.now() - started,
  };
}

export { DAY, HOUR, MINUTE };
