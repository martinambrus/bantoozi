import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { WORKER_SHUTDOWN_TIMEOUT_MS } from '../src/shutdown-deadline.js';

it('uses the worker container grace period, leaving at least 20 seconds for cleanup', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const match = /boss\?\.stop\(\{ graceful: true, timeout: ([\d_]+), wait: true \}\)/.exec(source);
  expect(source).toContain('stopped ??= withShutdownDeadline(');
  expect(match).not.toBeNull();
  const timeout = Number(match?.[1]?.replaceAll('_', ''));
  expect(timeout).toBeGreaterThanOrEqual(100_000);
  const compose = readFileSync(new URL('../../../infra/compose.yml', import.meta.url), 'utf8');
  for (const service of ['worker', 'worker-laya']) {
    const block = compose.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[a-z]/)[0];
    const seconds = Number(/stop_grace_period: (\d+)s/.exec(block ?? '')?.[1]);
    expect(timeout).toBeLessThanOrEqual(seconds * 1000 - 20_000);
    expect(WORKER_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(timeout);
    expect(WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(seconds * 1000);
  }
});
