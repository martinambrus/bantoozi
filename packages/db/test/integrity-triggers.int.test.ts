import { randomUUID } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  type Queryable,
} from '@bantoozi/testing';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asTenant, setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * Integrity triggers of 0004_triggers.sql (spec 02 §5.2; §8 items 3 and 11). Every trigger gets
 * an allowed case and each rejection rule, written through the role the rule is about:
 * bantoozi_app as a tenant (RLS and column grants), the BYPASSRLS worker, or the owner that runs
 * the SECURITY DEFINER functions. Violations are SQLSTATE 23514 naming the trigger as the
 * constraint; the deferred constraint triggers fail at COMMIT on the final row state.
 */

let ctx: DbTestContext;

const SUGGEST_SET_VERSION = 'integrity-suggest-v1';
const PROMOTION = 'bantoozi.card_promotion';
const RESPONSE = 'bantoozi.card_publication_response';
const RETRANSLATION = 'bantoozi.card_retranslation';

beforeAll(async () => {
  ctx = await setupDbTest();
  await insertTopics(ctx.owner, [
    ['technology', null, 1],
    ['technology.ai_ml', 'technology', 2],
  ]);
  await ctx.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('suggest', $1, repeat('5', 64), '{}')`,
    [SUGGEST_SET_VERSION],
  );
});

afterAll(async () => {
  await ctx.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

type Settings = Readonly<Record<string, string>>;
type Kind = 'interest' | 'label';

/** `fn` inside BEGIN … COMMIT on one connection of `pool`, with transaction-local settings. */
function inTx<T>(
  pool: Pool,
  settings: Settings,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return asTenant(pool, null, async (client) => {
    for (const [name, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    return fn(client);
  });
}

/** One statement in its own transaction, so deferred checks run at its COMMIT. */
function execute(
  pool: Pool,
  text: string,
  params: unknown[] = [],
  settings: Settings = {},
): Promise<QueryResult> {
  return inTx(pool, settings, (client) => client.query(text, params));
}

/** One statement as bantoozi_app in a tenant transaction (`null`: no tenant context). */
function asApp(tenant: string | null, text: string, params: unknown[] = []): Promise<QueryResult> {
  return asTenant(ctx.appPool, tenant, (client) => client.query(text, params));
}

interface DbFailure {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  detail?: unknown;
}

/** The write fails with SQLSTATE 23514 raised by `constraint` (an integrity trigger or a CHECK). */
async function expectViolation(
  write: Promise<unknown>,
  constraint: string,
  label = constraint,
): Promise<DbFailure> {
  const failure = await write.then(
    () => null,
    (error: unknown) => error as DbFailure,
  );
  expect(failure, `${label}: expected the write to be rejected`).not.toBeNull();
  expect(
    { code: failure?.code, constraint: failure?.constraint, message: failure?.message },
    label,
  ).toMatchObject({ code: '23514', constraint });
  return failure ?? {};
}

/** The write succeeds and changes exactly one row. */
async function expectOneRow(write: Promise<{ rowCount: number | null }>): Promise<void> {
  expect((await write).rowCount).toBe(1);
}

/** The first row of an owner query (the owner sees every row). */
async function ownerRow<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await ctx.owner.query<T>(text, params);
  const first = rows[0];
  if (first === undefined) throw new Error(`no row for: ${text}`);
  return first;
}

/** Hex sha256 of PostgreSQL's normalized jsonb text, as the triggers hash inputs and proposals. */
async function jsonbSha(json: string): Promise<string> {
  const { sha } = await ownerRow<{ sha: string }>(
    `SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') AS sha`,
    [json],
  );
  return sha;
}

async function newUser(overrides: Parameters<typeof createUser>[1] = {}): Promise<string> {
  return (await createUser(ctx.owner, overrides)).id;
}

async function newCard(overrides: Parameters<typeof createCard>[1] = {}): Promise<string> {
  return (await createCard(ctx.owner, overrides)).id;
}

/** A card body with a `not_for`; the derived English pair is absent unless given. */
function cardBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interest: 'Solid-state battery chemistry',
    not_for: 'Share-price moves',
    interest_en: null,
    not_for_en: null,
    ...fields,
  };
}

interface CardInput {
  kind?: Kind;
  visibility?: 'public' | 'shared' | 'private';
  ownerUserId?: string;
  creatorUserId?: string | null;
  parentCardId?: string;
  title?: string;
  body?: Record<string, unknown>;
  topicIds?: readonly (string | null)[];
}

/** A card with any body, topics or parent; `text_hash` is a unique stand-in (never recomputed). */
async function insertCard(db: Queryable, input: CardInput = {}): Promise<string> {
  const visibility = input.visibility ?? 'shared';
  const ownerUserId = visibility === 'private' ? (input.ownerUserId ?? null) : null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO interest_cards (kind, title, body, text_hash, topic_ids, origin, visibility,
                                 parent_card_id, owner_user_id, creator_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
    [
      input.kind ?? 'interest',
      input.title ?? 'Integrity card',
      JSON.stringify(input.body ?? cardBody()),
      `integrity-${randomUUID()}`,
      input.topicIds ?? [],
      visibility === 'private' ? 'fork' : visibility === 'public' ? 'library' : 'user',
      visibility,
      input.parentCardId ?? null,
      ownerUserId,
      input.creatorUserId === undefined ? ownerUserId : input.creatorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('card insert returned no id');
  return id;
}

/** Topic rows `[id, parent, level]` in one multi-row INSERT. */
function insertTopics(
  db: Queryable,
  topics: readonly (readonly [id: string, parent: string | null, level: 1 | 2])[],
): Promise<unknown> {
  const values = topics.map(
    (_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, 'Topic', 'Téma', 'A test topic')`,
  );
  return db.query(
    `INSERT INTO topics (id, parent_id, level, name_en, name_sk, description)
     VALUES ${values.join(', ')}`,
    topics.flatMap(([id, parent, level]) => [id, parent, level]),
  );
}

// ── Card holdings ───────────────────────────────────────────────────────────────────────────────

interface HoldingTable {
  table: 'user_cards' | 'user_labels' | 'card_suggestions';
  trigger: string;
  kind: Kind;
  wrongKind: Kind;
  /** The production writer: the API for the holder (RLS), or the worker. */
  writer: 'app' | 'worker';
  /** $1 holder, $2 card. */
  insert: string;
}

const HOLDING_TABLES: readonly HoldingTable[] = [
  {
    table: 'user_cards',
    trigger: 'user_cards_card_check',
    kind: 'interest',
    wrongKind: 'label',
    writer: 'app',
    insert: `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
  },
  {
    table: 'user_labels',
    trigger: 'user_labels_card_check',
    kind: 'label',
    wrongKind: 'interest',
    writer: 'app',
    insert: `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`,
  },
  {
    table: 'card_suggestions',
    trigger: 'card_suggestions_card_check',
    kind: 'interest',
    wrongKind: 'label',
    writer: 'worker',
    insert: `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
             VALUES ($1, $2,
                     (SELECT id FROM question_sets WHERE version = '${SUGGEST_SET_VERSION}'),
                     'jev-test', 0.5)`,
  },
];

for (const holding of HOLDING_TABLES) {
  describe(`card_holding_check: ${holding.table} (${holding.kind}, ${holding.writer})`, () => {
    const write = (holder: string, text: string, params: unknown[]) =>
      holding.writer === 'app'
        ? asApp(holder, text, params)
        : execute(ctx.workerPool, text, params);
    const hold = (holder: string, card: string) => write(holder, holding.insert, [holder, card]);
    const repoint = (holder: string, from: string, to: string) =>
      write(
        holder,
        `UPDATE ${holding.table} SET card_id = $3 WHERE user_id = $1 AND card_id = $2`,
        [holder, from, to],
      );

    it("allows the holder's own private card and shared and public cards", async () => {
      const holder = await newUser();
      const author = await newUser();
      const cards = [
        await newCard({ kind: holding.kind, visibility: 'private', ownerUserId: holder }),
        await newCard({ kind: holding.kind, visibility: 'shared', creatorUserId: author }),
        await newCard({ kind: holding.kind, visibility: 'public' }),
      ];
      for (const card of cards) await expectOneRow(hold(holder, card));
      const held = await ctx.owner.query<{ card_id: string }>(
        `SELECT card_id::text AS card_id FROM ${holding.table} WHERE user_id = $1 ORDER BY card_id`,
        [holder],
      );
      expect(held.rows.map((row) => row.card_id)).toEqual(cards);
    });

    it(`rejects a card of the wrong kind (${holding.wrongKind}), shared or own`, async () => {
      const holder = await newUser();
      const shared = await newCard({ kind: holding.wrongKind });
      const own = await newCard({
        kind: holding.wrongKind,
        visibility: 'private',
        ownerUserId: holder,
      });
      await expectViolation(hold(holder, shared), holding.trigger, 'shared');
      await expectViolation(hold(holder, own), holding.trigger, 'own private');
    });

    it("rejects another user's private card, for the worker too, revealing nothing", async () => {
      const holder = await newUser();
      const forkOwner = await newUser();
      const foreign = await newCard({
        kind: holding.kind,
        visibility: 'private',
        ownerUserId: forkOwner,
      });
      const failures = [
        await expectViolation(hold(holder, foreign), holding.trigger, holding.writer),
        await expectViolation(
          ctx.workerPool.query(holding.insert, [holder, foreign]),
          holding.trigger,
          'worker',
        ),
      ];
      for (const failure of failures) {
        const reported = `${String(failure.message)} ${String(failure.detail ?? '')}`;
        expect(reported).not.toContain(forkOwner);
        expect(reported).not.toMatch(new RegExp(`\\b${foreign}\\b`));
      }
    });

    it('rejects a missing card', async () => {
      const holder = await newUser();
      await expectViolation(hold(holder, '999999999999'), holding.trigger);
    });

    it('re-checks the card and the holder on UPDATE', async () => {
      const holder = await newUser();
      const other = await newUser();
      const shared = await newCard({ kind: holding.kind });
      const own = await newCard({ kind: holding.kind, visibility: 'private', ownerUserId: holder });
      const foreign = await newCard({
        kind: holding.kind,
        visibility: 'private',
        ownerUserId: other,
      });
      const wrongKind = await newCard({ kind: holding.wrongKind });
      await expectOneRow(hold(holder, shared));
      await expectViolation(repoint(holder, shared, foreign), holding.trigger, 'foreign fork');
      await expectViolation(repoint(holder, shared, wrongKind), holding.trigger, 'wrong kind');
      await expectOneRow(repoint(holder, shared, own));
      // Moving a private-card holding to another user (a worker write) is re-checked too.
      await expectViolation(
        ctx.workerPool.query(
          `UPDATE ${holding.table} SET user_id = $2 WHERE user_id = $1 AND card_id = $3`,
          [holder, other, own],
        ),
        holding.trigger,
        'holder change',
      );
    });
  });
}

// ── Interest cards: content ─────────────────────────────────────────────────────────────────────

describe('interest_cards_content_check', () => {
  const TRIGGER = 'interest_cards_content_check';
  const apiInsert = (author: string, input: CardInput) =>
    asTenant(ctx.appPool, author, (client) =>
      insertCard(client, { creatorUserId: author, ...input }),
    );

  it('accepts an absent or complete English pair and existing topics (API insert)', async () => {
    const author = await newUser();
    const bodies = [
      cardBody(),
      { interest: 'No derived keys at all', not_for: 'Share-price moves' },
      cardBody({ interest_en: 'Solid-state batteries', not_for_en: 'Share prices' }),
      cardBody({ not_for: null, interest_en: 'Solid-state batteries' }),
    ];
    for (const body of bodies) {
      await apiInsert(author, { body, topicIds: ['technology', 'technology.ai_ml'] });
    }
  });

  it('rejects an incomplete or malformed English pair on insert', async () => {
    const author = await newUser();
    const invalid: [string, Record<string, unknown>][] = [
      ['interest_en without the not_for_en the card needs', cardBody({ interest_en: 'Batteries' })],
      ['not_for_en without interest_en', cardBody({ not_for_en: 'Share prices' })],
      [
        'not_for_en on a card without not_for',
        cardBody({ not_for: null, interest_en: 'Batteries', not_for_en: 'Share prices' }),
      ],
      ['empty interest_en', cardBody({ interest_en: '', not_for_en: 'Share prices' })],
      ['blank not_for_en', cardBody({ interest_en: 'Batteries', not_for_en: '   ' })],
      ['non-string interest_en', cardBody({ interest_en: 42, not_for_en: 'Share prices' })],
    ];
    for (const [label, body] of invalid) {
      await expectViolation(apiInsert(author, { body }), TRIGGER, label);
    }
  });

  it('rejects an unknown or NULL topic id on insert', async () => {
    const author = await newUser();
    await expectViolation(
      apiInsert(author, { topicIds: ['technology', 'no.such.topic'] }),
      TRIGGER,
      'unknown topic',
    );
    await expectViolation(
      apiInsert(author, { topicIds: ['technology', null] }),
      TRIGGER,
      'NULL topic',
    );
  });

  it('re-checks topics and the pair when they change', async () => {
    const admin = await newUser({ role: 'admin' });
    const card = await insertCard(ctx.owner);
    await expectViolation(
      asApp(
        admin,
        `UPDATE interest_cards SET topic_ids = ARRAY['technology', NULL] WHERE id = $1`,
        [card],
      ),
      TRIGGER,
      'admin: NULL topic',
    );
    await expectViolation(
      ctx.workerPool.query(
        `UPDATE interest_cards SET topic_ids = '{no.such.topic}' WHERE id = $1`,
        [card],
      ),
      TRIGGER,
      'worker: unknown topic',
    );
    await expectViolation(
      ctx.workerPool.query(
        `UPDATE interest_cards SET body = body || '{"not_for_en": "Share prices"}' WHERE id = $1`,
        [card],
      ),
      TRIGGER,
      'worker: half a pair',
    );
    await expectOneRow(
      asApp(admin, `UPDATE interest_cards SET topic_ids = '{technology.ai_ml}' WHERE id = $1`, [
        card,
      ]),
    );
  });
});

// ── Interest cards: guard ───────────────────────────────────────────────────────────────────────

describe('interest_cards_guard', () => {
  const TRIGGER = 'interest_cards_guard';
  const ownerAndWorker = (): [string, Pool][] => [
    ['worker', ctx.workerPool],
    ['owner', ctx.owner],
  ];

  describe('identity', () => {
    const IDENTITY_EDITS: readonly (readonly [string, string])[] = [
      ['id', 'id = DEFAULT'],
      ['kind', `kind = 'label'`],
      ['text_hash', `text_hash = text_hash || '-edited'`],
      ['lang', `lang = 'sk'`],
      ['origin', `origin = 'library'`],
      ['created_at', `created_at = created_at - interval '1 day'`],
      ['the base interest text', `body = jsonb_set(body, '{interest}', '"Edited interest"')`],
      ['the base exclusion text', `body = jsonb_set(body, '{not_for}', '"Edited exclusion"')`],
      ['the examples', `body = body || '{"examples_yes": ["An added example"]}'`],
    ];

    for (const [name, assignment] of IDENTITY_EDITS) {
      it(`rejects changing ${name}, as the worker and as the owner`, async () => {
        const card = await insertCard(ctx.owner);
        for (const [role, pool] of ownerAndWorker()) {
          await expectViolation(
            pool.query(`UPDATE interest_cards SET ${assignment} WHERE id = $1`, [card]),
            TRIGGER,
            role,
          );
        }
      });
    }

    it('rejects moving a private card to another owner', async () => {
      const forkOwner = await newUser();
      const other = await newUser();
      const fork = await insertCard(ctx.owner, { visibility: 'private', ownerUserId: forkOwner });
      for (const [role, pool] of ownerAndWorker()) {
        await expectViolation(
          pool.query('UPDATE interest_cards SET owner_user_id = $2 WHERE id = $1', [fork, other]),
          TRIGGER,
          role,
        );
      }
    });

    it('rejects renaming a label (its title is hashed), as worker and owner', async () => {
      const label = await insertCard(ctx.owner, { kind: 'label' });
      for (const [role, pool] of ownerAndWorker()) {
        await expectViolation(
          pool.query(`UPDATE interest_cards SET title = 'Renamed label' WHERE id = $1`, [label]),
          TRIGGER,
          role,
        );
      }
    });

    it('lets the worker and the owner maintain metadata without touching identity', async () => {
      const card = await insertCard(ctx.owner);
      await expectOneRow(
        ctx.workerPool.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [card]),
      );
      await expectOneRow(
        ctx.owner.query(
          `UPDATE interest_cards SET title = 'Maintained title', topic_ids = '{technology}',
                  i18n = '{"sk": {"title": "Udržiavaný názov"}}', slug = $2, retired_at = NULL
            WHERE id = $1`,
          [card, `integrity-${randomUUID()}`],
        ),
      );
    });
  });

  describe('authorship (creator_user_id)', () => {
    it('rejects clearing or reassigning the creator while the creator is active', async () => {
      const creator = await newUser();
      const other = await newUser();
      const card = await insertCard(ctx.owner, { creatorUserId: creator });
      for (const [role, pool] of ownerAndWorker()) {
        await expectViolation(
          pool.query('UPDATE interest_cards SET creator_user_id = NULL WHERE id = $1', [card]),
          TRIGGER,
          `${role}: clear`,
        );
        await expectViolation(
          pool.query('UPDATE interest_cards SET creator_user_id = $2 WHERE id = $1', [card, other]),
          TRIGGER,
          `${role}: reassign`,
        );
      }
    });

    it("is cleared by the FK when the creator's user row is hard-deleted", async () => {
      const creator = await newUser();
      const card = await insertCard(ctx.owner, { creatorUserId: creator });
      await expectOneRow(execute(ctx.workerPool, 'DELETE FROM users WHERE id = $1', [creator]));
      expect(
        await ownerRow('SELECT creator_user_id FROM interest_cards WHERE id = $1', [card]),
      ).toEqual({ creator_user_id: null });
    });

    it('may be cleared by the worker once the creator is soft-deleted', async () => {
      const creator = await newUser();
      const other = await newUser();
      const card = await insertCard(ctx.owner, { creatorUserId: creator });
      await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [creator]);
      await expectViolation(
        ctx.workerPool.query('UPDATE interest_cards SET creator_user_id = $2 WHERE id = $1', [
          card,
          other,
        ]),
        TRIGGER,
      );
      await expectOneRow(
        ctx.workerPool.query('UPDATE interest_cards SET creator_user_id = NULL WHERE id = $1', [
          card,
        ]),
      );
      expect(
        await ownerRow('SELECT creator_user_id FROM interest_cards WHERE id = $1', [card]),
      ).toEqual({ creator_user_id: null });
    });
  });

  describe('fork provenance (parent_card_id)', () => {
    it('rejects clearing or re-pointing the parent while it exists', async () => {
      const forkOwner = await newUser();
      const parent = await insertCard(ctx.owner);
      const otherParent = await insertCard(ctx.owner);
      const fork = await insertCard(ctx.owner, {
        visibility: 'private',
        ownerUserId: forkOwner,
        parentCardId: parent,
      });
      for (const [role, pool] of ownerAndWorker()) {
        await expectViolation(
          pool.query('UPDATE interest_cards SET parent_card_id = NULL WHERE id = $1', [fork]),
          TRIGGER,
          `${role}: clear`,
        );
        await expectViolation(
          pool.query('UPDATE interest_cards SET parent_card_id = $2 WHERE id = $1', [
            fork,
            otherParent,
          ]),
          TRIGGER,
          `${role}: re-point`,
        );
      }
    });

    it('is cleared by the FK when the parent card is deleted', async () => {
      const forkOwner = await newUser();
      const parent = await insertCard(ctx.owner);
      const fork = await insertCard(ctx.owner, {
        visibility: 'private',
        ownerUserId: forkOwner,
        parentCardId: parent,
      });
      await expectOneRow(
        execute(ctx.workerPool, 'DELETE FROM interest_cards WHERE id = $1', [parent]),
      );
      expect(
        await ownerRow('SELECT parent_card_id FROM interest_cards WHERE id = $1', [fork]),
      ).toEqual({ parent_card_id: null });
    });
  });

  describe('derived English pair', () => {
    const SET_PAIR = 'UPDATE interest_cards SET body = body || $2::jsonb WHERE id = $1';
    const pair = (interestEn: string | null, notForEn: string | null) =>
      JSON.stringify({ interest_en: interestEn, not_for_en: notForEn });
    const pairOf = (card: string) =>
      ownerRow<{ i: string | null; n: string | null }>(
        `SELECT body->>'interest_en' AS i, body->>'not_for_en' AS n
           FROM interest_cards WHERE id = $1`,
        [card],
      );
    const translatedCard = () =>
      insertCard(ctx.owner, { body: cardBody({ interest_en: 'Batteries', not_for_en: 'Stocks' }) });

    it('lets the worker fill an absent pair once', async () => {
      const card = await insertCard(ctx.owner);
      await expectOneRow(ctx.workerPool.query(SET_PAIR, [card, pair('Batteries', 'Stocks')]));
      expect(await pairOf(card)).toEqual({ i: 'Batteries', n: 'Stocks' });
    });

    it('rejects a partial fill (the content check, first in trigger-name order)', async () => {
      const card = await insertCard(ctx.owner);
      await expectViolation(
        ctx.workerPool.query(SET_PAIR, [card, JSON.stringify({ interest_en: 'Batteries' })]),
        'interest_cards_content_check',
      );
    });

    it('rejects overwriting or resetting a complete pair without the flag', async () => {
      const card = await translatedCard();
      const edits: [string, string][] = [
        ['full overwrite', pair('Battery chemistry', 'Share prices')],
        ['partial overwrite', pair('Battery chemistry', 'Stocks')],
        ['silent reset', pair(null, null)],
      ];
      for (const [label, next] of edits) {
        await expectViolation(ctx.workerPool.query(SET_PAIR, [card, next]), TRIGGER, label);
      }
      expect(await pairOf(card)).toEqual({ i: 'Batteries', n: 'Stocks' });
    });

    it('allows a full-pair retranslation or reset of exactly the flagged card', async () => {
      const card = await translatedCard();
      const other = await translatedCard();
      await expectViolation(
        execute(ctx.workerPool, SET_PAIR, [card, pair('Cells', 'Prices')], {
          [RETRANSLATION]: other,
        }),
        TRIGGER,
        'flag for another card',
      );
      await expectOneRow(
        execute(ctx.workerPool, SET_PAIR, [card, pair('Cells', 'Prices')], {
          [RETRANSLATION]: card,
        }),
      );
      expect(await pairOf(card)).toEqual({ i: 'Cells', n: 'Prices' });
      await expectOneRow(
        execute(ctx.workerPool, SET_PAIR, [card, pair(null, null)], { [RETRANSLATION]: card }),
      );
      expect(await pairOf(card)).toEqual({ i: null, n: null });
    });
  });

  describe('visibility', () => {
    const SET_VISIBILITY = 'UPDATE interest_cards SET visibility = $2 WHERE id = $1';

    it('goes shared → public only inside the promotion transaction for that card', async () => {
      const card = await insertCard(ctx.owner);
      const other = await insertCard(ctx.owner);
      await expectViolation(ctx.owner.query(SET_VISIBILITY, [card, 'public']), TRIGGER, 'no flag');
      await expectViolation(
        execute(ctx.owner, SET_VISIBILITY, [card, 'public'], { [PROMOTION]: other }),
        TRIGGER,
        'flag for another card',
      );
      await expectViolation(
        execute(ctx.owner, SET_VISIBILITY, [card, 'public'], { [RESPONSE]: card }),
        TRIGGER,
        'response flag',
      );
      await expectOneRow(
        execute(ctx.owner, SET_VISIBILITY, [card, 'public'], { [PROMOTION]: card }),
      );
      const { visibility } = await ownerRow<{ visibility: string }>(
        'SELECT visibility FROM interest_cards WHERE id = $1',
        [card],
      );
      expect(visibility).toBe('public');
    });

    it('keeps a vetoed card shared, even inside the promotion transaction', async () => {
      const card = await insertCard(ctx.owner);
      await expectOneRow(
        execute(
          ctx.owner,
          'UPDATE interest_cards SET publication_veto_at = now() WHERE id = $1',
          [card],
          {
            [RESPONSE]: card,
          },
        ),
      );
      await expectViolation(
        execute(ctx.owner, SET_VISIBILITY, [card, 'public'], { [PROMOTION]: card }),
        TRIGGER,
        'vetoed card',
      );
    });

    it("never changes a private fork's visibility, even with the promotion flag", async () => {
      const forkOwner = await newUser();
      const fork = await insertCard(ctx.owner, { visibility: 'private', ownerUserId: forkOwner });
      for (const target of ['shared', 'public']) {
        await expectViolation(
          execute(ctx.owner, SET_VISIBILITY, [fork, target], { [PROMOTION]: fork }),
          TRIGGER,
          `private → ${target}`,
        );
      }
    });

    it('rejects demoting a public card to shared', async () => {
      const card = await insertCard(ctx.owner, { visibility: 'public' });
      await expectViolation(
        ctx.workerPool.query(SET_VISIBILITY, [card, 'shared']),
        TRIGGER,
        'worker',
      );
      await expectViolation(
        execute(ctx.owner, SET_VISIBILITY, [card, 'shared'], { [PROMOTION]: card }),
        TRIGGER,
        'owner with the promotion flag',
      );
    });
  });

  describe('publication veto', () => {
    it('is set and cleared only in the creator response transaction for that card', async () => {
      const creator = await newUser();
      const card = await insertCard(ctx.owner, { creatorUserId: creator });
      const other = await insertCard(ctx.owner);
      const veto = 'UPDATE interest_cards SET publication_veto_at = now() WHERE id = $1';
      const clear = 'UPDATE interest_cards SET publication_veto_at = NULL WHERE id = $1';
      await expectViolation(ctx.workerPool.query(veto, [card]), TRIGGER, 'veto without flag');
      await expectViolation(
        execute(ctx.owner, veto, [card], { [RESPONSE]: other }),
        TRIGGER,
        'veto with a flag for another card',
      );
      await expectViolation(
        execute(ctx.owner, veto, [card], { [PROMOTION]: card }),
        TRIGGER,
        'veto with the promotion flag',
      );
      await expectOneRow(execute(ctx.owner, veto, [card], { [RESPONSE]: card }));
      await expectViolation(ctx.workerPool.query(clear, [card]), TRIGGER, 'clear without flag');
      await expectOneRow(execute(ctx.owner, clear, [card], { [RESPONSE]: card }));
    });
  });

  describe('API writes (bantoozi_app)', () => {
    it('lets a non-admin tenant un-retire a retired shared card', async () => {
      const reader = await newUser();
      const card = await insertCard(ctx.owner);
      await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [card]);
      await expectOneRow(
        asApp(reader, 'UPDATE interest_cards SET retired_at = NULL WHERE id = $1', [card]),
      );
      const { retired_at: retiredAt } = await ownerRow<{ retired_at: Date | null }>(
        'SELECT retired_at FROM interest_cards WHERE id = $1',
        [card],
      );
      expect(retiredAt).toBeNull();
    });

    it('rejects every other non-admin change', async () => {
      const reader = await newUser();
      const live = await insertCard(ctx.owner);
      const retired = await insertCard(ctx.owner);
      await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [
        retired,
      ]);
      const edits: [string, string, unknown[]][] = [
        ['retire', 'UPDATE interest_cards SET retired_at = now() WHERE id = $1', [live]],
        ['re-retire', 'UPDATE interest_cards SET retired_at = now() WHERE id = $1', [retired]],
        ['title', `UPDATE interest_cards SET title = 'Renamed by a reader' WHERE id = $1`, [live]],
        ['topic_ids', `UPDATE interest_cards SET topic_ids = '{technology}' WHERE id = $1`, [live]],
        [
          'i18n',
          `UPDATE interest_cards SET i18n = '{"sk": {"title": "Iný"}}' WHERE id = $1`,
          [live],
        ],
        [
          'slug',
          'UPDATE interest_cards SET slug = $2 WHERE id = $1',
          [live, `integrity-${randomUUID()}`],
        ],
        [
          'un-retire with an edit',
          `UPDATE interest_cards SET retired_at = NULL, title = 'Renamed' WHERE id = $1`,
          [retired],
        ],
      ];
      for (const [label, text, params] of edits) {
        await expectViolation(asApp(reader, text, params), TRIGGER, label);
      }
    });

    it('treats a soft-deleted admin as a non-admin', async () => {
      const admin = await newUser({ role: 'admin', deletedAt: new Date() });
      const card = await insertCard(ctx.owner);
      await expectViolation(
        asApp(admin, `UPDATE interest_cards SET title = 'Curated' WHERE id = $1`, [card]),
        TRIGGER,
      );
    });

    it('lets an admin change interest-card title, topics, i18n, slug and retirement', async () => {
      const admin = await newUser({ role: 'admin' });
      const card = await insertCard(ctx.owner);
      const slug = `integrity-${randomUUID()}`;
      await expectOneRow(
        asApp(
          admin,
          `UPDATE interest_cards SET title = 'Curated title',
                  topic_ids = '{technology,technology.ai_ml}',
                  i18n = '{"sk": {"title": "Kurátorský názov"}}', slug = $2, retired_at = now()
            WHERE id = $1`,
          [card, slug],
        ),
      );
      expect(
        await ownerRow(
          `SELECT title, topic_ids, i18n, slug, retired_at IS NOT NULL AS retired
             FROM interest_cards WHERE id = $1`,
          [card],
        ),
      ).toEqual({
        title: 'Curated title',
        topic_ids: ['technology', 'technology.ai_ml'],
        i18n: { sk: { title: 'Kurátorský názov' } },
        slug,
        retired: true,
      });
      await expectOneRow(
        asApp(admin, 'UPDATE interest_cards SET retired_at = NULL WHERE id = $1', [card]),
      );
    });

    it('rejects an admin renaming a label', async () => {
      const admin = await newUser({ role: 'admin' });
      const label = await insertCard(ctx.owner, { kind: 'label' });
      await expectViolation(
        asApp(admin, `UPDATE interest_cards SET title = 'Renamed label' WHERE id = $1`, [label]),
        TRIGGER,
      );
    });
  });
});

// ── Topics ──────────────────────────────────────────────────────────────────────────────────────

describe('topics_parent_check and topics_reference_check', () => {
  it('accepts parents and children in one multi-row INSERT, children first', async () => {
    await insertTopics(ctx.workerPool, [
      ['science.physics', 'science', 2],
      ['science.biology', 'science', 2],
      ['science', null, 1],
    ]);
    expect(
      await ownerRow<{ n: number }>(
        `SELECT count(*)::int AS n FROM topics WHERE id LIKE 'science%'`,
      ),
    ).toEqual({ n: 3 });
  });

  it('rejects a level-2 topic whose parent is level 2', async () => {
    await insertTopics(ctx.owner, [
      ['health', null, 1],
      ['health.sleep', 'health', 2],
    ]);
    await expectViolation(
      insertTopics(ctx.workerPool, [['health.sleep.naps', 'health.sleep', 2]]),
      'topics_parent_check',
    );
  });

  it('keeps a topic with children at level 1', async () => {
    await insertTopics(ctx.owner, [
      ['travel', null, 1],
      ['travel.rail', 'travel', 2],
      ['food', null, 1],
    ]);
    await expectViolation(
      ctx.workerPool.query(`UPDATE topics SET level = 2, parent_id = 'food' WHERE id = 'travel'`),
      'topics_parent_check',
    );
  });

  it('rejects deleting or renaming a referenced topic; unreferenced ones may go', async () => {
    await insertTopics(ctx.owner, [
      ['sport', null, 1],
      ['sport.cycling', 'sport', 2],
      ['sport.rowing', 'sport', 2],
      ['sport.chess', 'sport', 2],
    ]);
    await insertCard(ctx.owner, { topicIds: ['sport.cycling'] });
    await expectViolation(
      ctx.workerPool.query(`DELETE FROM topics WHERE id = 'sport.cycling'`),
      'topics_reference_check',
      'delete',
    );
    await expectViolation(
      ctx.workerPool.query(`UPDATE topics SET id = 'sport.bikes' WHERE id = 'sport.cycling'`),
      'topics_reference_check',
      'rename',
    );
    await expectOneRow(
      ctx.workerPool.query(`UPDATE topics SET id = 'sport.sculling' WHERE id = 'sport.rowing'`),
    );
    await expectOneRow(ctx.workerPool.query(`DELETE FROM topics WHERE id = 'sport.chess'`));
  });

  // Row locks as a foreign-key check takes them: the second writer waits for the first and then
  // fails against its committed state instead of both passing (migration 0007).
  describe('concurrent writers', () => {
    it('a topic delete or rename waits for an uncommitted card referencing it, then fails', async () => {
      await insertTopics(ctx.owner, [
        ['arts', null, 1],
        ['arts.film', 'arts', 2],
        ['arts.theatre', 'arts', 2],
      ]);
      const deleted = await secondWriterAfterFirstCommits(
        (first) => insertCard(first, { topicIds: ['arts.film'] }),
        (second) => second.query(`DELETE FROM topics WHERE id = 'arts.film'`),
      );
      expect(deleted).toMatchObject({ code: '23514', constraint: 'topics_reference_check' });
      const renamed = await secondWriterAfterFirstCommits(
        (first) => insertCard(first, { topicIds: ['arts', 'arts.theatre'] }),
        (second) => second.query(`UPDATE topics SET id = 'arts.stage' WHERE id = 'arts.theatre'`),
      );
      expect(renamed).toMatchObject({ code: '23514', constraint: 'topics_reference_check' });
    });

    it('a card waits for an uncommitted delete of its topic, then fails', async () => {
      await insertTopics(ctx.owner, [
        ['music', null, 1],
        ['music.jazz', 'music', 2],
      ]);
      const card = await insertCard(ctx.owner, { topicIds: ['music'] });
      const inserted = await secondWriterAfterFirstCommits(
        (first) => first.query(`DELETE FROM topics WHERE id = 'music.jazz'`),
        (second) => insertCard(second, { topicIds: ['music.jazz'] }),
      );
      expect(inserted).toMatchObject({ code: '23514', constraint: 'interest_cards_content_check' });
      await insertTopics(ctx.owner, [['music.folk', 'music', 2]]);
      const updated = await secondWriterAfterFirstCommits(
        (first) => first.query(`DELETE FROM topics WHERE id = 'music.folk'`),
        (second) =>
          second.query(`UPDATE interest_cards SET topic_ids = '{music.folk}' WHERE id = $1`, [
            card,
          ]),
      );
      expect(updated).toMatchObject({ code: '23514', constraint: 'interest_cards_content_check' });
    });

    it('a parent level change and a new child wait for each other, and the second fails', async () => {
      await insertTopics(ctx.owner, [
        ['home', null, 1],
        ['garden', null, 1],
        ['pets', null, 1],
      ]);
      const levelChange = await secondWriterAfterFirstCommits(
        (first) => insertTopics(first, [['home.diy', 'home', 2]]),
        (second) =>
          second.query(`UPDATE topics SET level = 2, parent_id = 'garden' WHERE id = 'home'`),
      );
      expect(levelChange).toMatchObject({ code: '23514', constraint: 'topics_parent_check' });
      const child = await secondWriterAfterFirstCommits(
        (first) =>
          first.query(`UPDATE topics SET level = 2, parent_id = 'garden' WHERE id = 'pets'`),
        (second) => insertTopics(second, [['pets.cats', 'pets', 2]]),
      );
      expect(child).toMatchObject({ code: '23514', constraint: 'topics_parent_check' });
    });
  });
});

/**
 * Runs `first` in an open worker transaction, then `second` in its own transaction on another
 * worker connection, which must wait for a lock `first` holds; `first` then commits. Resolves with
 * the error `second` settles with once it resumes (`null` when it succeeds).
 */
async function secondWriterAfterFirstCommits(
  first: (client: PoolClient) => Promise<unknown>,
  second: (client: PoolClient) => Promise<unknown>,
): Promise<DbFailure | null> {
  const firstClient = await ctx.workerPool.connect();
  const secondClient = await ctx.workerPool.connect();
  let settled: Promise<DbFailure | null> | undefined;
  try {
    await firstClient.query('BEGIN');
    try {
      await first(firstClient);
    } catch (error) {
      await firstClient.query('ROLLBACK');
      throw error;
    }
    const { rows } = await secondClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    settled = (async () => {
      await secondClient.query('BEGIN');
      try {
        await second(secondClient);
        await secondClient.query('COMMIT');
        return null;
      } catch (error) {
        await secondClient.query('ROLLBACK');
        return error as DbFailure;
      }
    })();
    try {
      await waitForLockWait(rows[0]?.pid);
    } finally {
      await firstClient.query('COMMIT');
    }
    return await settled;
  } finally {
    // Never hand a connection back to the pool while its transaction is still running.
    await settled;
    firstClient.release();
    secondClient.release();
  }
}

/** Resolves once backend `pid` waits for a lock; fails if it never does (no conflicting lock). */
async function waitForLockWait(pid: number | undefined): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await ctx.adminPool.query<{ waiting: boolean }>(
      `SELECT coalesce(wait_event_type = 'Lock', false) AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the second writer never waited for a lock held by the first');
}

// ── Label assignment integrity (deferred) ───────────────────────────────────────────────────────

interface LabelFixture {
  user: string;
  held: readonly [string, string];
  /** A shared label the user does not hold. */
  unheld: string;
  article: string;
}

/** A user holding two private labels, an unheld shared label and an article. */
async function labelFixture(): Promise<LabelFixture> {
  const user = await newUser();
  const first = await newCard({ kind: 'label', visibility: 'private', ownerUserId: user });
  const second = await newCard({ kind: 'label', visibility: 'private', ownerUserId: user });
  await asTenant(ctx.appPool, user, async (client) => {
    for (const label of [first, second]) {
      await client.query(
        `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`,
        [user, label],
      );
    }
  });
  return {
    user,
    held: [first, second],
    unheld: await newCard({ kind: 'label' }),
    article: (await createArticle(ctx.owner)).id,
  };
}

const ASSIGN = 'INSERT INTO user_article (user_id, article_id, label_ids) VALUES ($1, $2, $3)';
const RELABEL = 'UPDATE user_article SET label_ids = $3 WHERE user_id = $1 AND article_id = $2';
const SUGGEST =
  'UPDATE user_article SET label_suggestions = $3 WHERE user_id = $1 AND article_id = $2';

async function articleLabels(
  f: LabelFixture,
): Promise<{ label_ids: string[]; label_suggestions: string[] }> {
  return ownerRow(
    `SELECT label_ids::text[] AS label_ids, label_suggestions::text[] AS label_suggestions
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [f.user, f.article],
  );
}

describe('user_article_labels_check (deferred to COMMIT)', () => {
  const TRIGGER = 'user_article_labels_check';

  it('accepts distinct held labels, assigned by the API and suggested by the worker', async () => {
    const f = await labelFixture();
    await expectOneRow(asApp(f.user, ASSIGN, [f.user, f.article, [f.held[0]]]));
    await expectOneRow(execute(ctx.workerPool, SUGGEST, [f.user, f.article, [f.held[1]]]));
    expect(await articleLabels(f)).toEqual({
      label_ids: [f.held[0]],
      label_suggestions: [f.held[1]],
    });
  });

  it('rejects duplicate, NULL and unheld labels at COMMIT, not at the statement', async () => {
    const f = await labelFixture();
    const other = await labelFixture();
    const invalid: [string, (string | null)[]][] = [
      ['duplicate', [f.held[0], f.held[0]]],
      ['NULL element', [f.held[0], null]],
      ['label the user does not hold', [f.unheld]],
      ["another user's private label", [other.held[0]]],
    ];
    for (const [label, labelIds] of invalid) {
      await expectViolation(
        asTenant(ctx.appPool, f.user, async (client) => {
          expect((await client.query(ASSIGN, [f.user, f.article, labelIds])).rowCount).toBe(1);
        }),
        TRIGGER,
        label,
      );
    }
  });

  it('rejects suggesting an assigned label and duplicate, NULL or unheld ones', async () => {
    const f = await labelFixture();
    await expectOneRow(asApp(f.user, ASSIGN, [f.user, f.article, [f.held[0]]]));
    const invalid: [string, (string | null)[]][] = [
      ['assigned and suggested', [f.held[0]]],
      ['duplicate', [f.held[1], f.held[1]]],
      ['NULL element', [null]],
      ['label the user does not hold', [f.unheld]],
    ];
    for (const [label, suggestions] of invalid) {
      await expectViolation(
        execute(ctx.workerPool, SUGGEST, [f.user, f.article, suggestions]),
        TRIGGER,
        `worker: ${label}`,
      );
    }
    await expectViolation(
      asApp(f.user, RELABEL, [f.user, f.article, [f.held[1], f.held[1]]]),
      TRIGGER,
      'API: duplicate assignment on UPDATE',
    );
  });

  it('checks the final row state: a transient invalid state fixed in time passes', async () => {
    const f = await labelFixture();
    await asTenant(ctx.appPool, f.user, async (client) => {
      await client.query(ASSIGN, [f.user, f.article, [f.held[0], f.held[0]]]);
      await client.query(RELABEL, [f.user, f.article, [f.held[0]]]);
    });
    expect(await articleLabels(f)).toEqual({ label_ids: [f.held[0]], label_suggestions: [] });
    // Assign first, hold the label later in the same transaction.
    await asTenant(ctx.appPool, f.user, async (client) => {
      await client.query(RELABEL, [f.user, f.article, [f.held[0], f.unheld]]);
      await client.query(
        `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Adopted')`,
        [f.user, f.unheld],
      );
    });
    expect(await articleLabels(f)).toEqual({
      label_ids: [f.held[0], f.unheld],
      label_suggestions: [],
    });
  });
});

describe('user_labels_removal_check (deferred to COMMIT)', () => {
  const TRIGGER = 'user_labels_removal_check';
  const UNHOLD = 'DELETE FROM user_labels WHERE user_id = $1 AND card_id = $2';
  const HOLD = `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`;

  /** held[0] assigned and held[1] suggested on the fixture article. */
  async function labelledFixture(): Promise<LabelFixture> {
    const f = await labelFixture();
    await expectOneRow(asApp(f.user, ASSIGN, [f.user, f.article, [f.held[0]]]));
    await expectOneRow(execute(ctx.workerPool, SUGGEST, [f.user, f.article, [f.held[1]]]));
    return f;
  }

  it('rejects removing a label that is still assigned or suggested', async () => {
    const f = await labelledFixture();
    for (const [label, card] of [
      ['assigned', f.held[0]],
      ['suggested', f.held[1]],
    ] as const) {
      await expectViolation(
        asTenant(ctx.appPool, f.user, async (client) => {
          expect((await client.query(UNHOLD, [f.user, card])).rowCount).toBe(1);
        }),
        TRIGGER,
        label,
      );
    }
  });

  it('allows removing a label together with its assignments and suggestions', async () => {
    const f = await labelledFixture();
    await asTenant(ctx.appPool, f.user, async (client) => {
      for (const card of f.held) {
        await client.query(UNHOLD, [f.user, card]);
        await client.query(
          `UPDATE user_article SET label_ids = array_remove(label_ids, $2::bigint),
                                   label_suggestions = array_remove(label_suggestions, $2::bigint)
            WHERE user_id = $1`,
          [f.user, card],
        );
      }
    });
    expect(await articleLabels(f)).toEqual({ label_ids: [], label_suggestions: [] });
  });

  it('allows deleting and re-inserting the same label in one transaction', async () => {
    const f = await labelledFixture();
    await asTenant(ctx.appPool, f.user, async (client) => {
      await client.query(UNHOLD, [f.user, f.held[0]]);
      await client.query(HOLD, [f.user, f.held[0]]);
    });
    expect(await articleLabels(f)).toEqual({
      label_ids: [f.held[0]],
      label_suggestions: [f.held[1]],
    });
  });

  it('re-points a label (label fork) only together with its assignments', async () => {
    const f = await labelledFixture();
    const fork = await newCard({ kind: 'label', visibility: 'private', ownerUserId: f.user });
    const REPOINT = 'UPDATE user_labels SET card_id = $3 WHERE user_id = $1 AND card_id = $2';
    await expectViolation(
      asApp(f.user, REPOINT, [f.user, f.held[0], fork]),
      TRIGGER,
      're-point alone',
    );
    await asTenant(ctx.appPool, f.user, async (client) => {
      await client.query(REPOINT, [f.user, f.held[0], fork]);
      await client.query(
        `UPDATE user_article
            SET label_ids = array_replace(label_ids, $2::bigint, $3::bigint),
                label_suggestions = array_replace(label_suggestions, $2::bigint, $3::bigint)
          WHERE user_id = $1`,
        [f.user, f.held[0], fork],
      );
    });
    expect(await articleLabels(f)).toEqual({ label_ids: [fork], label_suggestions: [f.held[1]] });
  });
});

describe('account purge with held private cards and labels (spec 02 §8 item 3)', () => {
  for (const role of ['worker', 'owner'] as const) {
    it(`deletes the account as the ${role}, whatever the FK order`, async () => {
      const user = await newUser();
      const parent = await insertCard(ctx.owner);
      const fork = await insertCard(ctx.owner, {
        visibility: 'private',
        ownerUserId: user,
        parentCardId: parent,
      });
      const authored = await insertCard(ctx.owner, { creatorUserId: user });
      const assigned = await newCard({ kind: 'label', visibility: 'private', ownerUserId: user });
      const suggested = await newCard({ kind: 'label', visibility: 'private', ownerUserId: user });
      const article = (await createArticle(ctx.owner)).id;
      await asTenant(ctx.appPool, user, async (client) => {
        await client.query(
          `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
          [user, fork],
        );
        for (const label of [assigned, suggested]) {
          await client.query(
            `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Mine')`,
            [user, label],
          );
        }
        await client.query(ASSIGN, [user, article, [assigned]]);
      });
      await expectOneRow(execute(ctx.workerPool, SUGGEST, [user, article, [suggested]]));

      await expectOneRow(
        execute(role === 'worker' ? ctx.workerPool : ctx.owner, 'DELETE FROM users WHERE id = $1', [
          user,
        ]),
      );

      const cards = await ctx.owner.query<{ id: string; creator_user_id: string | null }>(
        `SELECT id::text AS id, creator_user_id FROM interest_cards
          WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [[parent, fork, authored, assigned, suggested]],
      );
      expect(cards.rows).toEqual([
        { id: parent, creator_user_id: null },
        { id: authored, creator_user_id: null },
      ]);
      expect(
        await ownerRow<{ n: number }>(
          `SELECT ((SELECT count(*) FROM user_cards WHERE user_id = $1)
                 + (SELECT count(*) FROM user_labels WHERE user_id = $1)
                 + (SELECT count(*) FROM user_article WHERE user_id = $1))::int AS n`,
          [user],
        ),
      ).toEqual({ n: 0 });
    });
  }
});

// ── Inference gate generation ───────────────────────────────────────────────────────────────────

describe('subscriptions_inference_guard', () => {
  const TRIGGER = 'subscriptions_inference_guard';
  const SUBSCRIBE = `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version,
                                                 inference_activated_at)
                     VALUES ($1, $2, $3, $4, $5)`;
  const update = (sets: string) =>
    `UPDATE subscriptions SET ${sets} WHERE user_id = $1 AND feed_id = $2`;
  const state = (s: { user: string; feed: string }) =>
    ownerRow<{ mode: string; version: number; activated: Date | null }>(
      `SELECT inference_mode AS mode, inference_version::int AS version,
              inference_activated_at AS activated
         FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
      [s.user, s.feed],
    );

  async function subscribed(
    mode: 'off' | 'training' | 'active',
    activatedAt?: Date,
  ): Promise<{ user: string; feed: string }> {
    const user = await newUser();
    const feed = (await createFeed(ctx.owner)).id;
    await createSubscription(ctx.owner, {
      userId: user,
      feedId: feed,
      mode,
      ...(activatedAt === undefined ? {} : { activatedAt }),
    });
    return { user, feed };
  }

  it('starts every API subscription off at version 0', async () => {
    const user = await newUser();
    const feed = (await createFeed(ctx.owner)).id;
    const other = (await createFeed(ctx.owner)).id;
    const invalid: [string, unknown[]][] = [
      ['training', [user, feed, 'training', 0, null]],
      ['active', [user, feed, 'active', 0, new Date()]],
      ['version 1', [user, feed, 'off', 1, null]],
      ['activation time', [user, feed, 'off', 0, new Date()]],
    ];
    for (const [label, params] of invalid) {
      await expectViolation(asApp(user, SUBSCRIBE, params), TRIGGER, label);
    }
    await expectOneRow(
      asApp(user, 'INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $2)', [user, feed]),
    );
    await expectOneRow(asApp(user, SUBSCRIBE, [user, other, 'off', 0, null]));
  });

  it('advances the version by exactly one on a mode change', async () => {
    const s = await subscribed('off');
    const params = [s.user, s.feed];
    await expectViolation(
      asApp(s.user, update(`inference_mode = 'training'`), params),
      TRIGGER,
      '+0',
    );
    await expectViolation(
      asApp(
        s.user,
        update(`inference_mode = 'training', inference_version = inference_version + 2`),
        params,
      ),
      TRIGGER,
      '+2',
    );
    await expectOneRow(
      asApp(
        s.user,
        update(`inference_mode = 'training', inference_version = inference_version + 1`),
        params,
      ),
    );
    expect(await state(s)).toEqual({ mode: 'training', version: 1, activated: null });
    await expectViolation(
      asApp(
        s.user,
        update(`inference_mode = 'off', inference_version = inference_version - 1`),
        params,
      ),
      TRIGGER,
      '-1',
    );
  });

  it('stamps the transaction time on entering active and clears it on leaving', async () => {
    const s = await subscribed('training');
    const params = [s.user, s.feed];
    const enter = `inference_mode = 'active', inference_version = inference_version + 1`;
    await expectViolation(
      asApp(s.user, update(`${enter}, inference_activated_at = NULL`), params),
      TRIGGER,
      'no activation time',
    );
    await expectViolation(
      asApp(
        s.user,
        update(`${enter}, inference_activated_at = now() - interval '1 second'`),
        params,
      ),
      TRIGGER,
      'not the transaction time',
    );
    await asTenant(ctx.appPool, s.user, async (client) => {
      expect(
        (await client.query(update(`${enter}, inference_activated_at = now()`), params)).rowCount,
      ).toBe(1);
      const { rows } = await client.query<{ at_now: boolean }>(
        `SELECT inference_activated_at = now() AS at_now
           FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
        params,
      );
      expect(rows).toEqual([{ at_now: true }]);
    });
    expect(await state(s)).toMatchObject({ mode: 'active', version: 2 });
    const leave = `inference_mode = 'off', inference_version = inference_version + 1,
                   inference_activated_at = NULL`;
    await expectOneRow(asApp(s.user, update(leave), params));
    expect(await state(s)).toEqual({ mode: 'off', version: 3, activated: null });
  });

  it('keeps version and activation without a mode change; same mode is a no-op', async () => {
    const training = await subscribed('training');
    const params = [training.user, training.feed];
    await expectViolation(
      asApp(training.user, update('inference_version = inference_version + 1'), params),
      TRIGGER,
      'version bump alone',
    );
    await expectViolation(
      asApp(
        training.user,
        update(`inference_mode = 'training', inference_version = inference_version + 1`),
        params,
      ),
      TRIGGER,
      'version bump with the same mode',
    );
    await expectOneRow(
      asApp(training.user, update(`inference_mode = 'training', folder = 'Reading'`), params),
    );
    expect(await state(training)).toEqual({ mode: 'training', version: 1, activated: null });

    const active = await subscribed('active', new Date(Date.now() - 3_600_000));
    await expectViolation(
      asApp(active.user, update('inference_activated_at = now()'), [active.user, active.feed]),
      TRIGGER,
      'activation change alone',
    );
  });

  it('keeps user and feed identity; only a worker merge may relocate the feed', async () => {
    const s = await subscribed('training');
    const target = (await createFeed(ctx.owner)).id;
    const other = await newUser();
    await expectViolation(
      asApp(s.user, update('feed_id = $3'), [s.user, s.feed, target]),
      TRIGGER,
      'API feed change',
    );
    await expectViolation(
      ctx.workerPool.query(update('user_id = $3'), [s.user, s.feed, other]),
      TRIGGER,
      'worker user change',
    );
    await expectOneRow(ctx.workerPool.query(update('feed_id = $3'), [s.user, s.feed, target]));
    expect(await state({ user: s.user, feed: target })).toEqual({
      mode: 'training',
      version: 1,
      activated: null,
    });
  });
});

interface ManualFixture {
  user: string;
  feed: string;
  article: string;
}

/** A user whose subscription (version 1 unless off) carries an article at `revision`. */
async function manualFixture(
  mode: 'off' | 'training' | 'active' = 'training',
  revision = 1,
): Promise<ManualFixture> {
  const user = await newUser();
  const feed = (await createFeed(ctx.owner)).id;
  const article = (await createArticle(ctx.owner, { feedIds: [feed], contentRevision: revision }))
    .id;
  await createSubscription(ctx.owner, { userId: user, feedId: feed, mode });
  return { user, feed, article };
}

const REQUEST_COLUMNS = `id, user_id, feed_id, article_id, article_revision, inference_version,
                         input_snapshot, input_sha`;
const INSERT_REQUEST = `INSERT INTO analysis_requests (${REQUEST_COLUMNS})
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

interface RequestInput extends ManualFixture {
  revision?: number;
  version?: number;
  snapshot?: string;
  sha?: string;
}

async function requestParams(input: RequestInput): Promise<unknown[]> {
  const snapshot =
    input.snapshot ??
    JSON.stringify({ article: { id: input.article, title: 'Frozen' }, cards: [] });
  return [
    randomUUID(),
    input.user,
    input.feed,
    input.article,
    input.revision ?? 1,
    input.version ?? 1,
    snapshot,
    input.sha ?? (await jsonbSha(snapshot)),
  ];
}

/** A pending manual request created through the API path; returns its id. */
async function createRequest(m: ManualFixture): Promise<string> {
  const params = await requestParams(m);
  await expectOneRow(asApp(m.user, INSERT_REQUEST, params));
  return String(params[0]);
}

describe('analysis_requests_insert_check (bantoozi_app)', () => {
  const TRIGGER = 'analysis_requests_insert_check';

  it("accepts the tenant's live subscription, carrier, revision and hash", async () => {
    const training = await manualFixture('training');
    await createRequest(training);
    const active = await manualFixture('active');
    await createRequest(active);
    const revised = await manualFixture('training', 3);
    await expectOneRow(
      asApp(revised.user, INSERT_REQUEST, await requestParams({ ...revised, revision: 3 })),
    );
  });

  it('requires the active tenant', async () => {
    const m = await manualFixture();
    const other = await newUser();
    await expectViolation(
      asApp(null, INSERT_REQUEST, await requestParams(m)),
      TRIGGER,
      'no tenant',
    );
    await expectViolation(
      asApp(other, INSERT_REQUEST, await requestParams(m)),
      TRIGGER,
      'other tenant',
    );
    const deleted = await manualFixture();
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.user]);
    await expectViolation(
      asApp(deleted.user, INSERT_REQUEST, await requestParams(deleted)),
      TRIGGER,
      'soft-deleted tenant',
    );
  });

  it('requires a training or active subscription at the exact inference version', async () => {
    const off = await manualFixture('off');
    await expectViolation(
      asApp(off.user, INSERT_REQUEST, await requestParams({ ...off, version: 0 })),
      TRIGGER,
      'subscription off',
    );
    const m = await manualFixture('training');
    for (const version of [0, 2]) {
      await expectViolation(
        asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, version })),
        TRIGGER,
        `version ${version}`,
      );
    }
    // Another feed carries the article, but the tenant is not subscribed to it.
    const unsubscribed = (await createFeed(ctx.owner)).id;
    await ctx.owner.query(`INSERT INTO feed_items (feed_id, article_id) VALUES ($1, $2)`, [
      unsubscribed,
      m.article,
    ]);
    await expectViolation(
      asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, feed: unsubscribed })),
      TRIGGER,
      'no subscription',
    );
  });

  it('requires an actual carrier and the current article revision', async () => {
    const m = await manualFixture('training', 2);
    const elsewhere = (
      await createArticle(ctx.owner, { feedIds: [(await createFeed(ctx.owner)).id] })
    ).id;
    await expectViolation(
      asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, article: elsewhere })),
      TRIGGER,
      'feed does not carry the article',
    );
    await expectViolation(
      asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, revision: 1 })),
      TRIGGER,
      'stale revision',
    );
  });

  it('requires the frozen hash of an object snapshot', async () => {
    const m = await manualFixture();
    await expectViolation(
      asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, sha: '0'.repeat(64) })),
      TRIGGER,
      'wrong input_sha',
    );
    for (const snapshot of ['[1, 2]', '"text"']) {
      await expectViolation(
        asApp(m.user, INSERT_REQUEST, await requestParams({ ...m, snapshot })),
        TRIGGER,
        `snapshot ${snapshot}`,
      );
    }
  });

  it('starts pending, whoever inserts', async () => {
    const m = await manualFixture();
    const extras: [string, string][] = [
      ['status, completed_at', `'cancelled', now()`],
      [
        'status, lease_token, lease_until',
        `'running', gen_random_uuid(), now() + interval '1 minute'`,
      ],
      ['attempts', '1'],
      ['last_error_code', `'boom'`],
      ['result_snapshot, result_sha', `'{}', repeat('a', 64)`],
    ];
    for (const [columns, values] of extras) {
      const params = await requestParams(m);
      await expectViolation(
        inTx(ctx.workerPool, { 'app.user_id': m.user }, (client) =>
          client.query(
            `INSERT INTO analysis_requests (${REQUEST_COLUMNS}, ${columns})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${values})`,
            params,
          ),
        ),
        TRIGGER,
        columns,
      );
    }
  });
});

describe('analysis_requests_update_check (bantoozi_worker)', () => {
  const TRIGGER = 'analysis_requests_update_check';
  const update = (sets: string) => `UPDATE analysis_requests SET ${sets} WHERE id = $1`;

  async function run(id: string): Promise<string> {
    const lease = randomUUID();
    await expectOneRow(
      ctx.workerPool.query(
        update(`status = 'running', lease_token = $2, lease_until = now() + interval '5 minutes',
                attempts = attempts + 1`),
        [id, lease],
      ),
    );
    return lease;
  }

  async function complete(id: string, lease: string): Promise<void> {
    await expectOneRow(
      ctx.workerPool.query(
        `UPDATE analysis_requests SET status = 'complete', result_snapshot = '{"answers": [1]}',
                result_sha = repeat('a', 64), lease_token = NULL, lease_until = NULL,
                completed_at = now()
          WHERE id = $1 AND lease_token = $2`,
        [id, lease],
      ),
    );
  }

  async function completedRequest(): Promise<string> {
    const id = await createRequest(await manualFixture());
    await complete(id, await run(id));
    return id;
  }

  it('keeps the frozen input immutable', async () => {
    const id = await createRequest(await manualFixture());
    const other = await newUser();
    const edits = [
      'id = gen_random_uuid()',
      `user_id = '${other}'`,
      'article_revision = article_revision + 1',
      'inference_version = inference_version + 1',
      `input_snapshot = '{"edited": true}'`,
      `input_sha = repeat('0', 64)`,
      `created_at = created_at - interval '1 minute'`,
    ];
    for (const edit of edits) {
      await expectViolation(ctx.workerPool.query(update(edit), [id]), TRIGGER, edit);
    }
  });

  it('runs a request to completion with its result', async () => {
    const id = await completedRequest();
    expect(
      await ownerRow(
        `SELECT status, result_snapshot, lease_token, completed_at IS NOT NULL AS completed
           FROM analysis_requests WHERE id = $1`,
        [id],
      ),
    ).toEqual({
      status: 'complete',
      result_snapshot: { answers: [1] },
      lease_token: null,
      completed: true,
    });
  });

  it('keeps a finished request final', async () => {
    const id = await completedRequest();
    const edits = [
      `status = 'failed'`,
      `completed_at = completed_at + interval '1 minute'`,
      'attempts = attempts + 1',
      `last_error_code = 'late_worker'`,
      `status = 'running', lease_token = gen_random_uuid(),
       lease_until = now() + interval '1 minute', completed_at = NULL`,
      `lease_token = gen_random_uuid(), lease_until = now() + interval '1 minute'`,
      `result_snapshot = '{"answers": [2]}', result_sha = repeat('b', 64)`,
    ];
    for (const edit of edits) {
      await expectViolation(ctx.workerPool.query(update(edit), [id]), TRIGGER, edit);
    }
    const cancelled = await createRequest(await manualFixture());
    await expectOneRow(
      ctx.workerPool.query(
        update(`status = 'cancelled', completed_at = now(), last_error_code = 'unsubscribed'`),
        [cancelled],
      ),
    );
    await expectViolation(
      ctx.workerPool.query(update(`status = 'pending', completed_at = NULL`), [cancelled]),
      TRIGGER,
      'reopen a cancelled request',
    );
  });

  it('never rewrites a stored result, even before the request finishes', async () => {
    const id = await createRequest(await manualFixture());
    await run(id);
    await expectOneRow(
      ctx.workerPool.query(
        update(`result_snapshot = '{"answers": [1]}', result_sha = repeat('a', 64)`),
        [id],
      ),
    );
    await expectViolation(
      ctx.workerPool.query(
        update(`result_snapshot = '{"answers": [2]}', result_sha = repeat('b', 64)`),
        [id],
      ),
      TRIGGER,
    );
  });

  it('lets a vetted merge relocate feed_id and article_id, even when final', async () => {
    const id = await completedRequest();
    const feed = (await createFeed(ctx.owner)).id;
    const article = (await createArticle(ctx.owner, { feedIds: [feed] })).id;
    await expectOneRow(
      ctx.workerPool.query(update('feed_id = $2, article_id = $3'), [id, feed, article]),
    );
    expect(
      await ownerRow(
        `SELECT feed_id::text AS feed, article_id::text AS article, status
           FROM analysis_requests WHERE id = $1`,
        [id],
      ),
    ).toEqual({ feed, article, status: 'complete' });
  });
});

// ── Bookmark snapshots ──────────────────────────────────────────────────────────────────────────

/** An archived (partial) snapshot of a fresh article, written as the capture helper would. */
async function insertSnapshot(): Promise<string> {
  const article = (await createArticle(ctx.owner)).id;
  const { id } = await ownerRow<{ id: string }>(
    `INSERT INTO article_snapshots (article_id, source_revision, source_url, title, author,
                                    published_at, body_text, body_html, content_sha256,
                                    completeness, completeness_reason, source, extractor_version)
     VALUES ($1, 1, 'https://news.example.test/archived', 'Archived title', 'A. Author',
             now() - interval '1 day', 'Archived text', '<p>Archived text</p>', repeat('c', 64),
             'partial', 'paywall', 'feed', 'extract-v1')
     RETURNING id::text AS id`,
    [article],
  );
  return id;
}

describe('article_snapshots_guard', () => {
  const TRIGGER = 'article_snapshots_guard';

  const PAYLOAD_EDITS: readonly (readonly [string, string])[] = [
    ['id', 'id = DEFAULT'],
    ['source_revision', 'source_revision = source_revision + 1'],
    ['captured_at', `captured_at = captured_at - interval '1 minute'`],
    ['source_url', `source_url = 'https://mirror.example.test/archived'`],
    ['title', `title = 'Edited title'`],
    ['author', 'author = NULL'],
    ['published_at', 'published_at = now()'],
    ['body_text', `body_text = body_text || ' (edited)'`],
    ['body_html', 'body_html = NULL'],
    ['content_sha256', `content_sha256 = repeat('d', 64)`],
    ['completeness', `completeness = 'complete'`],
    ['completeness_reason', 'completeness_reason = NULL'],
    ['source', `source = 'page'`],
    ['extractor_version', `extractor_version = 'extract-v2'`],
  ];

  for (const [column, assignment] of PAYLOAD_EDITS) {
    it(`rejects changing ${column}, as the worker and as the owner`, async () => {
      const id = await insertSnapshot();
      for (const [role, pool] of [
        ['worker', ctx.workerPool],
        ['owner', ctx.owner],
      ] as const) {
        await expectViolation(
          pool.query(`UPDATE article_snapshots SET ${assignment} WHERE id = $1`, [id]),
          TRIGGER,
          role,
        );
      }
    });
  }

  it('allows lifecycle changes and a vetted article relocation', async () => {
    const id = await insertSnapshot();
    const target = (await createArticle(ctx.owner)).id;
    const update = (sets: string, params: unknown[] = []) =>
      ctx.workerPool.query(`UPDATE article_snapshots SET ${sets} WHERE id = $1`, [id, ...params]);
    await expectOneRow(update('cold_at = now(), unreferenced_at = now()'));
    await expectOneRow(update('unreferenced_at = NULL'));
    await expectOneRow(update('article_id = $2', [target]));
    expect(
      await ownerRow(
        `SELECT article_id::text AS article, cold_at IS NOT NULL AS cold, unreferenced_at, title,
                body_text
           FROM article_snapshots WHERE id = $1`,
        [id],
      ),
    ).toEqual({
      article: target,
      cold: true,
      unreferenced_at: null,
      title: 'Archived title',
      body_text: 'Archived text',
    });
  });
});

describe('bookmark_snapshot_pins_attach', () => {
  it('clears the unreferenced marker of the snapshot an API undo pin attaches to', async () => {
    const user = await newUser();
    const pinned = await insertSnapshot();
    const other = await insertSnapshot();
    await ctx.owner.query(
      'UPDATE article_snapshots SET unreferenced_at = now() WHERE id = ANY($1::bigint[])',
      [[pinned, other]],
    );
    const mutation = randomUUID();
    await asTenant(ctx.appPool, user, async (client) => {
      await client.query(
        `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, expires_at)
         VALUES ($1, $2, repeat('9', 64), 'DELETE /bookmarks/:articleId', 200, '{}',
                 now() + interval '7 days')`,
        [user, mutation],
      );
      await client.query(
        `INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '10 minutes')`,
        [user, mutation, pinned],
      );
    });
    const { rows } = await ctx.owner.query<{ id: string; unreferenced: boolean }>(
      `SELECT id::text AS id, unreferenced_at IS NOT NULL AS unreferenced
         FROM article_snapshots WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[pinned, other]],
    );
    expect(rows).toEqual([
      { id: pinned, unreferenced: false },
      { id: other, unreferenced: true },
    ]);
  });
});

// ── Original-author publication ─────────────────────────────────────────────────────────────────

describe('card_publication_requests_guard', () => {
  const TRIGGER = 'card_publication_requests_guard';
  const update = (sets: string) => `UPDATE card_publication_requests SET ${sets} WHERE id = $1`;
  const APPROVE = `status = 'approved', responded_at = now(), version = version + 1`;
  const DECLINE = `status = 'rejected', responded_at = now(), version = version + 1`;
  const PROMOTE = `status = 'promoted', promoted_at = now(), promoted_by = $2,
                   authorization_kind = 'creator_inactive_30d', authorization_evidence = $3::jsonb`;

  interface Proposal {
    creator: string;
    admin: string;
    card: string;
    textHash: string;
    publicationSha: string;
    request: string;
  }

  /** A shared card of `creator` with an open request, as admin_request_card_publication writes. */
  async function openProposal(): Promise<Proposal> {
    const creator = await newUser();
    const admin = await newUser({ role: 'admin' });
    const card = await createCard(ctx.owner, { creatorUserId: creator });
    const payload = JSON.stringify({
      slug: `integrity-${randomUUID()}`,
      title: 'Solid-state batteries',
    });
    const row = await ownerRow<{ request: string; publication_sha: string }>(
      `INSERT INTO card_publication_requests (user_id, card_id, requested_by, card_text_hash,
                                              publication_payload, publication_sha)
       VALUES ($1, $2, $3, $4, $5::jsonb,
               encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex'))
       RETURNING id::text AS request, publication_sha`,
      [creator, card.id, admin, card.textHash, payload],
    );
    return {
      creator,
      admin,
      card: card.id,
      textHash: card.textHash,
      publicationSha: row.publication_sha,
      request: row.request,
    };
  }

  function evidence(p: Proposal): string {
    return JSON.stringify({
      policyVersion: 1,
      creatorUserId: p.creator,
      cardTextHash: p.textHash,
      publicationSha: p.publicationSha,
      requestVersion: '1',
      anchorSource: 'created_at',
      anchorAt: '2026-01-01T00:00:00.000000Z',
      checkedAt: '2026-09-01T00:00:00.000000Z',
    });
  }

  async function respond(p: Proposal, sets: string): Promise<void> {
    await expectOneRow(execute(ctx.owner, update(sets), [p.request], { [RESPONSE]: p.card }));
  }

  async function promotedProposal(): Promise<Proposal> {
    const p = await openProposal();
    await expectOneRow(
      execute(ctx.owner, update(PROMOTE), [p.request, p.admin, evidence(p)], {
        [PROMOTION]: p.card,
      }),
    );
    return p;
  }

  describe('insert', () => {
    it("records a pending proposal for the card's creator with the exact hashes", async () => {
      const p = await openProposal();
      expect(
        await ownerRow(
          `SELECT status, user_id, version::int AS version
             FROM card_publication_requests WHERE id = $1`,
          [p.request],
        ),
      ).toEqual({ status: 'pending', user_id: p.creator, version: 1 });
    });

    it('rejects anything but a pending proposal of the creator with matching hashes', async () => {
      const creator = await newUser();
      const other = await newUser();
      const admin = await newUser({ role: 'admin' });
      const card = await createCard(ctx.owner, { creatorUserId: creator });
      const payload = JSON.stringify({ title: 'Solid-state batteries' });
      const base = {
        user_id: creator,
        card_id: card.id,
        requested_by: admin,
        card_text_hash: card.textHash,
        publication_payload: payload,
        publication_sha: await jsonbSha(payload),
      };
      const insert = (columns: Record<string, unknown>) => {
        const names = Object.keys(columns);
        return ctx.owner.query(
          `INSERT INTO card_publication_requests (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(columns),
        );
      };
      const promotedEvidence = JSON.stringify({ policyVersion: 1, creatorUserId: creator });
      const invalid: [string, Record<string, unknown>][] = [
        ['requester other than the creator', { ...base, user_id: other }],
        ['no requester', { ...base, user_id: null }],
        ['stale card text hash', { ...base, card_text_hash: 'f'.repeat(64) }],
        ['wrong proposal hash', { ...base, publication_sha: '0'.repeat(64) }],
        ['already answered', { ...base, status: 'approved', responded_at: new Date() }],
        ['response time', { ...base, responded_at: new Date() }],
        ['expired', { ...base, status: 'expired' }],
        [
          'authorization kind',
          {
            ...base,
            authorization_kind: 'creator_inactive_30d',
            authorization_evidence: promotedEvidence,
          },
        ],
        ['promotion time', { ...base, promoted_at: new Date() }],
        [
          'promotion evidence',
          {
            ...base,
            status: 'promoted',
            promoted_at: new Date(),
            authorization_kind: 'creator_inactive_30d',
            authorization_evidence: promotedEvidence,
          },
        ],
        ['promoter', { ...base, promoted_by: admin }],
      ];
      for (const [label, columns] of invalid) {
        await expectViolation(insert(columns), TRIGGER, label);
      }
      await expectOneRow(insert(base));
    });
  });

  describe('responses and status', () => {
    it('records a creator response only inside the response transaction for the card', async () => {
      const p = await openProposal();
      const otherCard = await insertCard(ctx.owner);
      await expectViolation(
        ctx.owner.query(update(APPROVE), [p.request]),
        TRIGGER,
        'approve without flag',
      );
      await expectViolation(
        execute(ctx.owner, update(APPROVE), [p.request], { [RESPONSE]: otherCard }),
        TRIGGER,
        'approve with a flag for another card',
      );
      await expectViolation(
        execute(ctx.owner, update(APPROVE), [p.request], { [PROMOTION]: p.card }),
        TRIGGER,
        'approve with the promotion flag',
      );
      await expectViolation(
        ctx.owner.query(update('responded_at = now()'), [p.request]),
        TRIGGER,
        'response time without flag',
      );
      await respond(p, APPROVE);
      // Consent may be withdrawn before promotion, again only by the creator response.
      await expectViolation(
        ctx.owner.query(update(DECLINE), [p.request]),
        TRIGGER,
        'withdraw without flag',
      );
      await respond(p, DECLINE);
      expect(
        await ownerRow(
          'SELECT status, version::int AS version FROM card_publication_requests WHERE id = $1',
          [p.request],
        ),
      ).toEqual({ status: 'rejected', version: 3 });
    });

    it('declines a pending proposal with the response flag; a decline is final', async () => {
      const p = await openProposal();
      await respond(p, DECLINE);
      await expectViolation(
        execute(ctx.owner, update(APPROVE), [p.request], { [RESPONSE]: p.card }),
        TRIGGER,
        'approve after decline',
      );
      await expectViolation(
        ctx.workerPool.query(update(`status = 'expired'`), [p.request]),
        TRIGGER,
        'expire after decline',
      );
      await expectViolation(
        execute(ctx.owner, update(PROMOTE), [p.request, p.admin, evidence(p)], {
          [PROMOTION]: p.card,
        }),
        TRIGGER,
        'promote after decline',
      );
    });

    it('expires pending and approved proposals without a flag; expired is final', async () => {
      const pending = await openProposal();
      await expectOneRow(ctx.workerPool.query(update(`status = 'expired'`), [pending.request]));
      const approved = await openProposal();
      await respond(approved, APPROVE);
      await expectOneRow(ctx.workerPool.query(update(`status = 'expired'`), [approved.request]));
      await expectViolation(
        ctx.workerPool.query(update(`status = 'pending', version = version + 1`), [
          pending.request,
        ]),
        TRIGGER,
        'reopen',
      );
    });

    it('promotes only in the promotion transaction for the card', async () => {
      const p = await openProposal();
      const otherCard = await insertCard(ctx.owner);
      const params = [p.request, p.admin, evidence(p)];
      await expectViolation(ctx.owner.query(update(PROMOTE), params), TRIGGER, 'no flag');
      await expectViolation(
        execute(ctx.owner, update(PROMOTE), params, { [PROMOTION]: otherCard }),
        TRIGGER,
        'flag for another card',
      );
      await expectViolation(
        execute(ctx.owner, update(PROMOTE), params, { [RESPONSE]: p.card }),
        TRIGGER,
        'response flag',
      );
      await expectViolation(
        ctx.owner.query(
          update(`authorization_kind = 'creator_inactive_30d', authorization_evidence = $2::jsonb`),
          [p.request, evidence(p)],
        ),
        TRIGGER,
        'evidence without promotion',
      );
      // The table CHECKs: a promoted row carries its time and authorization.
      await expectViolation(
        execute(
          ctx.owner,
          update(`status = 'promoted', authorization_kind = 'creator_inactive_30d',
                  authorization_evidence = $2::jsonb`),
          [p.request, evidence(p)],
          { [PROMOTION]: p.card },
        ),
        'card_publication_requests_promoted_at',
      );
      await expectViolation(
        execute(ctx.owner, update(`status = 'promoted', promoted_at = now()`), [p.request], {
          [PROMOTION]: p.card,
        }),
        'card_publication_requests_promoted_kind',
      );
      await expectOneRow(execute(ctx.owner, update(PROMOTE), params, { [PROMOTION]: p.card }));
    });

    it('never answers or promotes a request whose creator was erased', async () => {
      const p = await openProposal();
      // Erasure: the FK sets the request's user_id (and the card's creator) to NULL.
      await ctx.owner.query('DELETE FROM users WHERE id = $1', [p.creator]);
      await expectViolation(
        execute(ctx.owner, update(APPROVE), [p.request], { [RESPONSE]: p.card }),
        TRIGGER,
        'approve',
      );
      await expectViolation(
        execute(ctx.owner, update(DECLINE), [p.request], { [RESPONSE]: p.card }),
        TRIGGER,
        'decline',
      );
      await expectViolation(
        execute(ctx.owner, update(PROMOTE), [p.request, p.admin, evidence(p)], {
          [PROMOTION]: p.card,
        }),
        TRIGGER,
        'promote',
      );
    });

    it('keeps a promoted request final', async () => {
      const p = await promotedProposal();
      await expectViolation(
        ctx.workerPool.query(update(`status = 'expired'`), [p.request]),
        TRIGGER,
        'expire',
      );
      await expectViolation(
        execute(ctx.owner, update(DECLINE), [p.request], { [RESPONSE]: p.card }),
        TRIGGER,
        'decline',
      );
      await expectViolation(
        ctx.owner.query(update(`status = 'pending', version = version + 1`), [p.request]),
        TRIGGER,
        'reopen',
      );
    });
  });

  describe('published authorization evidence', () => {
    it('is immutable while the creator exists; only promoted_by may be cleared', async () => {
      const p = await promotedProposal();
      const otherAdmin = await newUser({ role: 'admin' });
      const edits = [
        `authorization_evidence = jsonb_set(authorization_evidence, '{creatorUserId}', 'null')`,
        `authorization_evidence = authorization_evidence || '{"note": "edited"}'`,
        `authorization_kind = 'creator_approval'`,
        `promoted_at = promoted_at - interval '1 minute'`,
        `promoted_by = '${otherAdmin}'`,
      ];
      for (const edit of edits) {
        await expectViolation(ctx.owner.query(update(edit), [p.request]), TRIGGER, edit);
      }
      await expectOneRow(
        ctx.owner.query(update('promoted_by = NULL, requested_by = NULL'), [p.request]),
      );
    });

    it("nulls only creatorUserId after the creator's hard deletion", async () => {
      const p = await promotedProposal();
      await expectOneRow(execute(ctx.workerPool, 'DELETE FROM users WHERE id = $1', [p.creator]));
      expect(
        await ownerRow('SELECT user_id, status FROM card_publication_requests WHERE id = $1', [
          p.request,
        ]),
      ).toEqual({ user_id: null, status: 'promoted' });
      const nullCreator = `jsonb_set(authorization_evidence, '{creatorUserId}', 'null')`;
      const edits = [
        `authorization_evidence = jsonb_set(authorization_evidence, '{cardTextHash}', '"x"')`,
        `authorization_evidence = authorization_evidence - 'creatorUserId'`,
        `authorization_evidence = jsonb_set(${nullCreator}, '{requestVersion}', '"9"')`,
      ];
      for (const edit of edits) {
        await expectViolation(ctx.workerPool.query(update(edit), [p.request]), TRIGGER, edit);
      }
      await expectOneRow(
        ctx.workerPool.query(update(`authorization_evidence = ${nullCreator}`), [p.request]),
      );
      const { evidence: stored } = await ownerRow<{ evidence: Record<string, unknown> }>(
        'SELECT authorization_evidence AS evidence FROM card_publication_requests WHERE id = $1',
        [p.request],
      );
      expect(stored).toEqual({
        ...(JSON.parse(evidence(p)) as Record<string, unknown>),
        creatorUserId: null,
      });
    });
  });

  describe('proposal changes and identity', () => {
    const CHANGE = `publication_payload = $2::jsonb,
                    publication_sha = encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex')`;
    const revised = () =>
      JSON.stringify({ slug: `integrity-${randomUUID()}`, title: 'Batteries, revised' });

    it('requires a new pending version with the matching hash for a changed proposal', async () => {
      const p = await openProposal();
      await expectViolation(
        ctx.owner.query(update(CHANGE), [p.request, revised()]),
        TRIGGER,
        'no version',
      );
      await expectViolation(
        ctx.owner.query(update(`card_text_hash = repeat('e', 64)`), [p.request]),
        TRIGGER,
        'text hash without a version',
      );
      const wrongHash = `publication_payload = $2::jsonb, publication_sha = repeat('0', 64),
                         version = version + 1`;
      await expectViolation(
        ctx.owner.query(update(wrongHash), [p.request, revised()]),
        TRIGGER,
        'wrong hash',
      );
      await expectOneRow(
        ctx.owner.query(update(`${CHANGE}, version = version + 1`), [p.request, revised()]),
      );
    });

    it('sends a changed approved proposal back to pending, never a declined one', async () => {
      const approved = await openProposal();
      await respond(approved, APPROVE);
      await expectViolation(
        ctx.owner.query(update(`${CHANGE}, version = version + 1`), [approved.request, revised()]),
        TRIGGER,
        'still approved',
      );
      const reopen = `${CHANGE}, version = version + 1, status = 'pending', responded_at = NULL`;
      await expectOneRow(ctx.owner.query(update(reopen), [approved.request, revised()]));
      const declined = await openProposal();
      await respond(declined, DECLINE);
      await expectViolation(
        ctx.owner.query(update(reopen), [declined.request, revised()]),
        TRIGGER,
        'declined',
      );
    });

    it('keeps the request identity immutable', async () => {
      const p = await openProposal();
      const other = await newUser();
      const otherCard = await insertCard(ctx.owner, { creatorUserId: p.creator });
      await expectOneRow(ctx.owner.query(update('version = version + 1'), [p.request]));
      const edits = [
        'id = DEFAULT',
        `card_id = ${otherCard}`,
        `requested_at = requested_at - interval '1 minute'`,
        `user_id = '${other}'`,
        `requested_by = '${other}'`,
        'version = version - 1',
      ];
      for (const edit of edits) {
        await expectViolation(ctx.owner.query(update(edit), [p.request]), TRIGGER, edit);
      }
    });
  });
});

// ── Library revision chain ──────────────────────────────────────────────────────────────────────

describe('library_card_versions_guard', () => {
  const TRIGGER = 'library_card_versions_guard';
  const addVersion = (slug: string, version: number, card: string, previous: string | null) =>
    ctx.owner.query(
      `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
       VALUES ($1, $2, $3, $4)`,
      [slug, version, card, previous],
    );
  const libraryCards = async (n: number): Promise<string[]> => {
    const cards: string[] = [];
    for (let i = 0; i < n; i += 1)
      cards.push(await insertCard(ctx.owner, { visibility: 'public' }));
    return cards;
  };

  it('chains consecutive versions of one slug to their predecessor', async () => {
    const [v1, v2, v3] = (await libraryCards(3)) as [string, string, string];
    const slug = `battery-${randomUUID()}`;
    await expectViolation(addVersion(slug, 1, v1, v2), TRIGGER, 'version 1 with a predecessor');
    await expectOneRow(addVersion(slug, 1, v1, null));
    await expectViolation(
      addVersion(slug, 2, v2, null),
      TRIGGER,
      'version 2 without a predecessor',
    );
    await expectViolation(addVersion(slug, 2, v2, v3), TRIGGER, 'wrong predecessor');
    await expectViolation(addVersion(slug, 3, v3, v1), TRIGGER, 'gap');
    await expectOneRow(addVersion(slug, 2, v2, v1));
    await expectOneRow(addVersion(slug, 3, v3, v2));
  });

  it("rejects another slug's card as the predecessor", async () => {
    const [a1, b1, b2] = (await libraryCards(3)) as [string, string, string];
    const a = `alpha-${randomUUID()}`;
    const b = `beta-${randomUUID()}`;
    await expectOneRow(addVersion(a, 1, a1, null));
    await expectOneRow(addVersion(b, 1, b1, null));
    await expectViolation(addVersion(b, 2, b2, a1), TRIGGER);
  });

  it('rejects UPDATE and DELETE, as the worker and as the owner', async () => {
    const [v1, v2] = (await libraryCards(2)) as [string, string];
    const slug = `frozen-${randomUUID()}`;
    await expectOneRow(addVersion(slug, 1, v1, null));
    await expectOneRow(addVersion(slug, 2, v2, v1));
    const writes: [string, string][] = [
      ['update', 'UPDATE library_card_versions SET created_at = now() WHERE library_slug = $1'],
      [
        're-chain',
        `UPDATE library_card_versions SET previous_card_id = NULL
          WHERE library_slug = $1 AND version = 2`,
      ],
      ['delete', 'DELETE FROM library_card_versions WHERE library_slug = $1'],
    ];
    for (const [role, pool] of [
      ['worker', ctx.workerPool],
      ['owner', ctx.owner],
    ] as const) {
      for (const [label, text] of writes) {
        await expectViolation(pool.query(text, [slug]), TRIGGER, `${role}: ${label}`);
      }
    }
  });
});
