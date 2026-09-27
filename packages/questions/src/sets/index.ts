import { CLUSTER_V1 } from './cluster-v1.js';
import type { QuestionSetDefinition, QuestionSetKind } from './define.js';
import { ENRICH_V1 } from './enrich-v1.js';
import { MATCH_V1 } from './match-v1.js';
import { SUGGEST_V1 } from './suggest-v1.js';

export * from './cluster-v1.js';
export * from './define.js';
export * from './enrich-v1.js';
export * from './match-v1.js';
export * from './suggest-v1.js';

/**
 * Every question set the code knows, oldest first within a kind. `pnpm db:seed` upserts each one
 * (spec 05 §2) and the worker checks them at startup.
 */
export const ALL_QUESTION_SETS: readonly QuestionSetDefinition[] = [
  ENRICH_V1,
  MATCH_V1,
  CLUSTER_V1,
  SUGGEST_V1,
];

/**
 * The newest set of each kind: what the seed makes active for a kind that has no active set yet.
 * Switching an existing kind is an admin settings change (spec 05 §2), never a seed side effect.
 */
export const LATEST_QUESTION_SETS: Readonly<Record<QuestionSetKind, QuestionSetDefinition>> = {
  enrich: ENRICH_V1,
  match: MATCH_V1,
  cluster: CLUSTER_V1,
  suggest: SUGGEST_V1,
};

/** The set with this `version`, if the code knows it. */
export function questionSetByVersion(version: string): QuestionSetDefinition | undefined {
  return ALL_QUESTION_SETS.find((set) => set.version === version);
}

/** The set with this `sha256`, if the code knows it. */
export function questionSetBySha(sha256: string): QuestionSetDefinition | undefined {
  return ALL_QUESTION_SETS.find((set) => set.sha256 === sha256);
}
