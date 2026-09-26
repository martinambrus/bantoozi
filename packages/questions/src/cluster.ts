import { choice, noul, type OptionCriteria } from './builders.js';
import { SHORT_EXCERPT_CHARS, STATE_LIMITS } from './state.js';
import { boundedText } from './text.js';
import type { Answer, ChoiceQuestion, NoulQuestion } from './types.js';

/**
 * Story clustering (spec 05 §6): the candidate post-filter, the `cluster-v1` state and questions,
 * and the fold rule. The SQL candidate query (≤ 20 by similarity) lives in `packages/db`; the
 * membership transaction lives in the worker.
 */

/** Candidates the SQL query returns at most (walked by similarity). */
export const CLUSTER_CANDIDATE_POOL = 20;
/** Candidates kept for the call (`c1…c5`). */
export const CLUSTER_MAX_CANDIDATES = 5;
/** At most this many kept candidates from one feed. */
export const CLUSTER_MAX_PER_FEED = 2;
/** Fold only when the chosen candidate has at least this probability… */
export const CLUSTER_FOLD_MIN_P = 0.7;
/** …and `is_followup` is below this. */
export const CLUSTER_FOLLOWUP_MAX_P = 0.5;

/** The `same_story` option meaning that no candidate reports the same event. */
export const CLUSTER_NONE_OPTION = 'none';

/**
 * Step 1, in code: walk the (≤ 20) rows by similarity, skip a candidate once two from the same feed
 * have been kept, and stop at five. The input order is the query's (similarity desc, then id).
 */
export function selectClusterCandidates<T extends { feedId: string }>(
  rowsBySimilarity: readonly T[],
): T[] {
  const kept: T[] = [];
  const perFeed = new Map<string, number>();
  for (const row of rowsBySimilarity.slice(0, CLUSTER_CANDIDATE_POOL)) {
    const count = perFeed.get(row.feedId) ?? 0;
    if (count >= CLUSTER_MAX_PER_FEED) continue;
    perFeed.set(row.feedId, count + 1);
    kept.push(row);
    if (kept.length === CLUSTER_MAX_CANDIDATES) break;
  }
  return kept;
}

/** One article of the cluster state; `at` is its `first_seen_at`. */
export interface ClusterItem {
  title: string;
  excerpt: string | null;
  /** The (authorized carrier) feed's title. */
  feed: string | null;
  at: Date;
}

export type ClusterStateItem = {
  title: string;
  excerpt: string | null;
  feed: string | null;
  published: string;
};

export type ClusterState = {
  new: ClusterStateItem;
  candidates: ({ id: string } & ClusterStateItem)[];
};

/** What `new.published` says: the candidates' times are relative to it. */
export const CLUSTER_REFERENCE_TIME = 'reference time';

const HOUR_MS = 3_600_000;

/**
 * A coarse, model-friendly time of `at` relative to `reference` (spec 05 §6 step 3), so no date
 * arithmetic is left to the model: "within an hour of `new`", "N hours before `new`" (under two
 * days) or "N days after `new`". Hours and days are rounded down.
 */
export function relativeToNew(at: Date, reference: Date): string {
  const delta = at.getTime() - reference.getTime();
  const abs = Math.abs(delta);
  if (!Number.isFinite(abs)) throw new RangeError('invalid cluster item time');
  if (abs < HOUR_MS) return 'within an hour of `new`';
  const direction = delta < 0 ? 'before' : 'after';
  const hours = Math.floor(abs / HOUR_MS);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${direction} \`new\``;
  const days = Math.floor(hours / 24);
  return `${days} days ${direction} \`new\``;
}

/** The candidate keys `c1…cN`. */
export function clusterKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `c${i + 1}`);
}

function stateItem(item: ClusterItem, published: string): ClusterStateItem {
  return {
    title: boundedText(item.title, STATE_LIMITS.title) ?? '',
    excerpt: boundedText(item.excerpt, SHORT_EXCERPT_CHARS),
    feed: boundedText(item.feed, STATE_LIMITS.feedTitle),
    published,
  };
}

/**
 * The cluster state (spec 05 §6 step 3): `{ new, candidates: [{id: 'c1'…'c5', …}] }` with excerpts
 * of ≤ 300 characters and coarse relative times. `keys[i]` is the key of `candidates[i]`, which the
 * caller maps back to the candidate article.
 */
export function buildClusterState(
  newItem: ClusterItem,
  candidates: readonly ClusterItem[],
): { state: ClusterState; keys: string[] } {
  if (candidates.length < 1 || candidates.length > CLUSTER_MAX_CANDIDATES) {
    throw new RangeError(
      `a cluster call needs 1..${CLUSTER_MAX_CANDIDATES} candidates, got ${candidates.length}`,
    );
  }
  const keys = clusterKeys(candidates.length);
  return {
    state: {
      new: stateItem(newItem, CLUSTER_REFERENCE_TIME),
      candidates: candidates.map((candidate, i) => ({
        id: keys[i] ?? '',
        ...stateItem(candidate, relativeToNew(candidate.at, newItem.at)),
      })),
    },
    keys,
  };
}

/** The `cluster-v1` questions for `n` candidates (1–5): `same_story` over `c1…cN` + `none`, and `is_followup`. */
export function clusterQuestions(n: number): {
  same_story: ChoiceQuestion;
  is_followup: NoulQuestion;
} {
  if (!Number.isInteger(n) || n < 1 || n > CLUSTER_MAX_CANDIDATES) {
    throw new RangeError(`a cluster call needs 1..${CLUSTER_MAX_CANDIDATES} candidates, got ${n}`);
  }
  const options: Record<string, OptionCriteria> = {};
  for (const key of clusterKeys(n)) options[key] = null;
  options[CLUSTER_NONE_OPTION] = 'No candidate reports the same specific event';
  return {
    same_story: choice(
      {
        question: 'Which item in `candidates` reports the same specific event as `new`?',
        focus: 'Same topic is not enough; it must be the same event.',
      },
      options,
    ),
    is_followup: noul(
      'Is `new` a follow-up with substantial new developments rather than a re-report of an event already covered in `candidates`?',
    ),
  };
}

export type ClusterFoldDecision = { fold: false } | { fold: true; key: string };

/**
 * The fold rule (spec 05 §6 step 5): fold into the chosen candidate when `same_story` is not `none`,
 * the chosen candidate's probability is ≥ 0.7 and `is_followup` is < 0.5. A missing or mistyped
 * answer, or a choice outside `keys`, never folds (clustering is best-effort).
 */
export function clusterFoldDecision(
  answers: Readonly<Record<string, Answer>>,
  keys: readonly string[],
): ClusterFoldDecision {
  const same = answers['same_story'];
  const followup = answers['is_followup'];
  if (same?.type !== 'choice' || followup?.type !== 'noul') return { fold: false };
  const chosen = same.choice;
  if (chosen === CLUSTER_NONE_OPTION || !keys.includes(chosen)) return { fold: false };
  const p = same.probabilities[chosen];
  if (p === undefined || !(p >= CLUSTER_FOLD_MIN_P)) return { fold: false };
  if (!(followup.p < CLUSTER_FOLLOWUP_MAX_P)) return { fold: false };
  return { fold: true, key: chosen };
}
