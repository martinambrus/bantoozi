import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, type JsonValue } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { z } from 'zod';

/**
 * The evaluation call cache (spec 10 §3): every **successful validated** engine or translation call
 * is stored as `${EVAL_CACHE_DIR}/<sha256(canonical request manifest)>.json`, outside the repository
 * and shared by worktrees, so re-runs, resumes, replays and report tweaks cost nothing.
 *
 * - The key is the SHA-256 of the canonical JSON of the whole request manifest (provider, pinned
 *   model, adapter/schema version, operation, question set, exact state/question/translation
 *   source hashes, decoding settings, content revision), never a string concatenation.
 * - Writes are atomic: a unique temporary file in the same directory, then `rename`, so a reader
 *   never sees a partial entry and concurrent writers of one key leave one complete entry.
 * - An entry stores its manifest; a read whose stored manifest differs from the requested one (a
 *   corrupted or foreign file) is a miss, never a wrong answer.
 * - Failures are never cached: callers store only validated results.
 * - Hits keep the provenance (engine, model, cost) of the call that produced them.
 */

/** Bumped when the stored entry shape or any manifest convention changes. */
export const EVAL_CACHE_VERSION = 1;

export type CacheManifest = { [key: string]: JsonValue };

export interface EvalCache {
  readonly dir: string;
  /** The content address of a manifest (also the file name without `.json`). */
  key(manifest: CacheManifest): string;
  /** The stored value for the manifest, validated by `schema`; null on a miss or a bad entry. */
  get<T>(manifest: CacheManifest, schema: z.ZodType<T>): Promise<T | null>;
  /** Store a validated value atomically (an existing entry is replaced by an identical one). */
  put(manifest: CacheManifest, value: JsonValue): Promise<void>;
}

const EntrySchema = z.object({
  v: z.literal(EVAL_CACHE_VERSION),
  key: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  value: z.unknown(),
  storedAt: z.string(),
});

export interface EvalCacheOptions {
  dir: string;
  /** Injected time for `storedAt` (spec 01 §5). */
  now?: () => Date;
}

export function createEvalCache(options: EvalCacheOptions): EvalCache {
  const dir = path.resolve(options.dir);
  const now = options.now ?? (() => new Date());
  let ensured: Promise<void> | undefined;
  const fileOf = (key: string) => path.join(dir, `${key}.json`);
  const keyOf = (manifest: CacheManifest) =>
    canonicalSha256({ cache: EVAL_CACHE_VERSION, manifest });

  return {
    dir,
    key: keyOf,

    async get<T>(manifest: CacheManifest, schema: z.ZodType<T>): Promise<T | null> {
      const key = keyOf(manifest);
      let text: string;
      try {
        text = await readFile(fileOf(key), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return null;
      }
      const entry = EntrySchema.safeParse(raw);
      if (!entry.success || entry.data.key !== key) return null;
      if (canonicalJson(entry.data.manifest) !== canonicalJson(manifest)) return null;
      const value = schema.safeParse(entry.data.value);
      return value.success ? value.data : null;
    },

    async put(manifest: CacheManifest, value: JsonValue): Promise<void> {
      ensured ??= mkdir(dir, { recursive: true }).then(() => undefined);
      await ensured;
      const key = keyOf(manifest);
      const entry = { v: EVAL_CACHE_VERSION, key, manifest, value, storedAt: now().toISOString() };
      const tmp = path.join(dir, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, `${JSON.stringify(entry)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(tmp, fileOf(key));
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },
  };
}
