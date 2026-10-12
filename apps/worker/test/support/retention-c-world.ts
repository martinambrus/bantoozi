import { randomUUID } from 'node:crypto';

import { createHandlers, dispatch } from '../../src/handlers/index.js';
import { parseJobPayload, PLATFORM_USER_ID, type QueueName } from '@bantoozi/shared';
import { createCard, createUser } from '@bantoozi/testing';
import type pg from 'pg';

import type { RetentionBWorld } from './retention-b-world.js';
import { DAY, MINUTE } from './retention-world.js';

export { DAY, MINUTE, PLATFORM_USER_ID };

/** A deletion ledger entry as the worker appends it (spec 11 §5.1). */
export interface LedgerEntry {
  id: string;
  userId: string;
  deletedAt: string;
  emailHmac: string;
}

/** The ledger port and its key as `WorkerDeps` carries them (absent = unconfigured). */
export interface LedgerDeps {
  deletionLedger?: { append(entry: LedgerEntry): Promise<void> };
  deletionHmacKey?: string;
}

export const LEDGER_KEY = 'retention-c-ledger-key';

/**
 * An in-memory deletion ledger. For every append it records whether the entry's user row still
 * existed at that moment (the entry must precede the hard delete) and, per `failures`, throws.
 */
export class FakeLedger {
  readonly entries: LedgerEntry[] = [];
  readonly attempts: LedgerEntry[] = [];
  readonly userPresent = new Map<string, boolean>();

  /** `failures`: the number of leading appends that throw, or a predicate on the entry. */
  constructor(
    private readonly owner: pg.Pool,
    private readonly failures: number | ((entry: LedgerEntry) => boolean) = 0,
  ) {}

  async append(entry: LedgerEntry): Promise<void> {
    this.attempts.push(entry);
    const present = await this.owner.query(`SELECT 1 FROM users WHERE id = $1`, [entry.userId]);
    this.userPresent.set(entry.userId, (present.rowCount ?? 0) > 0);
    const fail =
      typeof this.failures === 'number'
        ? this.attempts.length <= this.failures
        : this.failures(entry);
    if (fail) throw new Error('ledger unavailable');
    this.entries.push(entry);
  }

  of(userId: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.userId === userId);
  }
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
export const startOfUtcDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export interface UsageValues {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Fixtures of the `house.purge-engine-calls`, `house.retire-cards` and `house.purge-users` tests
 * (spec 11 §5, §5.1, §6): plain-SQL rows for spend, queue and card state, and a runner that adds
 * the ledger port to the worker dependencies.
 */
export class RetentionCWorld {
  constructor(readonly b: RetentionBWorld) {}

  get owner(): pg.Pool {
    return this.b.owner;
  }

  /** Run a registered handler as if the clock read `now`, with the ledger port when given. */
  async run(queue: QueueName, now: Date, ledger?: LedgerDeps): Promise<void> {
    const extra: LedgerDeps = ledger ?? {};
    const handlers = createHandlers({ ...this.b.w.h.deps, ...extra, now: () => now });
    await dispatch(handlers, queue, parseJobPayload(queue, {}), { queue, jobId: 'direct' });
  }

  ledgerDeps(ledger: FakeLedger | undefined, key: string | undefined = LEDGER_KEY): LedgerDeps {
    return {
      ...(ledger === undefined ? {} : { deletionLedger: ledger }),
      ...(key === undefined ? {} : { deletionHmacKey: key }),
    };
  }

  // ── Spend ─────────────────────────────────────────────────────────────────────────────────

  async reservation(options: {
    day: string;
    status: 'reserved' | 'uncertain' | 'settled';
    reservedUsd: number;
    reservedCalls?: number;
    userId?: string | null;
    engine?: string;
    kind?: string;
  }): Promise<string> {
    const id = randomUUID();
    const at = startOfUtcDay(options.day);
    await this.owner.query(
      `INSERT INTO engine_reservations (id, day, engine, kind, user_id, reserved_usd, reserved_calls,
                                        status, actual_usd, created_at, settled_at, expires_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        options.day,
        options.engine ?? 'typesafe',
        options.kind ?? 'match',
        options.userId ?? null,
        options.reservedUsd,
        options.reservedCalls ?? 1,
        options.status,
        options.status === 'settled' ? options.reservedUsd : null,
        at,
        options.status === 'settled' ? at : null,
        new Date(at.getTime() + 10 * MINUTE),
      ],
    );
    return id;
  }

  async call(options: {
    createdAt: Date;
    reservationId?: string | null;
    userId?: string | null;
    engine?: string;
    kind?: string;
    billing?: 'known' | 'uncertain';
    costUsd?: number;
  }): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO engine_calls (engine, kind, reservation_id, logical_request_id, user_id, cost_usd,
                                 billing, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok', $8) RETURNING id::text AS id`,
      [
        options.engine ?? 'typesafe',
        options.kind ?? 'match',
        options.reservationId ?? null,
        randomUUID(),
        options.userId ?? null,
        options.costUsd ?? 0,
        options.billing ?? 'known',
        options.createdAt,
      ],
    );
    return result.rows[0]!.id;
  }

  async setUsage(
    day: string,
    userId: string,
    engine: string,
    kind: string,
    values: Partial<UsageValues>,
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO usage_daily (day, user_id, engine, kind, calls, input_tokens, output_tokens, cost_usd)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)`,
      [
        day,
        userId,
        engine,
        kind,
        values.calls ?? 0,
        values.inputTokens ?? 0,
        values.outputTokens ?? 0,
        values.costUsd ?? 0,
      ],
    );
  }

  async usage(
    day: string,
    userId: string,
    engine: string,
    kind: string,
  ): Promise<UsageValues | null> {
    const result = await this.owner.query<{
      calls: number;
      input: string;
      output: string;
      cost: string;
    }>(
      `SELECT calls, input_tokens::text AS input, output_tokens::text AS output, cost_usd::text AS cost
         FROM usage_daily WHERE day = $1::date AND user_id = $2 AND engine = $3 AND kind = $4`,
      [day, userId, engine, kind],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          calls: row.calls,
          inputTokens: Number(row.input),
          outputTokens: Number(row.output),
          costUsd: Number(row.cost),
        };
  }

  /** Whole-table totals of `usage_daily` (what a purge must never change). */
  async usageTotals(): Promise<{ calls: number; costUsd: number; inputTokens: number }> {
    const result = await this.owner.query<{ calls: string; cost: string; input: string }>(
      `SELECT coalesce(sum(calls), 0)::text AS calls, coalesce(sum(cost_usd), 0)::text AS cost,
              coalesce(sum(input_tokens), 0)::text AS input FROM usage_daily`,
    );
    const row = result.rows[0]!;
    return { calls: Number(row.calls), costUsd: Number(row.cost), inputTokens: Number(row.input) };
  }

  async reservationRow(id: string): Promise<{
    status: string;
    actualUsd: number | null;
    settledAt: Date | null;
  } | null> {
    const result = await this.owner.query<{
      status: string;
      actual: string | null;
      settled_at: Date | null;
    }>(
      `SELECT status, actual_usd::text AS actual, settled_at FROM engine_reservations WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          status: row.status,
          actualUsd: row.actual === null ? null : Number(row.actual),
          settledAt: row.settled_at,
        };
  }

  callExists(id: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM engine_calls WHERE id = $1', id);
  }

  // ── Queue and event rows ──────────────────────────────────────────────────────────────────

  /** A running request holding `leaseToken` (the state a late completion would come back to). */
  async runRequest(id: string, leaseToken: string, leaseUntil: Date): Promise<void> {
    await this.owner.query(
      `UPDATE analysis_requests SET status = 'running', lease_token = $2, lease_until = $3, attempts = 1
        WHERE id = $1`,
      [id, leaseToken, leaseUntil],
    );
  }

  async request(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.owner.query(
      `SELECT status, last_error_code, lease_token, lease_until, completed_at, attempts, created_at,
              result_snapshot
         FROM analysis_requests WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async outbox(options: {
    createdAt: Date;
    deliveredAt?: Date | null;
    userId?: string | null;
    attempts?: number;
  }): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO job_outbox (queue, payload, user_id, created_at, available_at, delivered_at, attempts)
       VALUES ('user.rank', '{}'::jsonb, $1, $2, $2, $3, $4) RETURNING id::text AS id`,
      [
        options.userId ?? null,
        options.createdAt,
        options.deliveredAt ?? null,
        options.attempts ?? 0,
      ],
    );
    return result.rows[0]!.id;
  }

  outboxExists(id: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM job_outbox WHERE id = $1', id);
  }

  async feedbackEvent(userId: string, articleId: string, createdAt: Date): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO feedback_events (user_id, article_id, kind, created_at)
       VALUES ($1, $2, 'open', $3) RETURNING id::text AS id`,
      [userId, articleId, createdAt],
    );
    return result.rows[0]!.id;
  }

  feedbackEventExists(id: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM feedback_events WHERE id = $1', id);
  }

  // ── Cards ─────────────────────────────────────────────────────────────────────────────────

  /** An unheld private card of `ownerId`. */
  async privateCard(ownerId: string, kind: 'interest' | 'label' = 'interest'): Promise<string> {
    return (await createCard(this.owner, { kind, visibility: 'private', ownerUserId: ownerId })).id;
  }

  /** An unheld shared (non-public) user card. */
  async sharedCard(creatorId: string): Promise<string> {
    return (await createCard(this.owner, { visibility: 'shared', creatorUserId: creatorId })).id;
  }

  async publicCard(): Promise<string> {
    return (await createCard(this.owner, { visibility: 'public' })).id;
  }

  async hold(userId: string, cardId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [userId, cardId],
    );
  }

  async holdLabel(userId: string, cardId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Held label')`,
      [userId, cardId],
    );
  }

  async retiredAt(cardId: string, at: Date | null): Promise<void> {
    await this.owner.query(`UPDATE interest_cards SET retired_at = $2 WHERE id = $1`, [cardId, at]);
  }

  async card(cardId: string): Promise<{ retiredAt: Date | null; parent: string | null } | null> {
    const result = await this.owner.query<{ retired_at: Date | null; parent: string | null }>(
      `SELECT retired_at, parent_card_id::text AS parent FROM interest_cards WHERE id = $1`,
      [cardId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { retiredAt: row.retired_at, parent: row.parent };
  }

  /** `count` article answers of the card (articles with a carrier in a fresh feed). */
  async answers(cardId: string, count = 2): Promise<string[]> {
    await this.owner.query(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', 'retention-c', 'retention-c-sha', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    const feedId = await this.b.feed();
    const articleIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const articleId = await this.b.w.article([{ feedId, at: new Date() }]);
      articleIds.push(articleId);
      await this.owner.query(
        `INSERT INTO card_answers (article_id, card_id, p, engine, model, question_set_sha, article_revision,
                                  state_sha256, card_input_sha256, state_variant)
         VALUES ($1, $2, 0.5, 'typesafe', NULL, 'retention-c-sha', 1, 'x', 'y', 'native')`,
        [articleId, cardId],
      );
    }
    return articleIds;
  }

  async answerCount(cardId: string): Promise<number> {
    const result = await this.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM card_answers WHERE card_id = $1`,
      [cardId],
    );
    return result.rows[0]!.n;
  }

  async cardExists(cardId: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM interest_cards WHERE id = $1', cardId);
  }

  async libraryVersion(cardId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO library_card_versions (library_slug, version, card_id) VALUES ($1, 1, $2)`,
      [`slug-${randomUUID()}`, cardId],
    );
  }

  /** A pending publication request of the card's creator. */
  async publicationRequest(cardId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO card_publication_requests (user_id, card_id, requested_by, card_text_hash,
                                              publication_payload, publication_sha)
       SELECT c.creator_user_id, c.id, c.creator_user_id, c.text_hash, '{}'::jsonb,
              encode(sha256(convert_to('{}', 'UTF8')), 'hex')
         FROM interest_cards c WHERE c.id = $1`,
      [cardId],
    );
  }

  /** An `eval.rater_cards` row naming the card. */
  async evalRaterCard(cardId: string): Promise<void> {
    const rater = await this.owner.query<{ id: string }>(
      `INSERT INTO eval.raters (name, participant_key, token_hash, token_expires_at, langs)
       VALUES ('r', $1::uuid, $1::uuid::text, now() + interval '1 day', ARRAY['en']) RETURNING id::text AS id`,
      [randomUUID()],
    );
    await this.owner.query(
      `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [rater.rows[0]!.id, cardId],
    );
  }

  /** An `eval.run_answers` row naming the card. */
  async evalRunAnswer(cardId: string): Promise<void> {
    const version = `c-${randomUUID().slice(0, 8)}`;
    await this.owner.query(
      `INSERT INTO eval.datasets (version, seed, params) VALUES ($1, 's', '{}'::jsonb)`,
      [version],
    );
    const run = await this.owner.query<{ id: string }>(
      `INSERT INTO eval.runs (experiment, dataset_version, config, git_sha)
       VALUES ('X', $1, '{}'::jsonb, 'sha') RETURNING id::text AS id`,
      [version],
    );
    const feedId = await this.b.feed();
    const articleId = await this.b.w.article([{ feedId, at: new Date() }]);
    await this.owner.query(
      `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
       VALUES ($1, $2, $3, 'q', '{}'::jsonb)`,
      [run.rows[0]!.id, articleId, cardId],
    );
  }

  /** A fork of the parent card that a user holds (its `parent_card_id` is the parent). */
  async fork(parentId: string, ownerId: string): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO interest_cards (kind, title, body, text_hash, lang, origin, visibility,
                                   parent_card_id, owner_user_id, creator_user_id)
       SELECT kind, 'Fork of ' || title, body, md5(random()::text), lang, 'fork', 'private', id, $2, $2
         FROM interest_cards WHERE id = $1 RETURNING id::text AS id`,
      [parentId, ownerId],
    );
    const id = result.rows[0]!.id;
    await this.hold(ownerId, id);
    return id;
  }

  // ── Users ─────────────────────────────────────────────────────────────────────────────────

  async deletedUser(
    deletedAt: Date | null,
    email?: string,
  ): Promise<{ id: string; email: string }> {
    return createUser(this.owner, {
      deletedAt,
      ...(email === undefined ? {} : { email }),
    });
  }

  userExists(id: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM users WHERE id = $1', id);
  }

  async invite(options: {
    createdBy?: string | null;
    email?: string | null;
    note?: string | null;
    usedBy?: string | null;
  }): Promise<string> {
    const code = `inv-${randomUUID()}`;
    await this.owner.query(
      `INSERT INTO invites (code, created_by, email, note, expires_at, used_by, used_at)
       VALUES ($1, $2, $3, $4, now() + interval '400 days', $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)`,
      [
        code,
        options.createdBy ?? null,
        options.email ?? null,
        options.note ?? null,
        options.usedBy ?? null,
      ],
    );
    return code;
  }

  async inviteRow(
    code: string,
  ): Promise<{ email: string | null; note: string | null; usedBy: string | null } | null> {
    const result = await this.owner.query<{
      email: string | null;
      note: string | null;
      used_by: string | null;
    }>(`SELECT email::text AS email, note, used_by::text AS used_by FROM invites WHERE code = $1`, [
      code,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : { email: row.email, note: row.note, usedBy: row.used_by };
  }

  async waitlist(email: string): Promise<void> {
    await this.owner.query(`INSERT INTO waitlist (email) VALUES ($1)`, [email]);
  }

  waitlisted(email: string): Promise<boolean> {
    return this.b.exists('SELECT 1 FROM waitlist WHERE email = $1', email);
  }

  async subscriberCount(feedId: string): Promise<number> {
    const result = await this.owner.query<{ n: number }>(
      `SELECT subscriber_count AS n FROM feeds WHERE id = $1`,
      [feedId],
    );
    return result.rows[0]!.n;
  }
}
