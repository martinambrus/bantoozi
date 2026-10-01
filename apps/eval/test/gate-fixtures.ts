import {
  createDataset,
  createRun,
  finishRun,
  freezeDataset,
  insertSampleRows,
  upsertRunAnswers,
  type Database,
} from '@bantoozi/db';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { createArticle, createCard, type Queryable } from '@bantoozi/testing';

import { createRng } from '../src/metrics/index.js';
import type { SampleInfo } from '../src/report/items.js';
import { parseRunData, type RawAnswer, type RawRun, type RunData } from '../src/report/run-data.js';

/**
 * Synthetic gate data (M3a-T7 tests): a sample, raters/contexts with a hidden per-article truth,
 * and runs whose zero-training scores follow that truth with an experiment-specific signal level.
 * Everything is seeded, so the expected decisions are stable.
 */
export interface FixtureRater {
  raterId: string;
  participantKey: string;
  contextName: string;
  langs: string[];
  cardLang: string;
}

export interface Fixture {
  sample: Map<string, SampleInfo>;
  sampleRows: {
    articleId: string;
    lang: string;
    split: 'dev' | 'test';
    snapshot: Record<string, unknown>;
  }[];
  raters: FixtureRater[];
  ratings: {
    raterId: string;
    articleId: string;
    rating: 1 | -1;
    reason: null;
    createdAt: string;
  }[];
  truth: Map<string, number>;
  cohort: { articleIds: string[]; sha: string };
  dataset: { version: string; snapshotSha: string; splitSha: string; seed: string };
  facetLabels: { labeler: string; articleId: string; questionKey: string; value: string }[];
  /** The interest card of each rater (one `like` card per context). */
  cardIdOf: (raterId: string) => string;
}

export const DATASET = {
  version: 'golden-v1',
  snapshotSha: 'a'.repeat(64),
  splitSha: 'b'.repeat(64),
  seed: 'fixture',
};

export function buildFixture(
  options: {
    perLang?: number;
    langs?: string[];
    raters?: FixtureRater[];
    firstId?: number;
    /** Real article ids to use, in order (integration tests). */
    articleIds?: readonly string[];
    cardIds?: Readonly<Record<string, string>>;
    dataset?: Fixture['dataset'];
  } = {},
): Fixture {
  const langs = options.langs ?? ['en', 'sk'];
  const perLang = options.perLang ?? 200;
  const raters = options.raters ?? [
    {
      raterId: '1',
      participantKey: 'owner',
      contextName: 'web',
      langs: ['en', 'sk'],
      cardLang: 'sk',
    },
    {
      raterId: '2',
      participantKey: 'owner',
      contextName: 'science',
      langs: ['en', 'sk'],
      cardLang: 'en',
    },
  ];
  const rng = createRng('fixture');
  const sample = new Map<string, SampleInfo>();
  const sampleRows: Fixture['sampleRows'] = [];
  const truth = new Map<string, number>();
  let id = options.firstId ?? 1000;
  for (const lang of langs) {
    for (let i = 0; i < perLang; i += 1) {
      id += 1;
      const articleId = options.articleIds?.[id - (options.firstId ?? 1000) - 1] ?? String(id);
      // Every tenth story has a duplicate in the next id (same group, same side).
      const group = `t${lang}${Math.floor(i / 2)}`;
      const split: 'dev' | 'test' = Math.floor(i / 2) % 10 < 7 ? 'dev' : 'test';
      const firstSeenAt = new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();
      const snapshot = { storyGroupId: group, firstSeenAt, input: { title: `Title ${articleId}` } };
      sample.set(articleId, {
        articleId,
        lang,
        split,
        storyGroupId: group,
        firstSeenAt: Date.parse(firstSeenAt),
        title: `Title ${articleId}`,
      });
      sampleRows.push({ articleId, lang, split, snapshot });
      truth.set(articleId, rng.next());
    }
  }
  const ratings: Fixture['ratings'] = [];
  for (const rater of raters) {
    for (const info of sample.values()) {
      if (!rater.langs.includes(info.lang)) continue;
      const t = truth.get(info.articleId) ?? 0;
      // Contexts disagree a little: the second context shifts its taste.
      const taste = rater.raterId === '2' ? (t + 0.15) % 1 : t;
      ratings.push({
        raterId: rater.raterId,
        articleId: info.articleId,
        rating: taste > 0.55 ? 1 : -1,
        reason: null,
        createdAt: '2026-09-20T10:00:00.000Z',
      });
    }
  }
  const articleIds = [...sample.keys()];
  const facetLabels: Fixture['facetLabels'] = [];
  for (const info of sample.values()) {
    const t = truth.get(info.articleId) ?? 0;
    facetLabels.push(
      {
        labeler: 'owner',
        articleId: info.articleId,
        questionKey: 'clickbait',
        value: t < 0.2 ? 'yes' : 'no',
      },
      {
        labeler: 'owner',
        articleId: info.articleId,
        questionKey: 'depth',
        value: String(Math.min(4, Math.floor(t * 5))),
      },
      {
        labeler: 'owner',
        articleId: info.articleId,
        questionKey: 'content_type',
        value: t < 0.5 ? 'news_report' : 'analysis',
      },
    );
  }
  return {
    sample,
    sampleRows,
    raters,
    ratings,
    truth,
    cohort: { articleIds, sha: canonicalSha256(articleIds) },
    dataset: options.dataset ?? DATASET,
    facetLabels,
    cardIdOf: (raterId) => options.cardIds?.[raterId] ?? `90${raterId}`,
  };
}

/** How an experiment's score relates to the rater's taste: signal weight, by language. */
export type Signal = (lang: string) => number;

export interface RunSpec {
  id: string;
  experiment: string;
  state?: 'none' | 'native' | 'lt' | 'glm';
  cards?: 'as_written' | 'english';
  signal: Signal;
  status?: 'complete' | 'partial';
  /** Share of score answers dropped (failed), per language. */
  missing?: (lang: string) => number;
  engine?: string;
  billedUsd?: number;
  /** Override the captured ratings (ground-truth mismatch). */
  ratings?: Fixture['ratings'];
  cohortSha?: string;
  snapshotSha?: string;
}

export function makeRun(fixture: Fixture, spec: RunSpec): RunData {
  const raw = makeRawRun(fixture, spec);
  return parseRunData(raw.run, raw.answers);
}

/** The stored form of a fixture run: the `eval.runs` row and its answers. */
export function makeRawRun(fixture: Fixture, spec: RunSpec): { run: RawRun; answers: RawAnswer[] } {
  const rng = createRng(`run:${spec.experiment}:${spec.id}`);
  const answers: RawAnswer[] = [];
  const coverage: Record<string, { expected: number; valid: number }> = {};
  for (const rating of fixture.ratings) {
    const info = fixture.sample.get(rating.articleId);
    if (info === undefined) continue;
    const t = fixture.truth.get(rating.articleId) ?? 0;
    const taste = rating.raterId === '2' ? (t + 0.15) % 1 : t;
    const s = spec.signal(info.lang);
    const p = Math.min(1, Math.max(0, s * taste + (1 - s) * rng.next()));
    const missing = (spec.missing?.(info.lang) ?? 0) > rng.next();
    const cov = (coverage[info.lang] ??= { expected: 0, valid: 0 });
    cov.expected += 1;
    if (!missing) cov.valid += 1;
    const cardId = fixture.cardIdOf(rating.raterId);
    answers.push({
      articleId: rating.articleId,
      cardId: null,
      questionKey: `score.r${rating.raterId}`,
      answer: { score: missing ? null : 0.8 * p, source: 'cards' },
    });
    answers.push({
      articleId: rating.articleId,
      cardId,
      questionKey: 'card',
      answer: missing
        ? { ok: false, reason: 'timeout' }
        : { ok: true, p, engine: spec.engine ?? 'typesafe', model: 'jev-1.13.0', cached: false },
    });
  }
  for (const info of fixture.sample.values()) {
    const t = fixture.truth.get(info.articleId) ?? 0;
    const s = spec.signal(info.lang);
    answers.push(
      {
        articleId: info.articleId,
        cardId: null,
        questionKey: 'enrich.clickbait',
        answer: {
          ok: true,
          answer: { type: 'noul', p: Math.min(1, Math.max(0, s * (1 - t) + (1 - s) * rng.next())) },
        },
      },
      {
        articleId: info.articleId,
        cardId: null,
        questionKey: 'enrich.depth',
        answer: {
          ok: true,
          answer: {
            type: 'score',
            score: Math.min(4, Math.floor(t * 5)),
            probabilities: [0.2, 0.2, 0.2, 0.2, 0.2],
            confidence: 0.5,
            levels: 5,
          },
        },
      },
      {
        articleId: info.articleId,
        cardId: null,
        questionKey: 'enrich.content_type',
        answer: {
          ok: true,
          answer: {
            type: 'choice',
            choice: t < 0.5 ? 'news_report' : 'opinion',
            probabilities: { news_report: 1 - t, opinion: t },
            confidence: 0.7,
          },
        },
      },
    );
  }
  const cards = fixture.raters.map((r) => ({
    raterId: r.raterId,
    cardId: fixture.cardIdOf(r.raterId),
    strength: 'like',
    lang: r.cardLang,
    interest: 'something',
  }));
  return {
    run: {
      id: spec.id,
      experiment: spec.experiment,
      datasetVersion: fixture.dataset.version,
      gitSha: 'f'.repeat(40),
      startedAt: new Date('2026-09-25T00:00:00Z'),
      finishedAt: new Date('2026-09-25T01:00:00Z'),
      config: {
        experiment: spec.experiment,
        variant: { state: spec.state ?? 'native', cards: spec.cards ?? 'as_written' },
        datasetVersion: fixture.dataset.version,
        snapshotSha: spec.snapshotSha ?? fixture.dataset.snapshotSha,
        splitSha: fixture.dataset.splitSha,
        configSha: 'c'.repeat(64),
        seed: 'fixture',
        engine: {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          requiredEngine: 'typesafe',
          pricePerMTokUsd: 0.042,
        },
        langs: [...new Set([...fixture.sample.values()].map((s) => s.lang))].sort(),
        raters: fixture.raters.map(({ raterId, participantKey, contextName, langs }) => ({
          raterId,
          participantKey,
          contextName,
          langs,
        })),
        cohort: { ...fixture.cohort, sha: spec.cohortSha ?? fixture.cohort.sha },
        ratings: spec.ratings ?? fixture.ratings,
        cards,
        facetLabels: fixture.facetLabels,
        maxUsd: 10,
      },
      results: {
        status: spec.status ?? 'complete',
        coverage: { byLang: coverage, byRater: {} },
        cost: {
          estimatedUsd: 0.5,
          billedUsd: spec.billedUsd ?? 0.4,
          cacheHits: 0,
          cacheMisses: 10,
          cacheSavingsUsd: 0.1,
          failedCallUsd: 0,
          tokens: { input: 1000, output: 100 },
        },
        latencyMs: { card: { p50: 120, p95: 300, n: 10 } },
        cacheLookupMs: { p50: 1, p95: 2, n: 10 },
      },
    },
    answers,
  };
}

/** A standard set: B0 noise, B1 and B1-T weak, E1–E4 strong (overrides change any of them). */
export function standardRuns(
  fixture: Fixture,
  overrides: Partial<Record<string, Partial<RunSpec>>> = {},
): RunData[] {
  return standardSpecs(overrides).map((spec) => makeRun(fixture, spec));
}

export function standardSpecs(
  overrides: Partial<Record<string, Partial<RunSpec>>> = {},
): RunSpec[] {
  const specs: RunSpec[] = [
    { id: '11', experiment: 'B0', state: 'none', signal: () => 0 },
    { id: '12', experiment: 'B1', signal: () => 0.3 },
    { id: '13', experiment: 'B1-T', state: 'lt', signal: () => 0.3 },
    { id: '14', experiment: 'E1', signal: () => 0.85 },
    { id: '15', experiment: 'E2', cards: 'english', signal: () => 0.85 },
    { id: '16', experiment: 'E3', state: 'lt', signal: () => 0.85 },
    { id: '17', experiment: 'E3b', state: 'lt', cards: 'english', signal: () => 0.85 },
    { id: '18', experiment: 'E4', state: 'glm', signal: () => 0.85 },
  ];
  return specs.map((spec) => ({ ...spec, ...(overrides[spec.experiment] ?? {}) }));
}

// ── Integration seeding ──────────────────────────────────────────────────────────────────────

export interface SeededGateDb {
  fixture: Fixture;
  /** Experiment → stored run id. */
  runIds: Record<string, string>;
}

/**
 * A frozen `golden-v1` with real articles and cards, and the standard runs stored through the run
 * repository (as the runner writes them). Uses the owner pool for fixtures and the worker database
 * for the eval tables.
 */
export async function seedGateDatabase(
  owner: Queryable,
  db: Database,
  options: { perLang?: number; overrides?: Partial<Record<string, Partial<RunSpec>>> } = {},
): Promise<SeededGateDb> {
  const perLang = options.perLang ?? 200;
  const articleIds: string[] = [];
  for (let i = 0; i < 2 * perLang; i += 1) {
    articleIds.push((await createArticle(owner, { title: `Gate article ${i}` })).id);
  }
  const card1 = await createCard(owner, { lang: 'sk', interest: 'Webový vývoj' });
  const card2 = await createCard(owner, { lang: 'en', interest: 'Space science' });
  const draft = buildFixture({ perLang, articleIds, cardIds: { '1': card1.id, '2': card2.id } });
  const frozen = await db.transaction(async (tx) => {
    await createDataset(tx, { version: DATASET.version, seed: DATASET.seed, params: {} });
    await insertSampleRows(
      tx,
      DATASET.version,
      draft.sampleRows.map((row) => ({
        articleId: row.articleId,
        lang: row.lang,
        snapshot: row.snapshot,
        snapshotSha: canonicalSha256(row.snapshot),
        split: row.split,
      })),
    );
    return freezeDataset(tx, DATASET.version);
  });
  const fixture: Fixture = {
    ...draft,
    dataset: {
      version: frozen.version,
      snapshotSha: frozen.snapshotSha ?? '',
      splitSha: frozen.splitSha ?? '',
      seed: frozen.seed,
    },
  };
  const runIds: Record<string, string> = {};
  for (const spec of standardSpecs(options.overrides)) {
    const raw = makeRawRun(fixture, spec);
    const run = await createRun(db, {
      experiment: raw.run.experiment,
      datasetVersion: raw.run.datasetVersion,
      config: raw.run.config,
      gitSha: raw.run.gitSha,
    });
    await upsertRunAnswers(db, run.id, raw.answers);
    await finishRun(db, run.id, raw.run.results ?? {});
    runIds[spec.experiment] = run.id;
  }
  return { fixture, runIds };
}
