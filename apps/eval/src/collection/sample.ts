import {
  copySampleRows,
  createDataset,
  evalUserId,
  headDataset,
  insertSampleRows,
  loadSample,
  loadSampleCandidates,
  lockDataset,
  lockDatasetAdditions,
  nextDatasetVersion,
  SAMPLE_EXCLUDED_STATES,
  updateDatasetParams,
  type Database,
  type DatasetRow,
  type SampleCandidate,
} from '@bantoozi/db';

import { asSnapshot } from '../dataset/snapshot.js';
import { buildSampleRows } from '../dataset/topup.js';
import { selectLanguageSample, type SelectItem, type SelectResult } from './select.js';

/**
 * `eval sample` (spec 10 §2.1): draw the golden dataset version from the collected articles of the
 * evaluation user's feeds. Per detected language up to `perLang` (500) non-stale, extracted
 * articles, stratified across feeds and collection days with no feed above `feedCapShare` (10 %) of
 * the language sample; every drawn article gets its frozen snapshot and story-grouped split
 * (`buildSampleRows`). The seed, timestamps, availability and exclusions are recorded in the
 * version's `params.sampling`.
 *
 * Re-running is safe: an open version keeps every row and only gains articles the draw now adds
 * (none when nothing changed, so a re-run on the same data writes nothing); a frozen version is
 * never touched — without `--version` the draw goes to the next version, which starts as a copy of
 * the frozen one (spec 02 §7), and it is created only when it would add articles.
 *
 * Because the rows are kept, a re-run may only widen the recorded parameters: more languages (a
 * superset), a higher per-language target or a higher feed cap. The kept rows still satisfy every
 * widened constraint, and the draw only tops the sample up. Anything else (dropping a language,
 * lowering the target or the cap) would leave rows that violate the recorded parameters. That is
 * refused with a pointer to `--version <new>`, which starts a new lineage (D-98 addendum).
 */

export const DEFAULT_PER_LANG = 500;
export const DEFAULT_FEED_CAP_SHARE = 0.1;
export const DEFAULT_LANGS = ['en', 'sk', 'cs'] as const;
export const FIRST_VERSION = 'golden-v1';

export interface SampleOptions {
  /** Target version; default: the open head, the next version after a frozen head, or golden-v1. */
  version?: string;
  /** Default: the version's stored seed, else the version name. */
  seed?: string;
  perLang?: number;
  langs?: readonly string[];
  feedCapShare?: number;
}

export interface LangSampleReport extends Omit<SelectResult, 'added'> {
  lang: string;
  target: number;
  added: number;
  excluded: { pending: number; stale: number; failed: number };
}

export interface SampleExclusions {
  /** Eligible-state articles in a language outside `langs`, per language. */
  otherLang: Record<string, number>;
  /** Articles without a detected language. */
  undetected: number;
}

export type SampleOutcome =
  | { status: 'frozen'; version: string }
  | {
      status: 'sampled' | 'unchanged';
      version: string;
      /** The frozen version the new one was copied from. */
      createdFrom: string | null;
      created: boolean;
      seed: string;
      langs: LangSampleReport[];
      exclusions: SampleExclusions;
      added: number;
      /** Articles that could not be snapshotted (gone or no language) and were not added. */
      skipped: string[];
    };

export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleError';
  }
}

const dayOf = (date: Date | string): string =>
  (typeof date === 'string' ? date : date.toISOString()).slice(0, 10);

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function langsParam(params: Record<string, unknown>): string[] | undefined {
  const value = params['langs'];
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

interface SamplingParams {
  perLang: number;
  feedCapShare: number;
  langs: readonly string[];
}

/**
 * Why `next` cannot be applied to a version whose rows were drawn with `stored`, or null when it
 * only widens them (a superset of languages, a target or cap at least as high). A parameter the
 * version never recorded constrains nothing.
 */
export function incompatibleSampling(
  stored: Record<string, unknown>,
  next: SamplingParams,
): string | null {
  const reasons: string[] = [];
  const langs = langsParam(stored);
  if (langs !== undefined) {
    const dropped = langs.filter((lang) => !next.langs.includes(lang));
    if (dropped.length > 0) {
      reasons.push(
        `languages ${langs.join(',')} (now ${next.langs.join(',')}: drops ${dropped.join(',')})`,
      );
    }
  }
  const perLang = numberParam(stored, 'perLang');
  if (perLang !== undefined && next.perLang < perLang) {
    reasons.push(`--per-lang ${perLang} (now ${next.perLang})`);
  }
  const feedCapShare = numberParam(stored, 'feedCapShare');
  if (feedCapShare !== undefined && next.feedCapShare < feedCapShare) {
    reasons.push(`--feed-cap ${feedCapShare} (now ${next.feedCapShare})`);
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}

function sameSampling(stored: Record<string, unknown>, next: SamplingParams): boolean {
  const langs = langsParam(stored);
  return (
    numberParam(stored, 'perLang') === next.perLang &&
    numberParam(stored, 'feedCapShare') === next.feedCapShare &&
    langs !== undefined &&
    langs.length === next.langs.length &&
    langs.every((lang, i) => lang === next.langs[i])
  );
}

export async function drawSample(
  db: Database,
  options: SampleOptions,
  now: Date,
): Promise<SampleOutcome> {
  return db.transaction(async (tx) => {
    await lockDatasetAdditions(tx);
    const userId = await evalUserId(tx);
    if (userId === null) {
      throw new SampleError(
        'this database has no evaluation user, so nothing was collected: run `eval ingest-sample` first',
      );
    }

    // The version to fill: `base` holds the rows the draw starts from.
    let base: DatasetRow | null;
    let version: string;
    let parent: DatasetRow | null = null;
    if (options.version !== undefined) {
      base = await lockDataset(tx, options.version);
      version = options.version;
      if (base !== null && base.frozenAt !== null) return { status: 'frozen', version };
    } else {
      const head = await headDataset(tx);
      base = head === null ? null : await lockDataset(tx, head.version);
      if (base === null) {
        version = FIRST_VERSION;
      } else if (base.frozenAt !== null) {
        parent = base;
        version = nextDatasetVersion(base.version);
      } else {
        version = base.version;
      }
    }
    const stored = base?.params ?? {};
    const seed = base?.seed ?? options.seed ?? version;
    if (options.seed !== undefined && options.seed !== seed) {
      throw new SampleError(
        `${base?.version ?? version} was drawn with seed "${seed}"; a different seed needs a new --version`,
      );
    }
    const perLang = options.perLang ?? numberParam(stored, 'perLang') ?? DEFAULT_PER_LANG;
    const feedCapShare =
      options.feedCapShare ?? numberParam(stored, 'feedCapShare') ?? DEFAULT_FEED_CAP_SHARE;
    const langs = [...new Set(options.langs ?? langsParam(stored) ?? DEFAULT_LANGS)];
    if (base !== null) {
      // The draw keeps `base`'s rows (an open version's own, or a frozen head's copied ones).
      const conflict = incompatibleSampling(stored, { perLang, feedCapShare, langs });
      if (conflict !== null) {
        throw new SampleError(
          `${base.version} was sampled with ${conflict}. A re-run keeps its rows, so it may only ` +
            'add languages or raise --per-lang or --feed-cap; start a new lineage with ' +
            '`--version <new>` to sample with these parameters',
        );
      }
    }

    const existingRows = base === null ? [] : await loadSample(tx, base.version);
    const candidates = await loadSampleCandidates(tx, userId);
    const candidateById = new Map<string, SampleCandidate>(candidates.map((c) => [c.articleId, c]));
    const existingIds = new Set(existingRows.map((r) => r.articleId));

    const existing = new Map<string, SelectItem[]>();
    for (const row of existingRows) {
      const snapshot = asSnapshot(row.snapshot);
      const list = existing.get(row.lang) ?? [];
      list.push({
        articleId: row.articleId,
        feedId: candidateById.get(row.articleId)?.feedId ?? snapshot.canonicalFeedId ?? '',
        day: dayOf(snapshot.firstSeenAt),
      });
      existing.set(row.lang, list);
    }

    const fresh = new Map<string, SelectItem[]>(langs.map((l) => [l, []]));
    const excluded = new Map(langs.map((l) => [l, { pending: 0, stale: 0, failed: 0 }]));
    const exclusions: SampleExclusions = { otherLang: {}, undetected: 0 };
    let windowFrom: Date | null = null;
    let windowTo: Date | null = null;
    for (const c of candidates) {
      if (existingIds.has(c.articleId)) continue;
      if (c.lang === null || c.lang === 'und') {
        exclusions.undetected += 1;
        continue;
      }
      const pool = fresh.get(c.lang);
      const counts = excluded.get(c.lang);
      if (pool === undefined || counts === undefined) {
        exclusions.otherLang[c.lang] = (exclusions.otherLang[c.lang] ?? 0) + 1;
        continue;
      }
      const state = c.pipelineState as (typeof SAMPLE_EXCLUDED_STATES)[number];
      if (SAMPLE_EXCLUDED_STATES.includes(state)) {
        counts[state === 'ingested' ? 'pending' : state] += 1;
        continue;
      }
      pool.push({ articleId: c.articleId, feedId: c.feedId, day: dayOf(c.firstSeenAt) });
      if (windowFrom === null || c.firstSeenAt < windowFrom) windowFrom = c.firstSeenAt;
      if (windowTo === null || c.firstSeenAt > windowTo) windowTo = c.firstSeenAt;
    }

    const reports: LangSampleReport[] = [];
    const addedIds: string[] = [];
    for (const lang of langs) {
      const result = selectLanguageSample({
        fresh: fresh.get(lang) ?? [],
        existing: existing.get(lang) ?? [],
        target: perLang,
        feedCapShare,
        seed: `${seed}\u0000${lang}`,
      });
      addedIds.push(...result.added);
      const { added, ...rest } = result;
      reports.push({
        lang,
        target: perLang,
        ...rest,
        added: added.length,
        excluded: excluded.get(lang) ?? { pending: 0, stale: 0, failed: 0 },
      });
    }

    const createdFrom = parent?.version ?? null;
    const common = { version, createdFrom, seed, langs: reports, exclusions };
    if (addedIds.length === 0) {
      if (base === null) {
        throw new SampleError(
          `no eligible articles for ${langs.join(', ')} yet: let ingest-sample collect first`,
        );
      }
      // A widened open version records its parameters even when nothing new could be drawn.
      if (base.frozenAt === null && !sameSampling(stored, { perLang, feedCapShare, langs })) {
        await updateDatasetParams(tx, version, { perLang, feedCapShare, langs });
      }
      // Nothing was drawn: no successor of a frozen head exists, so report the version kept.
      return {
        status: 'unchanged',
        ...common,
        version: parent?.version ?? version,
        createdFrom: null,
        created: false,
        added: 0,
        skipped: [],
      };
    }

    const created = base === null || parent !== null;
    if (created) {
      await createDataset(tx, {
        version,
        parentVersion: parent?.version ?? null,
        seed,
        params: {
          ...(parent === null ? {} : parent.params),
          kind: 'golden',
          perLang,
          feedCapShare,
          langs,
          ...(parent === null ? {} : { sampleOf: parent.version }),
          sampling: [],
        },
      });
      if (parent !== null) await copySampleRows(tx, parent.version, version);
    }

    const { rows, skipped } = await buildSampleRows(tx, version, seed, addedIds);
    await insertSampleRows(tx, version, rows);

    const current = await lockDataset(tx, version);
    const history = Array.isArray(current?.params['sampling']) ? current.params['sampling'] : [];
    await updateDatasetParams(tx, version, {
      perLang,
      feedCapShare,
      langs,
      sampling: [
        ...history,
        {
          at: now.toISOString(),
          seed,
          perLang,
          feedCapShare,
          added: rows.length,
          candidateWindow: {
            from: windowFrom?.toISOString() ?? null,
            to: windowTo?.toISOString() ?? null,
          },
          byLang: Object.fromEntries(
            reports.map((r) => [
              r.lang,
              {
                target: r.target,
                available: r.available,
                size: r.size,
                cap: r.cap,
                added: r.added,
                notDrawn: r.available - r.size,
                excluded: r.excluded,
                feeds: r.feeds,
                days: r.days,
              },
            ]),
          ),
          exclusions: { ...exclusions, skipped },
        },
      ],
    });
    return { status: 'sampled', ...common, created, added: rows.length, skipped };
  });
}

/** The human-readable summary of a draw. */
export function formatSampleOutcome(outcome: SampleOutcome): string {
  if (outcome.status === 'frozen') {
    return (
      `${outcome.version} is frozen (a model run used it) and stays unchanged; ` +
      'run `eval sample` without --version to draw into the next version\n'
    );
  }
  const lines: string[] = [];
  const what =
    outcome.status === 'unchanged'
      ? `${outcome.version}: unchanged (nothing new to draw)`
      : outcome.created
        ? `${outcome.version}: created${outcome.createdFrom === null ? '' : ` from frozen ${outcome.createdFrom}`}, ${outcome.added} article(s) added`
        : `${outcome.version}: ${outcome.added} article(s) added`;
  lines.push(`${what} (seed "${outcome.seed}")`);
  lines.push('lang  sample/target  available  feeds  cap  added  pending  stale  failed');
  for (const r of outcome.langs) {
    const short = r.size < r.target ? '  SHORT' : '';
    lines.push(
      [
        r.lang.padEnd(4),
        `${r.size}/${r.target}`.padStart(13),
        String(r.available).padStart(9),
        String(r.feeds.length).padStart(6),
        String(r.cap).padStart(4),
        String(r.added).padStart(6),
        String(r.excluded.pending).padStart(8),
        String(r.excluded.stale).padStart(6),
        String(r.excluded.failed).padStart(7),
      ].join(' ') + short,
    );
  }
  const other = Object.entries(outcome.exclusions.otherLang)
    .map(([lang, n]) => `${lang} ${n}`)
    .join(', ');
  lines.push(
    `excluded: ${outcome.exclusions.undetected} without a detected language` +
      (other === '' ? '' : `; other languages: ${other}`),
  );
  for (const r of outcome.langs) {
    if (r.size >= r.target) continue;
    const top = [...r.feeds]
      .sort((a, b) => b.available - a.available)
      .slice(0, 5)
      .map((f) => `feed ${f.feedId}: ${f.selected}/${f.available}`)
      .join(', ');
    lines.push(
      `${r.lang}: only ${r.size} of ${r.target} under the ${r.cap}-per-feed cap ` +
        `(${r.available} eligible across ${r.feeds.length} feeds; largest: ${top || 'none'})`,
    );
  }
  if (outcome.status === 'sampled' && outcome.skipped.length > 0) {
    lines.push(`skipped (gone or no language): ${outcome.skipped.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}
