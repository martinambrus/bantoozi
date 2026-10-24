import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { callRecordModelPin } from './support/model-pin-world.js';
import {
  ClassifyHarness,
  OLD_MODEL,
  NEW_MODEL,
  resetWorld,
  pinRow,
} from './support/m8b-t5-world.js';
let h: ClassifyHarness;
beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetWorld(h);
});
it('resetWorld defaults to the alias-marked pin of the running alias world', async () => {
  await resetWorld(h);
  expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL, alias: 'jev-latest' });
});

it('the model-pin helper forwards the currentness compare-and-set', async () => {
  const isCurrent = vi.fn(async () => false);
  const before = await pinRow(h.owner);
  expect(await callRecordModelPin(h.db, { model: NEW_MODEL }, new Date(), { isCurrent })).toEqual({
    changed: false,
    skipped: true,
  });
  expect(isCurrent).toHaveBeenCalledOnce();
  expect(await pinRow(h.owner)).toEqual(before);
});
