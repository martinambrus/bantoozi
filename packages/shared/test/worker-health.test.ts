import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isHeartbeatFresh } from '../src/worker-health.js';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('shared heartbeat freshness', () => {
  it.each([-90_001, -90_000, 0, 90_000, 90_001])('bounds timestamp offset %s', (offset) => {
    expect(isHeartbeatFresh(NOW.getTime() + offset, NOW)).toBe(Math.abs(offset) <= 90_000);
  });
  it('rejects invalid timestamps', () => {
    expect(isHeartbeatFresh(NaN, NOW)).toBe(false);
  });
  it.each([
    '../../../apps/worker/src/alerts/rules.ts',
    '../../../apps/api/src/routes/admin/shared.ts',
    '../../../apps/eval/src/collection/worker-check.ts',
  ])('keeps %s on the shared predicate', (path) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).toMatch(
      /import\s*\{[^}]*\bisHeartbeatFresh\b[^}]*\}\s*from\s*'@bantoozi\/shared'/s,
    );
    expect(source).toMatch(/isHeartbeatFresh\(/);
    expect(source).not.toMatch(/\b90_?000\b/);
  });
});
