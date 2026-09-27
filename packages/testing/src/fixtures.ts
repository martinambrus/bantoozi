import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Committed test fixtures (spec 03 §12, spec 04 §10): feeds in `fixtures/feeds/`, HTML article
 * pages in `fixtures/pages/`, TypeSafe request/response pairs in `fixtures/typesafe/` and Ollama
 * chat responses in `fixtures/ollama/`. Resolved from this module, so sources and builds find the
 * same directory.
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

/** A JSON fixture, parsed (e.g. `readJsonFixture('typesafe', 'enrich-v1.json')`). */
export function readJsonFixture<T = unknown>(...segments: string[]): T {
  return JSON.parse(readFileSync(fixturePath(...segments), 'utf8')) as T;
}
