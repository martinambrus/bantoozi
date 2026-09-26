import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  QuestionSetConflictError,
  checkQuestionSets,
  createDatabase,
  runMigrations,
  type Transaction,
} from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  ENRICH_V1,
  L1_IDS,
  MATCH_V1,
  libraryCardTextHash,
  loadLibraryCards,
  taxonomyTopicRows,
  type LibraryCardEntry,
  type QuestionSetDefinition,
} from '@bantoozi/questions';
import { SEEDED_SETTING_KEYS } from '@bantoozi/shared';
import { canonicalSha256, cardTextHash } from '@bantoozi/shared/server';
import { createUser, dropCreatedTestDatabases, setupTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  QuestionSetMismatchError,
  defaultSeedHooks,
  librarySeedSummary,
  runSeed,
  verifyQuestionSets,
  type SeedHooks,
  type SeedResult,
} from '../src/seed.js';

let worker: pg.Pool;

beforeAll(async () => {
  const testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  worker = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
});

afterAll(async () => {
  await worker.end();
  await dropCreatedTestDatabases();
});

const settings = async () =>
  (
    await worker.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM settings ORDER BY key',
    )
  ).rows;

const env = (languageModes: Record<string, 'native' | 'translate'>) => ({
  dailyBudgetUsd: 5,
  languageModes,
  signupMode: 'invite' as const,
});

describe('pnpm db:seed', () => {
  it('inserts only the three seeded keys, once, and never overwrites them', async () => {
    const first = await runSeed(createDatabase(worker), env({ en: 'native', sk: 'translate' }));
    expect(first.insertedSettings).toEqual([...SEEDED_SETTING_KEYS]);
    const afterFirst = await settings();
    expect(afterFirst).toEqual([
      { key: 'card_text_mode', value: 'as_written' },
      { key: 'language_modes', value: { en: 'native', sk: 'translate' } },
      { key: 'question_sets.active', value: {} },
    ]);

    // A second run with a different LANGUAGE_MODES changes nothing.
    const second = await runSeed(createDatabase(worker), env({ en: 'native', cs: 'native' }));
    expect(second.insertedSettings).toEqual([]);
    expect(await settings()).toEqual(afterFirst);
  });

  it('keeps an administrator’s value and only fills keys that are missing', async () => {
    await worker.query("UPDATE settings SET value = '\"english\"' WHERE key = 'card_text_mode'");
    await worker.query("DELETE FROM settings WHERE key = 'question_sets.active'");
    const result = await runSeed(createDatabase(worker), env({ en: 'native' }));
    expect(result.insertedSettings).toEqual(['question_sets.active']);
    expect(await settings()).toEqual([
      { key: 'card_text_mode', value: 'english' },
      { key: 'language_modes', value: { en: 'native', sk: 'translate' } },
      { key: 'question_sets.active', value: {} },
    ]);
  });

  it('runs the content hooks M2 fills inside the seed transaction', async () => {
    const calls: string[] = [];
    const hook = (name: string) => async (tx: Transaction) => {
      calls.push(name);
      await tx.execute('SELECT 1');
    };
    const hooks: SeedHooks = {
      taxonomy: hook('taxonomy'),
      questionSets: hook('questionSets'),
      library: hook('library'),
    };
    await runSeed(createDatabase(worker), env({ en: 'native' }), hooks);
    expect(calls).toEqual(['taxonomy', 'questionSets', 'library']);

    const failing: SeedHooks = {
      taxonomy: async () => {
        throw new Error('bad taxonomy');
      },
    };
    await worker.query("DELETE FROM settings WHERE key = 'language_modes'");
    await expect(runSeed(createDatabase(worker), env({ en: 'native' }), failing)).rejects.toThrow(
      'bad taxonomy',
    );
    // The whole seed is one transaction: a failing hook leaves nothing half-seeded.
    expect((await settings()).map((s) => s.key)).toEqual([
      'card_text_mode',
      'question_sets.active',
    ]);
  });
});

// ── Content: taxonomy, question sets and the card library (spec 05 §2, §3.2, §8) ────────────────

const ENV = env({ en: 'native' });
const LIBRARY = loadLibraryCards();
const db = () => createDatabase(worker);

async function rows<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return (await worker.query<T>(text, values)).rows;
}

const setting = async (key: string) =>
  (await rows<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value;

/** Every table the content seed writes (or must not write), for before/after comparisons. */
async function snapshot() {
  return {
    topics: await rows('SELECT * FROM topics ORDER BY id'),
    questionSets: await rows('SELECT * FROM question_sets ORDER BY id'),
    cards: await rows('SELECT * FROM interest_cards ORDER BY id'),
    versions: await rows('SELECT * FROM library_card_versions ORDER BY library_slug, version'),
    settings: await rows('SELECT key, value, updated_at FROM settings ORDER BY key'),
    outbox: await rows('SELECT id, queue, payload, available_at FROM job_outbox ORDER BY id'),
    holdings: await rows('SELECT * FROM user_cards ORDER BY user_id, card_id'),
  };
}

type CardRow = {
  id: string;
  slug: string | null;
  title: string;
  body: Record<string, unknown>;
  text_hash: string;
  lang: string;
  topic_ids: string[];
  origin: string;
  visibility: string;
  i18n: unknown;
  retired_at: Date | null;
  created_at: Date;
};

const CARD_SQL = `SELECT id::text AS id, slug, title, body, text_hash, lang, topic_ids, origin,
                         visibility, i18n, retired_at, created_at FROM interest_cards`;

async function card(column: 'slug' | 'id', value: string): Promise<CardRow> {
  const [row] = await rows<CardRow>(`${CARD_SQL} WHERE ${column} = $1`, [value]);
  if (row === undefined) throw new Error(`no card with ${column} ${value}`);
  return row;
}

const versionsOf = (slug: string) =>
  rows<{ version: number; card_id: string; previous_card_id: string | null }>(
    `SELECT version, card_id::text AS card_id, previous_card_id::text AS previous_card_id
       FROM library_card_versions WHERE library_slug = $1 ORDER BY version`,
    [slug],
  );

const rematches = () =>
  rows<{ payload: unknown; delivered_at: Date | null }>(
    "SELECT payload, delivered_at FROM job_outbox WHERE queue = 'house.rematch' ORDER BY id",
  );

const withEntry = (slug: string, change: (entry: LibraryCardEntry) => LibraryCardEntry) =>
  LIBRARY.map((entry) => (entry.slug === slug ? change(entry) : entry));

const outcomeOf = (result: SeedResult, slug: string) =>
  result.library?.find((outcome) => outcome.slug === slug);

const summary = (counts: Partial<ReturnType<typeof librarySeedSummary>>) => ({
  inserted: 0,
  adopted: 0,
  updated: 0,
  versioned: 0,
  unchanged: 0,
  held: 0,
  ...counts,
});

/** A shared (user) interest card with the given text, as the card lifecycle would create it. */
async function sharedCard(text: { interest: string; not_for: string }): Promise<string> {
  const creator = await createUser(worker);
  const hash = cardTextHash({ kind: 'interest', title: 'Mine', ...text, visibility: 'shared' });
  const [row] = await rows<{ id: string }>(
    `INSERT INTO interest_cards (kind, title, body, text_hash, lang, origin, visibility, creator_user_id)
     VALUES ('interest', 'Mine', $1::jsonb, $2, 'en', 'user', 'shared', $3) RETURNING id::text AS id`,
    [JSON.stringify(text), hash, creator.id],
  );
  if (row === undefined) throw new Error('no shared card');
  return row.id;
}

class Rollback extends Error {}

describe('pnpm db:seed content (spec 05 §2, §3.2, §8)', () => {
  it('seeds the topics with their parents, every question set and the ≥ 150-card library', async () => {
    const result = await runSeed(db(), ENV, defaultSeedHooks());
    const topicRows = taxonomyTopicRows();
    expect(result.insertedSettings).toEqual(['language_modes']);
    expect(result.topics).toEqual({ inserted: topicRows.length, updated: 0, unchanged: 0 });

    // Topics: exactly the code taxonomy; 20 level-1 roots and every level-2 topic under one.
    const topics = await rows(
      'SELECT id, parent_id, level, name_en, name_sk, description, sort FROM topics ORDER BY id COLLATE "C"',
    );
    expect(topics).toEqual(
      topicRows
        .map((row) => ({
          id: row.id,
          parent_id: row.parentId,
          level: row.level,
          name_en: row.nameEn,
          name_sk: row.nameSk,
          description: row.description,
          sort: row.sort,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    const levelOne = await rows<{ id: string }>(
      'SELECT id FROM topics WHERE level = 1 AND parent_id IS NULL ORDER BY sort',
    );
    expect(levelOne.map((row) => row.id)).toEqual([...L1_IDS]);
    const orphans = await rows(`
      SELECT c.id FROM topics c LEFT JOIN topics p ON p.id = c.parent_id
       WHERE c.level = 2 AND (p.id IS NULL OR p.level <> 1 OR c.id NOT LIKE p.id || '.%')`);
    expect(orphans).toEqual([]);
    expect(topics.length).toBeGreaterThan(L1_IDS.length);

    // Question sets: stored as the code defines them; every kind was absent, so each is active.
    const sets = await rows<{
      id: string;
      kind: string;
      version: string;
      sha256: string;
      definition: unknown;
    }>('SELECT id::text AS id, kind, version, sha256, definition FROM question_sets ORDER BY id');
    expect(sets.map(({ kind, version, sha256 }) => ({ kind, version, sha256 }))).toEqual(
      ALL_QUESTION_SETS.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })),
    );
    for (const set of sets) {
      expect(canonicalSha256(set.definition), set.version).toBe(set.sha256);
    }
    const ids = Object.fromEntries(sets.map((set) => [set.version, set.id]));
    expect(result.questionSets).toEqual({
      ids,
      inserted: ['enrich-v1', 'match-v1', 'cluster-v1', 'suggest-v1'],
      activated: ['enrich', 'match', 'cluster', 'suggest'],
    });
    expect(await setting('question_sets.active')).toEqual({
      enrich: ids['enrich-v1'],
      match: ids['match-v1'],
      cluster: ids['cluster-v1'],
      suggest: ids['suggest-v1'],
    });
    expect(Object.values(ids).every((id) => /^[1-9][0-9]*$/.test(id))).toBe(true);
    await expect(verifyQuestionSets(db())).resolves.toBeUndefined();

    // The library: every entry a public library card with version 1 of its slug.
    expect(LIBRARY.length).toBeGreaterThanOrEqual(150);
    expect(librarySeedSummary(result.library ?? [])).toEqual(summary({ inserted: LIBRARY.length }));
    const cards = await rows<CardRow>(`${CARD_SQL} WHERE origin = 'library' ORDER BY slug`);
    expect(cards).toHaveLength(LIBRARY.length);
    const bySlug = new Map(cards.map((row) => [row.slug, row]));
    for (const entry of LIBRARY) {
      const row = bySlug.get(entry.slug);
      expect(row, entry.slug).toMatchObject({
        title: entry.title,
        text_hash: cardTextHash({
          kind: 'interest',
          title: entry.title,
          interest: entry.interest,
          not_for: entry.not_for ?? null,
          examples_yes: entry.examples_yes ?? null,
          examples_no: entry.examples_no ?? null,
          visibility: 'public',
        }),
        lang: 'en',
        topic_ids: entry.topic_ids,
        origin: 'library',
        visibility: 'public',
        i18n: { sk: { title: entry.title_sk, interest: entry.interest_sk } },
        retired_at: null,
      });
      // The body holds exactly the text fields the entry has.
      expect(row?.body, entry.slug).toStrictEqual({
        interest: entry.interest,
        ...(entry.not_for === undefined ? {} : { not_for: entry.not_for }),
        ...(entry.examples_yes === undefined ? {} : { examples_yes: entry.examples_yes }),
        ...(entry.examples_no === undefined ? {} : { examples_no: entry.examples_no }),
      });
      expect(row?.text_hash, entry.slug).toBe(libraryCardTextHash(entry));
    }
    expect(
      await rows(
        `SELECT library_slug, version, card_id::text, previous_card_id::text
           FROM library_card_versions ORDER BY library_slug`,
      ),
    ).toEqual(
      cards.map((row) => ({
        library_slug: row.slug,
        version: 1,
        card_id: row.id,
        previous_card_id: null,
      })),
    );
    // New cards have no holders: nothing to rematch.
    expect(await rematches()).toEqual([]);
  });

  it('changes nothing when it runs again', async () => {
    const before = await snapshot();
    const result = await runSeed(db(), ENV, defaultSeedHooks());
    expect(result.insertedSettings).toEqual([]);
    expect(result.topics).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: taxonomyTopicRows().length,
    });
    expect(result.questionSets).toMatchObject({ inserted: [], activated: [] });
    expect(librarySeedSummary(result.library ?? [])).toEqual(
      summary({ unchanged: LIBRARY.length }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it('fills question_sets.active only for kinds that are absent', async () => {
    const active = (await setting('question_sets.active')) as Record<string, string>;
    // An administrator activated an older enrich set; match and suggest are absent.
    const oldDefinition = { kind: 'enrich', version: 'enrich-v0-test', questions: {} };
    const [old] = await rows<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('enrich', 'enrich-v0-test', $1, $2::jsonb) RETURNING id::text AS id`,
      [canonicalSha256(oldDefinition), JSON.stringify(oldDefinition)],
    );
    const manual = { enrich: old?.id, cluster: active['cluster'] };
    await worker.query("UPDATE settings SET value = $1 WHERE key = 'question_sets.active'", [
      JSON.stringify(manual),
    ]);

    const result = await runSeed(db(), ENV, defaultSeedHooks());
    expect(result.questionSets).toMatchObject({ inserted: [], activated: ['match', 'suggest'] });
    expect(await setting('question_sets.active')).toEqual({
      ...manual,
      match: active['match'],
      suggest: active['suggest'],
    });
    // The startup check refuses an active set the code does not know.
    const check = verifyQuestionSets(db());
    await expect(check).rejects.toBeInstanceOf(QuestionSetMismatchError);
    await expect(check).rejects.toThrow('active enrich set enrich-v0-test is unknown to this code');

    await worker.query("UPDATE settings SET value = $1 WHERE key = 'question_sets.active'", [
      JSON.stringify(active),
    ]);
    await expect(verifyQuestionSets(db())).resolves.toBeUndefined();
  });

  it('fails when a stored version has another sha256 and leaves nothing half-seeded', async () => {
    const reworded = structuredClone(MATCH_V1.definition) as Record<string, unknown>;
    reworded['card'] = { type: 'noul', instructions: 'Would the reader want `article`?' };
    const changed: QuestionSetDefinition = {
      ...MATCH_V1,
      definition: reworded as QuestionSetDefinition['definition'],
      sha256: canonicalSha256(reworded),
    };
    await worker.query("DELETE FROM settings WHERE key = 'language_modes'");
    const before = await snapshot();
    const run = runSeed(db(), ENV, defaultSeedHooks({ questionSets: [ENRICH_V1, changed] }));
    await expect(run).rejects.toBeInstanceOf(QuestionSetConflictError);
    await expect(run).rejects.toThrow(
      'question set match-v1 is stored with a different sha256; changed wording needs a new version',
    );
    // A set whose hash is not its definition's is refused before anything is written.
    await expect(
      runSeed(
        db(),
        ENV,
        defaultSeedHooks({ questionSets: [{ ...MATCH_V1, sha256: '0'.repeat(64) }] }),
      ),
    ).rejects.toThrow('question set match-v1: sha256 does not match its definition');
    // So is a taxonomy with a level-2 topic outside a level-1 parent.
    await expect(
      runSeed(
        db(),
        ENV,
        defaultSeedHooks({
          topics: [
            ...taxonomyTopicRows(),
            {
              id: 'ghost.child',
              parentId: 'ghost',
              level: 2,
              nameEn: 'Ghost',
              nameSk: 'Duch',
              description: 'Ghost',
              sort: 1,
            },
          ],
        }),
      ),
    ).rejects.toThrow('ghost.child: parent ghost is not a level-1 topic');
    expect(await snapshot()).toEqual(before);

    // The startup check names every disagreement (seen inside a transaction that is rolled back).
    const ids = (await setting('question_sets.active')) as Record<string, string>;
    await expect(
      db().transaction(async (tx) => {
        await tx.execute(
          `UPDATE question_sets SET definition = definition || '{"note": "edited"}'::jsonb
            WHERE version = 'match-v1'`,
        );
        await tx.execute(
          "UPDATE question_sets SET sha256 = repeat('0', 64) WHERE version = 'cluster-v1'",
        );
        await tx.execute("DELETE FROM question_sets WHERE version = 'suggest-v1'");
        expect(await checkQuestionSets(tx, ALL_QUESTION_SETS)).toEqual([
          'question set match-v1: the stored definition does not match its sha256',
          `question set cluster-v1 differs from the code (sha256 ${'0'.repeat(64)})`,
          'question set suggest-v1 is not seeded (run pnpm db:seed)',
          'active cluster set cluster-v1 is unknown to this code',
          `question_sets.active.suggest names no suggest set (id ${ids['suggest']})`,
        ]);
        await expect(verifyQuestionSets(tx)).rejects.toBeInstanceOf(QuestionSetMismatchError);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    await expect(verifyQuestionSets(db())).resolves.toBeUndefined();

    const restored = await runSeed(db(), ENV, defaultSeedHooks());
    expect(restored.insertedSettings).toEqual(['language_modes']);
  });

  it('updates a topic_ids-only change in place and records house.rematch for that card', async () => {
    const original = await card('slug', 'space-launches');
    const topicIds = ['science.space', 'technology.hardware_gadgets'];
    const moved = withEntry('space-launches', (entry) => ({ ...entry, topic_ids: topicIds }));

    const result = await runSeed(db(), ENV, defaultSeedHooks({ library: moved }));
    expect(outcomeOf(result, 'space-launches')).toEqual({
      slug: 'space-launches',
      status: 'updated',
      cardId: original.id,
      topicsChanged: true,
    });
    expect(librarySeedSummary(result.library ?? [])).toEqual(
      summary({ updated: 1, unchanged: LIBRARY.length - 1 }),
    );
    // Same card and text: only the topics changed; no new version.
    expect(await card('slug', 'space-launches')).toEqual({ ...original, topic_ids: topicIds });
    expect(await versionsOf('space-launches')).toEqual([
      { version: 1, card_id: original.id, previous_card_id: null },
    ]);
    expect(await rematches()).toEqual([{ payload: { cardId: original.id }, delivered_at: null }]);

    // A cosmetic title/i18n correction updates in place too, without a rematch.
    const retitled = withEntry('space-launches', (entry) => ({
      ...entry,
      title: 'Rocket launches',
      title_sk: 'Štarty rakiet',
      topic_ids: topicIds,
    }));
    const cosmetic = await runSeed(db(), ENV, defaultSeedHooks({ library: retitled }));
    expect(outcomeOf(cosmetic, 'space-launches')).toEqual({
      slug: 'space-launches',
      status: 'updated',
      cardId: original.id,
      topicsChanged: false,
    });
    expect(await card('slug', 'space-launches')).toMatchObject({
      id: original.id,
      text_hash: original.text_hash,
      title: 'Rocket launches',
      i18n: { sk: { title: 'Štarty rakiet' } },
    });
    expect(await rematches()).toHaveLength(1);

    // Back to the shipped entry; the pending identical rematch intent coalesces.
    const restored = await runSeed(db(), ENV, defaultSeedHooks());
    expect(outcomeOf(restored, 'space-launches')).toMatchObject({
      status: 'updated',
      topicsChanged: true,
    });
    expect(await card('slug', 'space-launches')).toEqual(original);
    expect(await rematches()).toEqual([{ payload: { cardId: original.id }, delivered_at: null }]);
  });

  it('holds an entry whose text is a shared card instead of promoting it', async () => {
    const text = {
      interest: 'Rocket launches, crewed missions and launch schedules',
      not_for: 'Astrology; sci-fi films',
    };
    const shared = await sharedCard(text);
    const library = [
      ...withEntry('space-launches', (entry) => ({ ...entry, ...text })),
      {
        slug: 'launch-schedules',
        title: 'Launch schedules',
        title_sk: 'Harmonogram štartov',
        ...text,
        topic_ids: ['science.space'],
      },
    ];
    const before = await snapshot();
    const result = await runSeed(db(), ENV, defaultSeedHooks({ library }));
    expect(outcomeOf(result, 'space-launches')).toEqual({
      slug: 'space-launches',
      status: 'held',
      cardId: shared,
      reason: 'text_is_shared_card',
    });
    expect(outcomeOf(result, 'launch-schedules')).toEqual({
      slug: 'launch-schedules',
      status: 'held',
      cardId: shared,
      reason: 'text_is_shared_card',
    });
    // Nothing changed: the shared card is not published, the slug stays, no version is added.
    expect(await snapshot()).toEqual(before);
    expect(await card('id', shared)).toMatchObject({ visibility: 'shared', slug: null });
  });

  it('adopts a public card with the same text for a new slug', async () => {
    const entry: LibraryCardEntry = {
      slug: 'orienteering',
      title: 'Orienteering',
      title_sk: 'Orientačný beh',
      interest: 'Orienteering races, maps and club events',
      interest_sk: 'Preteky v orientačnom behu, mapy a klubové podujatia',
      topic_ids: ['sports.other_sports'],
    };
    const hash = libraryCardTextHash(entry);
    const [existing] = await rows<{ id: string }>(
      `INSERT INTO interest_cards (kind, title, body, text_hash, lang, origin, visibility)
       VALUES ('interest', 'Old title', $1::jsonb, $2, 'en', 'library', 'public')
       RETURNING id::text AS id`,
      [JSON.stringify({ interest: entry.interest }), hash],
    );
    const id = existing?.id ?? '';

    const result = await runSeed(db(), ENV, defaultSeedHooks({ library: [...LIBRARY, entry] }));
    expect(outcomeOf(result, 'orienteering')).toEqual({
      slug: 'orienteering',
      status: 'adopted',
      cardId: id,
    });
    expect(await card('slug', 'orienteering')).toMatchObject({
      id,
      title: 'Orienteering',
      topic_ids: ['sports.other_sports'],
      i18n: { sk: { title: entry.title_sk, interest: entry.interest_sk } },
    });
    expect(await versionsOf('orienteering')).toEqual([
      { version: 1, card_id: id, previous_card_id: null },
    ]);
    // Its topics changed from none: its prefilter markers are re-evaluated.
    expect(await rematches()).toContainEqual({ payload: { cardId: id }, delivered_at: null });

    const again = await runSeed(db(), ENV, defaultSeedHooks({ library: [...LIBRARY, entry] }));
    expect(outcomeOf(again, 'orienteering')).toEqual({
      slug: 'orienteering',
      status: 'unchanged',
      cardId: id,
    });
  });

  it('versions a semantic change: the slug moves, the old card stays with its holders', async () => {
    const old = await card('slug', 'rust-lang');
    const holder = await createUser(worker);
    await worker.query(
      `INSERT INTO user_cards (user_id, card_id, strength, title_override)
       VALUES ($1, $2, 'love', 'My Rust')`,
      [holder.id, old.id],
    );
    const holdings = await rows('SELECT * FROM user_cards ORDER BY user_id, card_id');
    const outbox = await rows('SELECT id FROM job_outbox ORDER BY id');

    const interest =
      'The Rust programming language: releases, crates, compiler tooling and real-world use';
    const examples = ['Rust 1.90 ships a faster compiler'];
    const changed = withEntry('rust-lang', (entry) => ({
      ...entry,
      interest,
      examples_yes: examples,
    }));
    const result = await runSeed(db(), ENV, defaultSeedHooks({ library: changed }));
    const next = await card('slug', 'rust-lang');
    expect(next.id).not.toBe(old.id);
    expect(outcomeOf(result, 'rust-lang')).toEqual({
      slug: 'rust-lang',
      status: 'versioned',
      cardId: next.id,
      previousCardId: old.id,
      version: 2,
    });
    expect(librarySeedSummary(result.library ?? [])).toEqual(
      summary({ versioned: 1, unchanged: LIBRARY.length - 1 }),
    );
    expect(next).toMatchObject({
      title: old.title,
      body: { interest, not_for: 'Rust the video game; corrosion', examples_yes: examples },
      lang: 'en',
      topic_ids: old.topic_ids,
      origin: 'library',
      visibility: 'public',
      i18n: old.i18n,
      retired_at: null,
    });
    // The old card keeps its text, stays readable and unretired; it only lost the slug.
    expect(await card('id', old.id)).toEqual({ ...old, slug: null });
    // Holders are never re-pointed or rematched.
    expect(await rows('SELECT * FROM user_cards ORDER BY user_id, card_id')).toEqual(holdings);
    expect(await rows('SELECT id FROM job_outbox ORDER BY id')).toEqual(outbox);
    expect(await versionsOf('rust-lang')).toEqual([
      { version: 1, card_id: old.id, previous_card_id: null },
      { version: 2, card_id: next.id, previous_card_id: old.id },
    ]);

    // Idempotent: the same library again changes nothing.
    const before = await snapshot();
    const again = await runSeed(db(), ENV, defaultSeedHooks({ library: changed }));
    expect(outcomeOf(again, 'rust-lang')).toEqual({
      slug: 'rust-lang',
      status: 'unchanged',
      cardId: next.id,
    });
    expect(await snapshot()).toEqual(before);

    // Reverting to the old text cannot append the old card again: it is held and reported.
    const reverted = await runSeed(db(), ENV, defaultSeedHooks());
    expect(outcomeOf(reverted, 'rust-lang')).toEqual({
      slug: 'rust-lang',
      status: 'held',
      cardId: old.id,
      reason: 'text_is_library_version',
    });
    expect(await snapshot()).toEqual(before);
  });
});
