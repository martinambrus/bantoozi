import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Small helpers of the runner: bounded concurrency, latency summaries, the git revision. */

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Nearest-rank percentiles (spec 10 §4 "p50/p95 live-call latency"). */
export function latencySummary(samples: readonly number[]): {
  p50: number;
  p95: number;
  n: number;
} {
  if (samples.length === 0) return { p50: 0, p95: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { p50: Math.round(at(0.5) ?? 0), p95: Math.round(at(0.95) ?? 0), n: sorted.length };
}

/** The repository's current commit (`eval.runs.git_sha`); `unknown` outside a git checkout. */
export function currentGitSha(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** USD for printing (four decimals below a dollar, two above). */
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** The repository root (CLI paths are relative to it, spec 10 §1). */
export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

export function resolveFromRepositoryRoot(file: string): string {
  return path.resolve(REPOSITORY_ROOT, file);
}
