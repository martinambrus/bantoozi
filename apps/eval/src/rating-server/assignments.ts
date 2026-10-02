import {
  appendAssignments,
  copySampleRows,
  createDataset,
  headDataset,
  insertSampleRows,
  isExcludedArticle,
  listAssignments,
  listRaterCards,
  listRaterFeedIds,
  loadSample,
  lockDataset,
  lockDatasetAdditions,
  lockRater,
  lockTopUpArticles,
  unusedDatasetVersion,
  openDatasetForCorrection,
  recentUnsampledCandidates,
  sampleCandidates,
  versionExclusions,
  withoutExcludedRows,
  type AssignmentCandidate,
  type TopUpCandidate,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';

import { storyGroupId } from '../dataset/snapshot.js';
import { buildSampleRows } from '../dataset/topup.js';
import { countCards, readyToRate } from './steps.js';

/**
 * Assignment building (spec 10 §2.2, step 3). On first entry, and again whenever the rater has
 * nothing pending while short of the target, the rater receives up to {@link ASSIGNMENTS_PER_RATER}
 * articles:
 * - from `eval.sample` rows carried by the rater's picked feeds (frozen snapshots);
 * - split equally across the rater's languages, a short language topped up from the others;
 * - when the sample cannot fill the target, from recent non-sampled articles of the same feeds,
 *   which are first added to the dataset in the same transaction (they join the open head version,
 *   or create the next version once the head is frozen, so a frozen version never changes);
 * - in a seeded order derived from the rater id, so the same inputs always give the same queue.
 *
 * {@link planAssignments} is the pure part; {@link ensureAssignments} reads and writes the database.
 */

export const ASSIGNMENTS_PER_RATER = 300;
/** How far back the top-up pool reaches ("non-sampled recent articles"). */
export const TOP_UP_RECENT_DAYS = 30;

const DAY_MS = 86_400_000;

/** A seeded, stable sort key: SHA-256 of seed, purpose and id (hex, compared as strings). */
export function seededKey(seed: string, purpose: string, id: string): string {
  return sha256Hex(`${seed}\u0000${purpose}\u0000${id}`);
}

/** `ids` in a deterministic pseudo-random order for `seed` (a seeded shuffle). */
export function seededShuffle<T extends string>(
  ids: readonly T[],
  seed: string,
  purpose: string,
): T[] {
  return [...ids]
    .map((id) => ({ id, key: seededKey(seed, purpose, id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
    .map((entry) => entry.id);
}

/** The assignment seed of a rater ("shuffled deterministically, seeded by the rater id"). */
export function raterSeed(raterId: string): string {
  return `rater:${raterId}`;
}

/** Per-language shares of `target`: equal, the remainder going to the first languages. */
export function languageQuotas(langs: readonly string[], target: number): Map<string, number> {
  const unique = [...new Set(langs)];
  const quotas = new Map<string, number>();
  if (unique.length === 0) return quotas;
  const base = Math.floor(target / unique.length);
  const remainder = target - base * unique.length;
  unique.forEach((lang, i) => quotas.set(lang, base + (i < remainder ? 1 : 0)));
  return quotas;
}

export interface PlanAssignmentsInput {
  seed: string;
  langs: readonly string[];
  target: number;
  /** Already assigned articles (never picked again; they count toward their language's share). */
  existing: ReadonlyArray<{ articleId: string; lang: string | null }>;
  /** Candidate pools in priority order: the sample first, then the top-up pool. */
  pools: ReadonlyArray<readonly AssignmentCandidate[]>;
}

export interface PlannedPick {
  articleId: string;
  lang: string;
  /** Index of the pool it came from. */
  pool: number;
}

export interface AssignmentPlan {
  /** The new assignments in queue order (seeded shuffle), to append after the existing ones. */
  picks: PlannedPick[];
  quotas: Record<string, number>;
  /** How many the pools could not supply. */
  shortfall: number;
}

/**
 * Choose new assignments (pure). For each pool in priority order: first every language takes up to
 * its remaining equal share, then languages that still have candidates top up the others' shortfall
 * round-robin. A later pool is used only when the earlier ones are exhausted, so the sample is
 * always assigned in full before any top-up article. Within a pool and language the choice follows
 * the seeded order; the final queue order is a second seeded shuffle.
 */
export function planAssignments(input: PlanAssignmentsInput): AssignmentPlan {
  const langs = [...new Set(input.langs)];
  const quotas = languageQuotas(langs, input.target);
  const taken = new Set(input.existing.map((e) => e.articleId));
  const have = new Map<string, number>();
  for (const entry of input.existing) {
    if (entry.lang !== null) have.set(entry.lang, (have.get(entry.lang) ?? 0) + 1);
  }
  let remaining = Math.max(0, input.target - input.existing.length);
  const picks: PlannedPick[] = [];
  const pick = (candidate: AssignmentCandidate, pool: number) => {
    taken.add(candidate.articleId);
    have.set(candidate.lang, (have.get(candidate.lang) ?? 0) + 1);
    picks.push({ articleId: candidate.articleId, lang: candidate.lang, pool });
    remaining -= 1;
  };

  input.pools.forEach((pool, poolIndex) => {
    if (remaining <= 0) return;
    const byLang = new Map<string, AssignmentCandidate[]>();
    for (const lang of langs) byLang.set(lang, []);
    const seen = new Set<string>();
    for (const candidate of pool) {
      if (taken.has(candidate.articleId) || seen.has(candidate.articleId)) continue;
      const list = byLang.get(candidate.lang);
      if (list === undefined) continue; // not one of the rater's languages
      seen.add(candidate.articleId);
      list.push(candidate);
    }
    for (const [lang, list] of byLang) {
      const order = seededShuffle(
        list.map((c) => c.articleId),
        input.seed,
        `pick:${poolIndex}:${lang}`,
      );
      const byId = new Map(list.map((c) => [c.articleId, c]));
      byLang.set(
        lang,
        order.map((id) => byId.get(id)).filter((c): c is AssignmentCandidate => c !== undefined),
      );
    }
    // Phase A: equal shares.
    for (const lang of langs) {
      const list = byLang.get(lang) ?? [];
      let need = Math.max(0, (quotas.get(lang) ?? 0) - (have.get(lang) ?? 0));
      while (need > 0 && remaining > 0 && list.length > 0) {
        const next = list.shift();
        if (next === undefined) break;
        pick(next, poolIndex);
        need -= 1;
      }
    }
    // Phase B: languages with candidates left top up the others, round-robin.
    let progressed = true;
    while (remaining > 0 && progressed) {
      progressed = false;
      for (const lang of langs) {
        if (remaining <= 0) break;
        const next = byLang.get(lang)?.shift();
        if (next === undefined) continue;
        pick(next, poolIndex);
        progressed = true;
      }
    }
  });

  const order = seededShuffle(
    picks.map((p) => p.articleId),
    input.seed,
    `order:${input.existing.length}`,
  );
  const byId = new Map(picks.map((p) => [p.articleId, p]));
  return {
    picks: order.map((id) => byId.get(id)).filter((p): p is PlannedPick => p !== undefined),
    quotas: Object.fromEntries(quotas),
    shortfall: remaining,
  };
}

export interface EnsureAssignmentsResult {
  /** Assignments added by this call. */
  added: number;
  total: number;
  /** Articles added to the dataset as top-ups, and the version they went into. */
  toppedUp: string[];
  datasetVersion: string;
  /** The frozen version a top-up branched from, when it created `datasetVersion`. */
  createdFrom: string | null;
}

/** The rater's card or feed step is incomplete (checked under the rater lock). */
export class NotReadyError extends Error {
  constructor() {
    super('the rater has not finished the card and feed steps');
    this.name = 'NotReadyError';
  }
}

/**
 * A rater of an earlier round opened a held-out version (D-145). Assignments belong to the rater,
 * not to a version, and a context's cards are final once it has any: a held-out round is rated by
 * new contexts (`eval rater add --participant <key>`), whose cards are written for it.
 */
export class EarlierRoundError extends Error {
  constructor(readonly version: string) {
    super(`the rater's assignments belong to an earlier round than held-out ${version}`);
    this.name = 'EarlierRoundError';
  }
}

export class NoDatasetError extends Error {
  constructor() {
    super('no golden dataset yet: run `eval sample` first');
    this.name = 'NoDatasetError';
  }
}

/**
 * Add top-up articles inside the caller's transaction, as `addArticlesToDataset` does: under the
 * additions lock they join the open head version, or create the next version (copying the frozen
 * one) once the head is frozen. Lock order: the caller's rater row lock, then the additions lock,
 * then the dataset row; no path takes the additions lock before a rater lock.
 */
async function addTopUps(
  tx: Transaction,
  articleIds: readonly string[],
): Promise<{ added: string[]; createdFrom: string | null }> {
  await lockDatasetAdditions(tx);
  const head = await headDataset(tx);
  if (head === null) throw new NoDatasetError();
  let version = head.version;
  let createdFrom: string | null = null;
  const locked = await lockDataset(tx, head.version);
  if (locked !== null && locked.frozenAt !== null) {
    version = await unusedDatasetVersion(tx, head.version);
    await createDataset(tx, {
      version,
      parentVersion: head.version,
      seed: head.seed,
      params: { ...head.params, topUpOf: head.version },
    });
    await copySampleRows(tx, head.version, version);
    createdFrom = head.version;
  }
  const present = new Set((await loadSample(tx, version, { articleIds })).map((r) => r.articleId));
  const missing = [...new Set(articleIds)].filter((id) => !present.has(id));
  const built = await buildSampleRows(tx, version, head.seed, missing);
  // A held-out version never gains what it excludes (D-145); the pool already skipped them.
  const rows = await withoutExcludedRows(tx, version, built.rows);
  await insertSampleRows(tx, version, rows);
  return { added: rows.map((r) => r.articleId), createdFrom };
}

/**
 * Bring the rater's assignments up to `target` (idempotent; a no-op once the target is reached).
 * Everything happens in one transaction under the rater's row lock, which card and feed changes
 * also take: the picked feeds and the card and feed steps ({@link NotReadyError}) are read under
 * it, the top-up articles are chosen from those feeds and added to the dataset in the same
 * transaction, and the assignments are then chosen from the sample. So concurrent calls never
 * assign twice, a concurrent feed change can never add articles of a dropped feed, and a rejected
 * start adds nothing. A frozen head first gets its next open version, so a frozen version never
 * gains rows or assignments.
 */
export async function ensureAssignments(
  db: Database,
  input: {
    raterId: string;
    langs: readonly string[];
    now: Date;
    target?: number;
    recentDays?: number;
    /**
     * Check the card and feed steps (spec 10 §2.2) under the rater lock. The rating app always
     * passes true; synthetic callers (the dry run) build raters that skip the human steps.
     */
    requireReady?: boolean;
  },
): Promise<EnsureAssignmentsResult> {
  const target = input.target ?? ASSIGNMENTS_PER_RATER;
  const seed = raterSeed(input.raterId);
  return db.transaction(async (tx) => {
    if (!(await lockRater(tx, input.raterId))) throw new Error(`rater ${input.raterId} is gone`);
    // The additions lock before the head is read (rater lock first, as everywhere): a held-out draw
    // takes it too, so the head cannot change between the round check and the assignments
    // (D-145). The later takes in this transaction re-enter it.
    await lockDatasetAdditions(tx);
    const feedIds = await listRaterFeedIds(tx, input.raterId);
    if (input.requireReady === true) {
      const ready = readyToRate({
        ...countCards(await listRaterCards(tx, input.raterId)),
        feeds: feedIds.length,
        assignments: 0,
      });
      if (!ready) throw new NotReadyError();
    }
    let current = await headDataset(tx);
    if (current === null) throw new NoDatasetError();
    const existing = await listAssignments(tx, input.raterId, current.version);
    if (existing.length > 0 && (await versionExclusions(tx, current.version)).versions.length > 0) {
      const ids = existing.map((a) => a.articleId);
      const inVersion = await loadSample(tx, current.version, { articleIds: ids });
      if (inVersion.length < new Set(ids).size) throw new EarlierRoundError(current.version);
    }
    if (existing.length >= target) {
      return {
        added: 0,
        total: existing.length,
        toppedUp: [],
        datasetVersion: current.version,
        createdFrom: null,
      };
    }
    const choose = async (version: string, withTopUps: boolean) => {
      const sample = await sampleCandidates(tx, { version, langs: input.langs, feedIds });
      const pools: AssignmentCandidate[][] = [sample];
      if (withTopUps) {
        // A held-out version's exclusions (D-145) apply to the top-up pool too, so a skipped
        // article does not keep a slot the rater could have had.
        // With exclusions, excluded articles must not use up the slots of eligible older ones:
        // read the window in growing pages until every language has `target` eligible candidates
        // or the window is exhausted, then apply the per-language limit.
        const excluded = await versionExclusions(tx, version);
        const filtering = excluded.versions.length > 0;
        const since = new Date(
          input.now.getTime() - (input.recentDays ?? TOP_UP_RECENT_DAYS) * DAY_MS,
        );
        let limit = target;
        let eligible: TopUpCandidate[];
        for (;;) {
          const recent = await recentUnsampledCandidates(tx, {
            version,
            langs: input.langs,
            feedIds,
            since,
            limit,
          });
          eligible = filtering
            ? recent.filter((c) => !isExcludedArticle(excluded, c.articleId, storyGroupId(c)))
            : recent;
          const count = (list: readonly TopUpCandidate[], lang: string) =>
            list.filter((c) => c.lang === lang).length;
          // A language is done when it has `target` eligible candidates or its window ran out
          // (fewer rows than the page asked for).
          const done = input.langs.every(
            (lang) => count(eligible, lang) >= target || count(recent, lang) < limit,
          );
          if (!filtering || done) break;
          limit *= 4;
        }
        const perLang = new Map<string, number>();
        pools.push(
          eligible
            .filter((c) => {
              const n = (perLang.get(c.lang) ?? 0) + 1;
              perLang.set(c.lang, n);
              return n <= target;
            })
            .map((c) => ({ articleId: c.articleId, lang: c.lang })),
        );
      }
      return planAssignments({ seed, langs: input.langs, target, existing, pools });
    };
    let plan = await choose(current.version, true);
    let toppedUp: string[] = [];
    let createdFrom: string | null = null;
    // The top-up picks are share-locked and revalidated (language, pipeline state) before their
    // snapshots are built in this transaction: an article the ingest worker turned stale or failed
    // since the eligibility query is dropped, and the locked ones cannot change until commit.
    const topUpPicks = plan.picks.filter((p) => p.pool === 1);
    if (topUpPicks.length > 0) {
      const fallback = await lockTopUpArticles(tx, topUpPicks);
      if (fallback.length > 0) {
        const added = await addTopUps(tx, fallback);
        toppedUp = added.added;
        createdFrom = added.createdFrom;
        current = (await headDataset(tx)) ?? current;
      }
      // Choose again from the sample alone: the surviving top-ups are sample rows now (of the head
      // version, which may be new), and a rejected pick never reaches the sample, so it is dropped
      // rather than assigned without a sample row.
      plan = await choose(current.version, false);
    }
    let added = 0;
    if (plan.picks.length > 0) {
      // A frozen version's assignment membership is final (its manifest records it): new
      // assignments first open the next version of every lineage holding a picked article, which
      // copies the rows unchanged.
      const opened = await openDatasetForCorrection(
        tx,
        'assignments',
        plan.picks.map((p) => p.articleId),
      );
      if (opened !== null) {
        createdFrom ??= opened.createdFrom;
        current = (await headDataset(tx)) ?? current;
      }
      added = await appendAssignments(
        tx,
        input.raterId,
        plan.picks.map((p) => p.articleId),
      );
    }
    return {
      added,
      total: existing.length + added,
      toppedUp,
      datasetVersion: current.version,
      createdFrom,
    };
  });
}
