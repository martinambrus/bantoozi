import { enqueueRematch } from '@bantoozi/shared';
import { cardTextHash } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { workerOutbox } from '../outbox.js';

/**
 * Seeding the public card library by slug (spec 05 §8, spec 02 §3.6). Library cards are immutable
 * public interest cards (`origin='library'`); a slug is the discovery alias of the newest version:
 *
 * - unchanged text: title, topic_ids and i18n are corrected in place (a topic change also records
 *   `house.rematch {cardId}`, because the prefilter reads topics outside `card_input_sha256`);
 * - changed text: another immutable public card (new, or reused by text hash) becomes the next
 *   `library_card_versions` entry and takes the slug, in one transaction. The old card stays readable,
 *   answer-valid and held: holders are never re-pointed, rematched or retired; they get an explicit
 *   update offer from the version chain instead;
 * - a text hash that belongs to a non-public (shared) card, another slug or an older version is held
 *   and reported: the seed never promotes user material or bypasses the publication policy (§8.1).
 *
 * Each entry locks `library:<slug>` (the lock `admin_publish_library_card_version` and the version
 * guard take), in slug order, and is idempotent: a second run changes nothing.
 */

/** One library entry as the seed stores it. */
export interface LibraryCardSeed {
  slug: string;
  /** Default display title (an interest card's title is not part of its text hash). */
  title: string;
  interest: string;
  notFor: string | null;
  examplesYes: readonly string[] | null;
  examplesNo: readonly string[] | null;
  topicIds: readonly string[];
  /** Display translations, e.g. `{ sk: { title, interest } }`. */
  i18n: Record<string, unknown>;
}

export type LibraryHoldReason =
  /** The text belongs to a shared (user) card: publishing it needs the §8.1 authorization. */
  | 'text_is_shared_card'
  /** The text is the current card of another library slug. */
  | 'text_has_other_slug'
  /** The text is already a version in a library chain (e.g. a revert to an earlier version). */
  | 'text_is_library_version'
  /** The slug's version chain does not end at the card that holds the slug. */
  | 'version_chain_mismatch';

export type LibrarySeedOutcome =
  | { slug: string; status: 'inserted' | 'adopted' | 'unchanged'; cardId: string }
  | { slug: string; status: 'updated'; cardId: string; topicsChanged: boolean }
  | { slug: string; status: 'versioned'; cardId: string; previousCardId: string; version: number }
  | { slug: string; status: 'held'; cardId: string | null; reason: LibraryHoldReason };

type CardRow = {
  id: string;
  slug: string | null;
  text_hash: string;
  title: string;
  topic_ids: string[];
  i18n: unknown;
  visibility: 'public' | 'shared' | 'private';
  retired_at: Date | null;
  in_chain: boolean;
};

const CARD_COLUMNS = sql`
  c.id::text AS id, c.slug, c.text_hash, c.title, c.topic_ids, c.i18n, c.visibility, c.retired_at,
  EXISTS (SELECT 1 FROM library_card_versions v WHERE v.card_id = c.id) AS in_chain`;

async function cardBySlug(tx: Transaction, slug: string): Promise<CardRow | undefined> {
  const result = await tx.execute<CardRow>(
    sql`SELECT ${CARD_COLUMNS} FROM interest_cards c WHERE c.slug = ${slug} FOR UPDATE`,
  );
  return result.rows[0];
}

async function cardByHash(tx: Transaction, textHash: string): Promise<CardRow | undefined> {
  const result = await tx.execute<CardRow>(
    sql`SELECT ${CARD_COLUMNS} FROM interest_cards c WHERE c.text_hash = ${textHash} FOR UPDATE`,
  );
  return result.rows[0];
}

/** The latest version of a slug's chain, or `undefined` when the slug has none. */
async function latestVersion(
  tx: Transaction,
  slug: string,
): Promise<{ version: number; cardId: string } | undefined> {
  const result = await tx.execute<{ version: number; card_id: string }>(sql`
    SELECT version, card_id::text AS card_id FROM library_card_versions
     WHERE library_slug = ${slug} ORDER BY version DESC LIMIT 1`);
  const row = result.rows[0];
  return row === undefined ? undefined : { version: row.version, cardId: row.card_id };
}

async function appendVersion(
  tx: Transaction,
  slug: string,
  version: number,
  cardId: string,
  previousCardId: string | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
    VALUES (${slug}, ${version}, ${cardId}::bigint, ${previousCardId}::bigint)`);
}

function body(entry: LibraryCardSeed): Record<string, unknown> {
  return {
    interest: entry.interest,
    ...(entry.notFor === null ? {} : { not_for: entry.notFor }),
    ...(entry.examplesYes === null || entry.examplesYes.length === 0
      ? {}
      : { examples_yes: entry.examplesYes }),
    ...(entry.examplesNo === null || entry.examplesNo.length === 0
      ? {}
      : { examples_no: entry.examplesNo }),
  };
}

/** The `text_hash` a library entry has as a public interest card (spec 05 §5.1). */
export function librarySeedTextHash(entry: LibraryCardSeed): string {
  return cardTextHash({
    kind: 'interest',
    title: entry.title,
    interest: entry.interest,
    not_for: entry.notFor,
    examples_yes:
      entry.examplesYes === null || entry.examplesYes.length === 0 ? null : entry.examplesYes,
    examples_no:
      entry.examplesNo === null || entry.examplesNo.length === 0 ? null : entry.examplesNo,
    visibility: 'public',
  });
}

const sameArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/** Canonical comparison of two JSON values (jsonb reorders object keys). */
async function sameJson(tx: Transaction, a: unknown, b: unknown): Promise<boolean> {
  const result = await tx.execute<{ same: boolean }>(
    sql`SELECT ${JSON.stringify(a)}::jsonb = ${JSON.stringify(b)}::jsonb AS same`,
  );
  return result.rows[0]?.same === true;
}

/**
 * Bring a public card's display metadata to the entry's (and un-retire it); returns whether the
 * topics changed. A topic change records `house.rematch {cardId}` in the same transaction.
 */
async function applyMetadata(
  tx: Transaction,
  card: CardRow,
  entry: LibraryCardSeed,
  slug: string | null,
): Promise<{ changed: boolean; topicsChanged: boolean }> {
  const topicsChanged = !sameArray(card.topic_ids, entry.topicIds);
  const changed =
    topicsChanged ||
    card.title !== entry.title ||
    card.retired_at !== null ||
    card.slug !== slug ||
    !(await sameJson(tx, card.i18n, entry.i18n));
  if (!changed) return { changed, topicsChanged };
  await tx.execute(sql`
    UPDATE interest_cards
       SET title = ${entry.title}, topic_ids = ${sql.param([...entry.topicIds])}::text[],
           i18n = ${JSON.stringify(entry.i18n)}::jsonb, slug = ${slug}, retired_at = NULL
     WHERE id = ${card.id}::bigint`);
  if (topicsChanged) await enqueueRematch(workerOutbox(tx), { cardId: card.id });
  return { changed, topicsChanged };
}

/** Why an existing card with the entry's text cannot become this slug's card (or `null` if it can). */
function holdReason(card: CardRow, slug: string): LibraryHoldReason | null {
  if (card.visibility !== 'public') return 'text_is_shared_card';
  if (card.slug !== null && card.slug !== slug) return 'text_has_other_slug';
  if (card.in_chain) return 'text_is_library_version';
  return null;
}

async function insertCard(
  tx: Transaction,
  entry: LibraryCardSeed,
  textHash: string,
  slug: string | null,
): Promise<string | undefined> {
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO interest_cards
      (kind, slug, title, body, text_hash, lang, topic_ids, origin, visibility, i18n)
    VALUES ('interest', ${slug}, ${entry.title}, ${JSON.stringify(body(entry))}::jsonb, ${textHash},
            'en', ${sql.param([...entry.topicIds])}::text[], 'library', 'public',
            ${JSON.stringify(entry.i18n)}::jsonb)
    ON CONFLICT (text_hash) DO NOTHING
    RETURNING id::text AS id`);
  return result.rows[0]?.id;
}

async function seedEntry(tx: Transaction, entry: LibraryCardSeed): Promise<LibrarySeedOutcome> {
  const { slug } = entry;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`library:${slug}`}))`);
  const textHash = librarySeedTextHash(entry);
  const current = await cardBySlug(tx, slug);

  if (current === undefined) {
    // A new slug. A chain without a slug holder is an inconsistent state an admin must resolve.
    if ((await latestVersion(tx, slug)) !== undefined) {
      return { slug, status: 'held', cardId: null, reason: 'version_chain_mismatch' };
    }
    let existing = await cardByHash(tx, textHash);
    if (existing === undefined) {
      const inserted = await insertCard(tx, entry, textHash, slug);
      if (inserted !== undefined) {
        await appendVersion(tx, slug, 1, inserted, null);
        return { slug, status: 'inserted', cardId: inserted };
      }
      existing = await cardByHash(tx, textHash); // inserted concurrently
      if (existing === undefined) throw new Error(`library card ${slug} vanished while seeding`);
    }
    const reason = holdReason(existing, slug);
    if (reason !== null) return { slug, status: 'held', cardId: existing.id, reason };
    await applyMetadata(tx, existing, entry, slug);
    await appendVersion(tx, slug, 1, existing.id, null);
    return { slug, status: 'adopted', cardId: existing.id };
  }

  // A slug card seeded before versions were recorded gets its version 1 first.
  let latest = await latestVersion(tx, slug);
  if (latest === undefined) {
    if (current.in_chain) {
      return { slug, status: 'held', cardId: current.id, reason: 'version_chain_mismatch' };
    }
    await appendVersion(tx, slug, 1, current.id, null);
    latest = { version: 1, cardId: current.id };
  }
  if (latest.cardId !== current.id) {
    return { slug, status: 'held', cardId: current.id, reason: 'version_chain_mismatch' };
  }

  if (current.text_hash === textHash) {
    const { changed, topicsChanged } = await applyMetadata(tx, current, entry, slug);
    return changed
      ? { slug, status: 'updated', cardId: current.id, topicsChanged }
      : { slug, status: 'unchanged', cardId: current.id };
  }

  // A semantic change: the next immutable version takes the slug; the old card stays as it is.
  let next = await cardByHash(tx, textHash);
  if (next === undefined) {
    await insertCard(tx, entry, textHash, null);
    next = await cardByHash(tx, textHash);
    if (next === undefined) throw new Error(`library card ${slug} vanished while seeding`);
  }
  const reason = holdReason(next, slug);
  if (reason !== null) return { slug, status: 'held', cardId: next.id, reason };
  await tx.execute(sql`UPDATE interest_cards SET slug = NULL WHERE id = ${current.id}::bigint`);
  const version = latest.version + 1;
  await appendVersion(tx, slug, version, next.id, current.id);
  await applyMetadata(tx, next, entry, slug);
  return { slug, status: 'versioned', cardId: next.id, previousCardId: current.id, version };
}

/**
 * Seed the library (spec 05 §8): each entry in slug order under its `library:<slug>` lock. Topics
 * must be seeded first (cards may only reference existing topics). Returns one outcome per entry;
 * held entries are reported, not applied.
 */
export async function seedLibraryCards(
  tx: Transaction,
  entries: readonly LibraryCardSeed[],
): Promise<LibrarySeedOutcome[]> {
  const slugs = new Set<string>();
  for (const entry of entries) {
    if (slugs.has(entry.slug)) throw new TypeError(`duplicate library slug ${entry.slug}`);
    slugs.add(entry.slug);
  }
  const outcomes: LibrarySeedOutcome[] = [];
  for (const entry of [...entries].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    outcomes.push(await seedEntry(tx, entry));
  }
  return outcomes;
}
