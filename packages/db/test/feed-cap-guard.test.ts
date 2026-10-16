import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * D-251 guard: automatic analysis demand is a stateless SQL predicate that is repeated at many
 * sites (`fi.first_seen_at >= s.inference_activated_at`). A new site that forgets the over-cap
 * condition would silently analyse capped arrivals, so every SQL comparison with
 * `inference_activated_at` under packages/db/src must sit in a SQL chunk that also names
 * `over_cap_limit` (directly or through the shared fragment that contains it), at least once per
 * comparison.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COMPARISON =
  /first_seen_at\s*>=?\s*\w+\.inference_activated_at|inference_activated_at\s*<=?\s*\w+\.first_seen_at/g;

describe('over-cap condition at every automatic-demand predicate (D-251)', () => {
  const sites: { file: string; comparisons: number; marks: number }[] = [];
  for (const file of sourceFiles(SRC)) {
    const chunks = stripComments(readFileSync(file, 'utf8')).split('`');
    // Odd chunks are template literals (SQL or text), even chunks are code.
    for (let i = 1; i < chunks.length; i += 2) {
      const chunk = chunks[i]!;
      const comparisons = (chunk.match(COMPARISON) ?? []).length;
      if (comparisons === 0) continue;
      sites.push({
        file: relative(SRC, file),
        comparisons,
        marks: (chunk.match(/over_cap_limit/g) ?? []).length,
      });
    }
  }

  it('finds the known predicate sites', () => {
    // demand (2), carriers, authorization (2), degraded, reprocess, backfill, cluster (2), pair-demand,
    // rank window and items, api articles/subscriptions/article-actions, house metrics.
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it('every comparison carries the over-cap condition', () => {
    const missing = sites.filter((s) => s.marks < s.comparisons).map((s) => s.file);
    expect(missing).toEqual([]);
  });
});
