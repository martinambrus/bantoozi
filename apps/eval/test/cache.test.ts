import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createEvalCache, EVAL_CACHE_VERSION } from '../src/experiments/cache.js';

/** M3a-T6: the content-addressed eval cache (spec 10 §3) in `EVAL_CACHE_DIR`. */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bantoozi-eval-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const Value = z.object({ p: z.number() });
const manifest = {
  kind: 'card',
  engine: 'typesafe',
  model: 'jev-fake',
  stateSha: 'a'.repeat(64),
  cardInputSha256: 'b'.repeat(64),
};

describe('eval cache', () => {
  it('stores and reads a value by its manifest, written under the content address', async () => {
    const cache = createEvalCache({ dir, now: () => new Date('2026-10-01T00:00:00Z') });
    expect(await cache.get(manifest, Value)).toBeNull();
    await cache.put(manifest, { p: 0.9 });
    expect(await cache.get(manifest, Value)).toEqual({ p: 0.9 });
    const key = cache.key(manifest);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(dir)).toEqual([`${key}.json`]);
    const entry = JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8')) as unknown;
    expect(entry).toMatchObject({
      v: EVAL_CACHE_VERSION,
      key,
      manifest,
      value: { p: 0.9 },
      storedAt: '2026-10-01T00:00:00.000Z',
    });
    // A second instance (a later invocation) reads the same entry.
    expect(await createEvalCache({ dir }).get(manifest, Value)).toEqual({ p: 0.9 });
  });

  it('keys are canonical and change with every manifest field', () => {
    const cache = createEvalCache({ dir });
    const reordered = {
      cardInputSha256: manifest.cardInputSha256,
      stateSha: manifest.stateSha,
      model: manifest.model,
      engine: manifest.engine,
      kind: manifest.kind,
    };
    expect(cache.key(reordered)).toBe(cache.key(manifest));
    const keys = new Set([cache.key(manifest)]);
    for (const field of Object.keys(manifest) as (keyof typeof manifest)[]) {
      keys.add(cache.key({ ...manifest, [field]: `${manifest[field]}x` }));
    }
    expect(keys.size).toBe(Object.keys(manifest).length + 1);
  });

  it('treats corrupt, foreign and mistyped entries as misses', async () => {
    const cache = createEvalCache({ dir });
    const file = path.join(dir, `${cache.key(manifest)}.json`);
    await cache.put(manifest, { p: 'high' });
    expect(await cache.get(manifest, Value)).toBeNull();

    await writeFile(file, '{not json');
    expect(await cache.get(manifest, Value)).toBeNull();

    // An entry whose stored manifest is not the asked one (e.g. a hand-copied file) is a miss.
    await writeFile(
      file,
      JSON.stringify({
        v: EVAL_CACHE_VERSION,
        key: cache.key(manifest),
        manifest: { ...manifest, model: 'jev-other' },
        value: { p: 0.1 },
        storedAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    expect(await cache.get(manifest, Value)).toBeNull();

    // Overwriting a bad entry repairs it; no temporary files are left behind.
    await cache.put(manifest, { p: 0.4 });
    expect(await cache.get(manifest, Value)).toEqual({ p: 0.4 });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('concurrent writers of one entry leave one valid file', async () => {
    const cache = createEvalCache({ dir });
    await Promise.all(Array.from({ length: 8 }, () => cache.put(manifest, { p: 0.7 })));
    expect(await cache.get(manifest, Value)).toEqual({ p: 0.7 });
    expect(await readdir(dir)).toHaveLength(1);
  });
});
