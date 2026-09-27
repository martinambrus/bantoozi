import { readFileSync } from 'node:fs';

import { cardTextHash } from '@bantoozi/shared/server';

import { CARD_LIMITS, validateCardBody } from './cards.js';
import { OTHER_TOPIC_ID, TAXONOMY, isTopicId, topicL1 } from './taxonomy.js';

/**
 * The reviewed public card library (spec 05 §8): `packages/questions/library/<l1>.json`, one file
 * per level-1 topic except `other`, each an array of entries. `pnpm db:seed` upserts them by slug.
 * The files are read at runtime relative to this module, so they resolve from `src/` (tests, tsx)
 * and from `dist/` (the built worker) alike; `library/` ships next to both.
 */

/** One library entry as authored (English text; the `*_sk` fields are display translations). */
export interface LibraryCardEntry {
  slug: string;
  title: string;
  title_sk: string;
  interest: string;
  interest_sk?: string;
  not_for?: string;
  topic_ids: string[];
  examples_yes?: string[];
  examples_no?: string[];
}

/** Authoring limits (spec 05 §8), in code points of trimmed text. */
export const LIBRARY_LIMITS = {
  minCards: 150,
  minCardsPerL1: 5,
  minLocalCards: 15,
  /** Interest and exclusion text: "≤ 200 chars". */
  textMax: 200,
  /** The Slovak display translation of the interest may run a little longer than the English. */
  interestSkMax: CARD_LIMITS.interestMax,
  titleMax: CARD_LIMITS.titleMax,
  examplesYes: 3,
  examplesNo: 2,
  exampleMax: CARD_LIMITS.exampleMax,
} as const;

/** `interest_cards.slug` of a library card (the database function checks the same pattern). */
export const LIBRARY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The library files: one per level-1 topic except `other`, in taxonomy order. */
export const LIBRARY_FILE_L1S: readonly string[] = TAXONOMY.map((topic) => topic.id).filter(
  (id) => id !== OTHER_TOPIC_ID,
);

const ENTRY_KEYS = new Set([
  'slug',
  'title',
  'title_sk',
  'interest',
  'interest_sk',
  'not_for',
  'topic_ids',
  'examples_yes',
  'examples_no',
]);

const length = (text: string): number => Array.from(text.trim()).length;

function textProblem(
  value: unknown,
  label: string,
  min: number,
  max: number,
  optional = false,
): string | null {
  if (value === undefined && optional) return null;
  if (typeof value !== 'string') return `${label} must be a string`;
  if (value !== value.trim()) return `${label} has leading or trailing whitespace`;
  const size = length(value);
  if (size < min || size > max) return `${label} must have ${min}..${max} characters (has ${size})`;
  return null;
}

function listProblems(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${label} must be an array`];
  const problems: string[] = [];
  if (value.length === 0) problems.push(`${label} must be omitted rather than empty`);
  if (value.length > max) problems.push(`${label} has more than ${max} entries`);
  value.forEach((item: unknown, i) => {
    const problem = textProblem(item, `${label}[${i}]`, 1, LIBRARY_LIMITS.exampleMax);
    if (problem !== null) problems.push(problem);
  });
  return problems;
}

/** Problems of one entry of the file of level-1 topic `l1` (empty when it is valid). */
export function libraryEntryProblems(entry: unknown, l1: string): string[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${l1}/?: entry must be an object`];
  }
  const record = entry as Record<string, unknown>;
  const slug = typeof record['slug'] === 'string' ? record['slug'] : '?';
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`unknown field ${key}`);
  }
  if (typeof record['slug'] !== 'string' || !LIBRARY_SLUG_PATTERN.test(record['slug'])) {
    problems.push('slug must match [a-z0-9][a-z0-9-]{0,99}');
  }
  const texts = [
    textProblem(record['title'], 'title', 1, LIBRARY_LIMITS.titleMax),
    textProblem(record['title_sk'], 'title_sk', 1, LIBRARY_LIMITS.titleMax),
    textProblem(record['interest'], 'interest', CARD_LIMITS.interestMin, LIBRARY_LIMITS.textMax),
    textProblem(record['interest_sk'], 'interest_sk', 3, LIBRARY_LIMITS.interestSkMax, true),
    textProblem(record['not_for'], 'not_for', 1, LIBRARY_LIMITS.textMax, true),
  ];
  for (const problem of texts) if (problem !== null) problems.push(problem);
  problems.push(
    ...listProblems(record['examples_yes'], 'examples_yes', LIBRARY_LIMITS.examplesYes),
  );
  problems.push(...listProblems(record['examples_no'], 'examples_no', LIBRARY_LIMITS.examplesNo));

  const topics = record['topic_ids'];
  if (!Array.isArray(topics) || topics.length === 0) {
    problems.push('topic_ids must be a non-empty array');
  } else {
    if (new Set(topics).size !== topics.length) problems.push('topic_ids has duplicates');
    for (const topic of topics as unknown[]) {
      if (typeof topic !== 'string' || !isTopicId(topic) || topic === OTHER_TOPIC_ID) {
        problems.push(`unknown topic id ${String(topic)}`);
      }
    }
    const first = topics[0];
    if (typeof first === 'string' && topicL1(first) !== l1) {
      problems.push(`the first topic ${first} is not under ${l1}, the level-1 topic of its file`);
    }
  }

  if (problems.length === 0) {
    const body = validateCardBody({
      interest: record['interest'],
      ...(record['not_for'] === undefined ? {} : { not_for: record['not_for'] }),
      ...(record['examples_yes'] === undefined ? {} : { examples_yes: record['examples_yes'] }),
      ...(record['examples_no'] === undefined ? {} : { examples_no: record['examples_no'] }),
    });
    if (!body.ok) problems.push(...body.problems.map((p) => `${p.path} ${p.message}`));
  }
  return problems.map((problem) => `${l1}/${slug}: ${problem}`);
}

/** Whether an entry is specific to Slovakia or Czechia (it has a `local.*` topic). */
export function isLocalLibraryCard(entry: Pick<LibraryCardEntry, 'topic_ids'>): boolean {
  return entry.topic_ids.some((topic) => topicL1(topic) === 'local');
}

/** The `text_hash` of a library entry as a public interest card (spec 05 §5.1). */
export function libraryCardTextHash(entry: LibraryCardEntry): string {
  return cardTextHash({
    kind: 'interest',
    title: entry.title,
    interest: entry.interest,
    not_for: entry.not_for ?? null,
    examples_yes: entry.examples_yes ?? null,
    examples_no: entry.examples_no ?? null,
    visibility: 'public',
  });
}

/**
 * Every problem of a whole library (empty when it is valid): each entry, one file per level-1
 * topic except `other`, unique slugs and text hashes, ≥ 150 cards, ≥ 5 per file and ≥ 15 specific
 * to Slovakia/Czechia (spec 05 §8).
 */
export function libraryProblems(files: ReadonlyMap<string, readonly unknown[]>): string[] {
  const problems: string[] = [];
  for (const l1 of files.keys()) {
    if (!LIBRARY_FILE_L1S.includes(l1)) problems.push(`unexpected library file ${l1}`);
  }
  const slugs = new Map<string, string>();
  const hashes = new Map<string, string>();
  let total = 0;
  let local = 0;
  for (const l1 of LIBRARY_FILE_L1S) {
    const entries = files.get(l1);
    if (entries === undefined) {
      problems.push(`missing library file ${l1}`);
      continue;
    }
    if (entries.length < LIBRARY_LIMITS.minCardsPerL1) {
      problems.push(`${l1} has ${entries.length} cards (at least ${LIBRARY_LIMITS.minCardsPerL1})`);
    }
    for (const entry of entries) {
      total += 1;
      const entryProblems = libraryEntryProblems(entry, l1);
      problems.push(...entryProblems);
      if (entryProblems.length > 0) continue;
      const card = entry as LibraryCardEntry;
      const other = slugs.get(card.slug);
      if (other !== undefined) problems.push(`duplicate slug ${card.slug} (${other} and ${l1})`);
      slugs.set(card.slug, l1);
      const hash = libraryCardTextHash(card);
      const same = hashes.get(hash);
      if (same !== undefined) problems.push(`${card.slug} has the same text as ${same}`);
      hashes.set(hash, card.slug);
      if (isLocalLibraryCard(card)) local += 1;
    }
  }
  if (total < LIBRARY_LIMITS.minCards) {
    problems.push(`the library has ${total} cards (at least ${LIBRARY_LIMITS.minCards})`);
  }
  if (local < LIBRARY_LIMITS.minLocalCards) {
    problems.push(
      `${local} cards are specific to Slovakia/Czechia (at least ${LIBRARY_LIMITS.minLocalCards})`,
    );
  }
  return problems;
}

/** Reads the raw library files (level-1 id → parsed JSON array). */
export function readLibraryFiles(
  directory: URL = new URL('../library/', import.meta.url),
): Map<string, unknown[]> {
  const files = new Map<string, unknown[]>();
  for (const l1 of LIBRARY_FILE_L1S) {
    const parsed: unknown = JSON.parse(readFileSync(new URL(`${l1}.json`, directory), 'utf8'));
    if (!Array.isArray(parsed)) throw new TypeError(`library file ${l1}.json must hold an array`);
    files.set(l1, parsed);
  }
  return files;
}

let cached: readonly LibraryCardEntry[] | undefined;

/**
 * The validated library, file by file in taxonomy order (read once per process). Throws with every
 * problem when the library is invalid, so a broken file never reaches the seed.
 */
export function loadLibraryCards(): readonly LibraryCardEntry[] {
  if (cached === undefined) {
    const files = readLibraryFiles();
    const problems = libraryProblems(files);
    if (problems.length > 0) {
      throw new Error(`invalid card library:\n${problems.join('\n')}`);
    }
    cached = Object.freeze(
      LIBRARY_FILE_L1S.flatMap((l1) => (files.get(l1) ?? []) as LibraryCardEntry[]),
    );
  }
  return cached;
}
