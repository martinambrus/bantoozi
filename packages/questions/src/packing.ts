import { conservativeTokens, REQUEST_OVERHEAD_TOKENS } from '@bantoozi/shared';

import { QUESTION_KEY_PATTERN, type Question } from './types.js';

/**
 * Call B packing (spec 05 §5.2): as many questions as fit into each request, because Jev bills per
 * input token and reads the one article state once per call. Shared/public questions and each
 * private owner's questions are packed separately (an engine never receives two tenants' private
 * examples in one context); level-2 topic questions are shared. Pure and deterministic.
 */

export interface PackItem {
  /** Opaque question key (`c<cardId>`, `t2_<l1>`); never a user identity. */
  key: string;
  question: Question;
  /** `null` for shared/public questions; the owning user for a private card or label. */
  owner: string | null;
  kind: 'label' | 'card' | 'l2';
  /** From an interactive (priority ≤ 3) queue row. */
  interactive: boolean;
  /** Queue time (epoch ms), the first tie-break. */
  queuedAt: number;
  /** The card id, the second tie-break (bigint order); absent for level-2 questions. */
  cardId?: string | undefined;
}

export interface Pack {
  /** `null` for a shared pack; the owner of every question of a private pack. */
  owner: string | null;
  /** The keys in priority order. */
  keys: string[];
  questions: Record<string, Question>;
  /** Conservative estimate of the whole request: state, questions, keys and overhead. */
  estimatedTokens: number;
}

export interface PackLimits {
  /** `stateTokens + Σ questionTokens ≤` this. */
  maxRequestTokens: number;
  /** `stateTokens + max(questionTokens) ≤` this. */
  maxStatePlusQuestionTokens: number;
  /** Questions per request. */
  maxQuestions: number;
}

/** Jev's request limits (spec 05 §5.2). A fallback engine passes its own, smaller limits. */
export const DEFAULT_PACK_LIMITS: Readonly<PackLimits> = {
  maxRequestTokens: 48_000,
  maxStatePlusQuestionTokens: 28_000,
  maxQuestions: 200,
};

/** A state or question that cannot fit into a request even alone. */
export class PackOverflowError extends Error {
  override readonly name = 'PackOverflowError';

  constructor(
    /** The offending question key, or `null` when the state alone is too large. */
    readonly key: string | null,
    /** The conservative estimate of the smallest request containing it. */
    readonly tokens: number,
    /** The limit it exceeds. */
    readonly limit: number,
  ) {
    super(
      key === null
        ? `the state alone needs ${tokens} tokens (limit ${limit})`
        : `question ${key} needs a ${tokens}-token request (limit ${limit})`,
    );
  }
}

/** Conservative tokens of the state plus the fixed request overhead (spec 04 §6.1). */
export function stateRequestTokens(state: unknown): number {
  return conservativeTokens(state) + REQUEST_OVERHEAD_TOKENS;
}

/** Conservative tokens of one question including its key and separators (serialization overhead). */
export function questionTokens(key: string, question: Question): number {
  return conservativeTokens({ [key]: question });
}

function rank(item: PackItem): number {
  if (item.kind === 'label') return 0;
  return item.interactive ? 1 : 2;
}

function compareCardIds(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Labels, then interactive questions, then the rest; ties by queue time, card id, then key. */
export function comparePackItems(a: PackItem, b: PackItem): number {
  return (
    rank(a) - rank(b) ||
    a.queuedAt - b.queuedAt ||
    compareCardIds(a.cardId, b.cardId) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

function checkLimits(limits: PackLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`invalid pack limit ${name}`);
  }
}

/**
 * Packs the questions of one article state into requests (spec 05 §5.2): partitions shared from
 * private questions (one owner per pack; level-2 questions only in shared packs), orders each
 * partition deterministically ({@link comparePackItems}) and fills requests greedily in that order
 * within `limits`. Partitions are returned in the order of their highest-priority question. Throws
 * {@link PackOverflowError} when the state or one question cannot fit alone: nothing is silently
 * omitted, and no pack is ever empty (no items → no packs).
 */
export function packRequests(
  state: unknown,
  items: readonly PackItem[],
  limits: Readonly<PackLimits> = DEFAULT_PACK_LIMITS,
): Pack[] {
  checkLimits(limits);
  if (items.length === 0) return [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!QUESTION_KEY_PATTERN.test(item.key))
      throw new TypeError(`invalid question key ${item.key}`);
    if (seen.has(item.key)) throw new TypeError(`duplicate question key ${item.key}`);
    seen.add(item.key);
    if (item.kind === 'l2' && item.owner !== null) {
      throw new TypeError(`level-2 question ${item.key} must be shared`);
    }
  }

  const base = stateRequestTokens(state);
  const aloneLimit = Math.min(limits.maxRequestTokens, limits.maxStatePlusQuestionTokens);
  if (base >= aloneLimit) throw new PackOverflowError(null, base, aloneLimit);

  const ordered = items
    .map((item) => ({ item, tokens: questionTokens(item.key, item.question) }))
    .sort((a, b) => comparePackItems(a.item, b.item));
  for (const { item, tokens } of ordered) {
    if (base + tokens > aloneLimit)
      throw new PackOverflowError(item.key, base + tokens, aloneLimit);
  }

  const partitions = new Map<string | null, typeof ordered>();
  for (const entry of ordered) {
    const partition = partitions.get(entry.item.owner);
    if (partition === undefined) partitions.set(entry.item.owner, [entry]);
    else partition.push(entry);
  }

  const packs: Pack[] = [];
  for (const [owner, entries] of partitions) {
    let current: (Pack & { maxQuestion: number }) | null = null;
    for (const { item, tokens } of entries) {
      const fits =
        current !== null &&
        current.keys.length < limits.maxQuestions &&
        current.estimatedTokens + tokens <= limits.maxRequestTokens &&
        base + Math.max(current.maxQuestion, tokens) <= limits.maxStatePlusQuestionTokens;
      if (current === null || !fits) {
        if (current !== null) packs.push(finish(current));
        current = { owner, keys: [], questions: {}, estimatedTokens: base, maxQuestion: 0 };
      }
      current.keys.push(item.key);
      current.questions[item.key] = item.question;
      current.estimatedTokens += tokens;
      current.maxQuestion = Math.max(current.maxQuestion, tokens);
    }
    if (current !== null) packs.push(finish(current));
  }
  return packs;
}

function finish(pack: Pack & { maxQuestion: number }): Pack {
  return {
    owner: pack.owner,
    keys: pack.keys,
    questions: pack.questions,
    estimatedTokens: pack.estimatedTokens,
  };
}
