import { LIMITS } from './names.js';
import type { Manifest, Stat } from './types.js';

/**
 * The account's bookkeeping (spec 09 §1): what it has stored, since when and how big, so that
 * expiry, the limits and the usage never read the articles themselves. An entry is named
 * `<store>/<name>`; the `Me` of the account is `meta/me`.
 */

export type CacheStore = 'meta' | 'items' | 'views' | 'details';

export const ME_ENTRY = 'meta/me';

export function entryOf(store: CacheStore, name: string): string {
  return `${store}/${name}`;
}

export function splitEntry(entry: string): { store: CacheStore; name: string } {
  const slash = entry.indexOf('/');
  return { store: entry.slice(0, slash) as CacheStore, name: entry.slice(slash + 1) };
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function isExpired(savedAt: number, now: number): boolean {
  return now - savedAt >= LIMITS.ttlMs;
}

type Pair = [entry: string, stat: Stat];

const oldestFirst = (pairs: Pair[]) =>
  pairs.sort(([, a], [, b]) => a.savedAt - b.savedAt || a.seq - b.seq);

/** What the account occupies: its entries and the manifest that lists them. */
export function storedBytes(manifest: Manifest): number {
  const pairs = Object.values(manifest.entries);
  if (pairs.length === 0) return 0;
  return pairs.reduce((sum, stat) => sum + stat.bytes, utf8Length(JSON.stringify(manifest)));
}

export interface Planned {
  entry: string;
  bytes: number;
}

export interface Plan {
  manifest: Manifest;
  /** The entries whose rows go: the expired ones and the ones given up to stay within the limits. */
  removed: string[];
  /** False when the limits leave no room for what was to be saved. */
  fits: boolean;
}

/**
 * The manifest after saving `puts` at `now`. The entries saved first are the oldest, so the ones
 * that go first are, in this order: the expired, the items beyond the limit and then whatever is
 * oldest until the bytes fit. The `Me` of the account is never given up for room.
 */
export function plan(current: Manifest | undefined, puts: readonly Planned[], now: number): Plan {
  const manifest: Manifest = { seq: current?.seq ?? 0, entries: { ...current?.entries } };
  const removed: string[] = [];
  const remove = (entry: string) => {
    delete manifest.entries[entry];
    removed.push(entry);
  };

  for (const [entry, stat] of Object.entries(manifest.entries)) {
    if (isExpired(stat.savedAt, now)) remove(entry);
  }
  for (const put of puts) {
    manifest.seq += 1;
    manifest.entries[put.entry] = { savedAt: now, seq: manifest.seq, bytes: put.bytes };
  }

  const items = Object.entries(manifest.entries).filter(([entry]) => entry.startsWith('items/'));
  for (const [entry] of oldestFirst(items).slice(0, Math.max(0, items.length - LIMITS.maxItems))) {
    remove(entry);
  }

  const evictable = oldestFirst(
    Object.entries(manifest.entries).filter(([entry]) => entry !== ME_ENTRY),
  );
  for (const [entry] of evictable) {
    if (storedBytes(manifest) <= LIMITS.maxBytes) break;
    remove(entry);
  }

  return {
    manifest,
    removed,
    fits: puts.every((put) => Object.hasOwn(manifest.entries, put.entry)),
  };
}

/** The articles and bytes of what has not expired. */
export function usageOf(
  manifest: Manifest | undefined,
  now: number,
): { articles: number; bytes: number } {
  if (manifest === undefined) return { articles: 0, bytes: 0 };
  const live = Object.entries(manifest.entries).filter(([, stat]) => !isExpired(stat.savedAt, now));
  const articles = new Set(
    live
      .map(([entry]) => splitEntry(entry))
      .filter(({ store }) => store === 'items' || store === 'details')
      .map(({ name }) => name),
  );
  return {
    articles: articles.size,
    bytes: storedBytes({ seq: manifest.seq, entries: Object.fromEntries(live) }),
  };
}
