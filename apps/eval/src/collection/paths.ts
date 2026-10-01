import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Paths given to `eval` commands are relative to the repository root (spec 10 §1), whatever
 * directory `pnpm evaluate` runs the CLI from. This module sits in `apps/eval/{src,dist}/collection`,
 * four levels below the root.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The golden feed list (spec 10 §2.1). */
export const DEFAULT_FEED_LIST = 'apps/eval/data/feeds-golden.txt';

/** Resolve a CLI path argument against the repository root (absolute paths stay as they are). */
export function resolveRepoPath(p: string): string {
  return path.resolve(REPO_ROOT, p);
}
