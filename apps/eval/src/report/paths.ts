import path from 'node:path';

import { resolveRepoPath } from '../collection/paths.js';

/**
 * Default output paths of the gate (spec 10 §1): `apps/eval/reports/G1-<date>.md` and
 * `apps/eval/config/g1.json`, relative to the repository root.
 */
export const DEFAULT_G1_PATH = 'apps/eval/config/g1.json';
export const REPORTS_DIR = 'apps/eval/reports';

/** `YYYY-MM-DD` in UTC. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function defaultGateReportPath(now: Date): string {
  return resolveRepoPath(path.join(REPORTS_DIR, `G1-${isoDate(now)}.md`));
}

export function defaultEvalReportPath(version: string, now: Date): string {
  return resolveRepoPath(path.join(REPORTS_DIR, `EVAL-${version}-${isoDate(now)}.md`));
}

export { resolveRepoPath };
