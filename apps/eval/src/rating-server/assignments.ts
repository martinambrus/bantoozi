import {
  appendAssignments,
  headDataset,
  listAssignments,
  listRaterFeedIds,
  lockRater,
  recentUnsampledCandidates,
  sampleCandidates,
  type AssignmentCandidate,
  type Database,
} from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';

import { addArticlesToDataset } from '../dataset/topup.js';

/**
 * Assignment building (spec 10 §2.2, step 3). On first entry, and again whenever the rater has
 * nothing pending while short of the target, the rater receives up to {@link ASSIGNMENTS_PER_RATER}
 * articles:
 * - from `eval.sample` rows carried by the rater's picked feeds (frozen snapshots);
 * - split equally across the rater's languages, a short language topped up from the others;
 * - when the sample cannot fill the target, from recent non-sampled articles of the same feeds,
 *   which are first added to the dataset (`addArticlesToDataset`: they join the open head version,
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

export class NoDatasetError extends Error {
  constructor() {
    super('no golden dataset yet: run `eval sample` first');
    this.name = 'NoDatasetError';
  }
}

/**
 * Bring the rater's assignments up to `target` (idempotent; a no-op once the target is reached).
 * The top-up articles are added to the dataset first (their own transaction, serialized by the
 * dataset lock), then the assignments are chosen again from the sample under the rater's row lock,
 * so concurrent calls never assign twice.
 */
export async function ensureAssignments(
  db: Database,
  input: {
    raterId: string;
    langs: readonly string[];
    now: Date;
    target?: number;
    recentDays?: number;
  },
): Promise<EnsureAssignmentsResult> {
  const target = input.target ?? ASSIGNMENTS_PER_RATER;
  const seed = raterSeed(input.raterId);
  const head = await headDataset(db);
  if (head === null) throw new NoDatasetError();
  const feedIds = await listRaterFeedIds(db, input.raterId);
  const existing = await listAssignments(db, input.raterId, head.version);
  let toppedUp: string[] = [];
  let createdFrom: string | null = null;
  if (existing.length < target) {
    const sample = await sampleCandidates(db, {
      version: head.version,
      langs: input.langs,
      feedIds,
    });
    const recent = await recentUnsampledCandidates(db, {
      version: head.version,
      langs: input.langs,
      feedIds,
      since: new Date(input.now.getTime() - (input.recentDays ?? TOP_UP_RECENT_DAYS) * DAY_MS),
      limit: target,
    });
    const plan = planAssignments({
      seed,
      langs: input.langs,
      target,
      existing,
      pools: [sample, recent],
    });
    const fallback = plan.picks.filter((p) => p.pool === 1).map((p) => p.articleId);
    if (fallback.length > 0) {
      const added = await addArticlesToDataset(db, fallback);
      toppedUp = added.added;
      createdFrom = added.createdFrom;
    }
  }
  return db.transaction(async (tx) => {
    if (!(await lockRater(tx, input.raterId))) throw new Error(`rater ${input.raterId} is gone`);
    const current = await headDataset(tx);
    if (current === null) throw new NoDatasetError();
    const assigned = await listAssignments(tx, input.raterId, current.version);
    let added = 0;
    if (assigned.length < target) {
      const sample = await sampleCandidates(tx, {
        version: current.version,
        langs: input.langs,
        feedIds,
      });
      const plan = planAssignments({
        seed,
        langs: input.langs,
        target,
        existing: assigned,
        pools: [sample],
      });
      added = await appendAssignments(
        tx,
        input.raterId,
        plan.picks.map((p) => p.articleId),
      );
    }
    return {
      added,
      total: assigned.length + added,
      toppedUp,
      datasetVersion: current.version,
      createdFrom,
    };
  });
}
