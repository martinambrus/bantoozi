import { parseProgressCursor } from '../src/handlers/house-rescore-degraded.js';
import { expect, it } from 'vitest';

import { watchStateOf } from '../src/model-watch.js';

it('keeps valid watch fields when another field is corrupt or from a newer release', () => {
  const lastCheck = { at: '2026-10-01T00:00:00Z', ok: true };
  expect(
    watchStateOf({
      triggeredAt: 123,
      lastCheck: { ...lastCheck, future: true },
      notice: false,
      future: true,
    }),
  ).toEqual({ lastCheck });
});

it('keeps known housekeeping cursor positions when future fields are present', () => {
  expect(
    parseProgressCursor({
      enrich: { key: '2026-10-01T00:00:00Z', articleId: '1', future: 1 },
      future: 2,
    }),
  ).toEqual({ enrich: { key: '2026-10-01T00:00:00Z', articleId: '1' } });
});

it('keeps the other recovery position when one known position is corrupt', () => {
  const answers = { key: '2026-10-01T00:00:00Z', articleId: '1' };
  expect(parseProgressCursor({ enrich: { key: 123, articleId: '2' }, answers })).toEqual({
    answers,
  });
});
