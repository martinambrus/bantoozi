import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Committed test fixtures (spec 03 §12): feeds in `fixtures/feeds/`, HTML article pages in
 * `fixtures/pages/`. Resolved from this module, so sources and builds find the same directory.
 */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Absolute path of a fixture, e.g. `fixturePath('feeds', 'rss2.xml')`. */
export function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(segments.join('/'), new URL('../fixtures/', import.meta.url)));
}

/** A fixture's raw bytes (never decoded: charset handling is part of what tests check). */
export function readFixture(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(...segments)));
}
