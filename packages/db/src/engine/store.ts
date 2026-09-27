import {
  AppError,
  EngineCircuitSchema,
  isUuid,
  newUuid,
  parseSetting,
  PLATFORM_USER_ID,
  settingDefault,
  settingSchema,
  utcDay,
  type BreakerState,
  type BudgetSnapshot,
  type CallKind,
  type EngineCallRow,
  type EngineCircuit,
  type EngineStore,
  type SettingValue,
  type UsageRow,
} from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Database, Executor, Transaction } from '../client.js';
import { readStoredSetting } from '../settings.js';
import { isInferenceAuthorized } from './authorization.js';

/**
 * The PostgreSQL {@link EngineStore} (spec 04 §1, §6; spec 02 §3.1, §3.3), for the worker role.
 * Every method is one short transaction; none is held open across provider HTTP.
 *
 * **Spend ledger.** `engine_reservations` is the budget ledger: each wire attempt reserves its
 * estimated upper cost, and a reservation counts once: `settled` at its actual cost, `reserved` and
 * `uncertain` at the reserved amount. `engine_calls` is the per-attempt audit linked by the unique
 * `reservation_id`, so one reservation and its audit row are never counted twice. Budget queries
 * select by the reservation's UTC `day`, so a settlement after midnight stays on the day of its
 * send, and `kind = 'eval'` never counts against the production budget.
 *
 * **Admission** (`reserveSpend`) runs under a transaction advisory lock of the UTC day: recheck
 * the inference authorization (with its row locks), then the call cap (same engine, same cap
 * group, all statuses), then the production budget (committed + estimate within 100 %, or 110 %
 * for interactive requests), then insert the reservation, stamp a suggestion attempt, and mark
 * 80 %/100 % crossings in `settings['engine.budget_alerts']`. Concurrent reservations therefore
 * cannot exceed the budget. Settlement writes the call row, the `usage_daily` rollup and the
 * reservation state in one transaction and is idempotent on the reservation id; unknown billing
 * keeps the reservation `uncertain` (still charged) until a known settlement reconciles it. An
 * admitted attempt that is cancelled before its send deletes its `reserved` row instead (D-95).
 *
 * **Shared breaker state.** `readCircuit`/`updateCircuit` implement the engine's `CircuitStore`
 * for `settings['engine.circuit']`: an update locks the row (inserting the default first when
 * missing), applies the caller's transition to the fresh value and writes back only that engine's
 * entry. An auth-mode transition may be guarded by the credential version still being active.
 */

export interface PgEngineStoreOptions {
  /** `DAILY_BUDGET_USD`: the budget while `settings['engine.daily_budget_usd']` is missing. */
  dailyBudgetUsd: number;
  /**
   * How long a reservation stays `reserved` before housekeeping may turn it `uncertain` (spec 11
   * §5). It must exceed the longest attempt (60 s LLM timeout) plus settlement; default 10 min.
   */
  reservationTtlMs?: number;
}

/** Only the credential version still active may put a breaker into auth mode. */
export interface CircuitCredentialGuard {
  provider: 'typesafe' | 'ollama';
  /** The DB credential version of the failed attempt; `null` for an environment key. */
  version: string | null;
}

export interface PgEngineStore extends EngineStore {
  /** The stored `engine.circuit` value, or the all-closed default. */
  readCircuit(): Promise<EngineCircuit>;
  /** Apply `update` to one engine's entry under the settings row lock (see the module comment). */
  updateCircuit(
    engine: 'typesafe' | 'llm',
    update: (current: EngineCircuit) => BreakerState | null,
    options?: { credential?: CircuitCredentialGuard },
  ): Promise<{ circuit: EngineCircuit; changed: boolean }>;
}

const CALL_KINDS: readonly CallKind[] = [
  'enrich',
  'match',
  'cluster',
  'suggest',
  'translate',
  'eval',
  'credential_probe',
];
const CALL_ENGINES = ['typesafe', 'llm', 'laya', 'libretranslate'] as const;
const CALL_STATUSES = [
  'ok',
  'error',
  'timeout',
  'rate_limited',
  'invalid_request',
  'invalid_response',
  'auth_error',
] as const;
/** Kinds sharing one daily call cap per engine (the LLM fallback cap, spec 04 §5). */
const DECISION_KINDS: readonly CallKind[] = ['enrich', 'match', 'cluster', 'suggest'];
const INTERACTIVE_ALLOWANCE = 0.1;
const ALERT_THRESHOLDS = [
  { key: 'p80At', ratio: 0.8 },
  { key: 'p100At', ratio: 1 },
] as const;
const BUDGET_LOCK_PREFIX = 'engine_budget:';
/** `engine_calls.cost_usd` is numeric(12,8); budgets are at most 10,000 USD. */
const MAX_USD = 9_999;
const USD_SCALE = 1e8;
const EPSILON = 1e-9;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERROR_LENGTH = 500;

/** A reserve rounded **up** to the stored 1e-8 USD precision: never under-reserve. */
function reserveUsd(usd: number): string {
  return (Math.ceil(usd * USD_SCALE - 1e-6) / USD_SCALE).toFixed(8);
}

/** An actual cost at the stored precision. */
function costUsd(usd: number): string {
  return (Math.round(usd * USD_SCALE) / USD_SCALE).toFixed(8);
}

function assertUsd(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_USD) {
    throw new RangeError(`${name} must be a finite amount between 0 and ${MAX_USD} USD`);
  }
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 31 - 1) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day) || utcDay(new Date(`${day}T00:00:00Z`)) !== day) {
    throw new RangeError('day must be a UTC calendar day YYYY-MM-DD');
  }
}

function assertKind(kind: string): asserts kind is CallKind {
  if (!(CALL_KINDS as readonly string[]).includes(kind)) throw new RangeError('unknown call kind');
}

function assertCallRow(row: EngineCallRow): void {
  if (!(CALL_ENGINES as readonly string[]).includes(row.engine)) {
    throw new RangeError('unknown engine');
  }
  assertKind(row.kind);
  if (!(CALL_STATUSES as readonly string[]).includes(row.status)) {
    throw new RangeError('unknown call status');
  }
  if (!isUuid(row.logicalRequestId)) throw new RangeError('logicalRequestId must be a UUID');
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 2 ** 31 - 1) {
    throw new RangeError('attempts must be a positive integer');
  }
  assertCount('nQuestions', row.nQuestions);
  assertCount('inputTokens', row.inputTokens);
  assertCount('outputTokens', row.outputTokens);
  if (row.latencyMs !== undefined) assertCount('latencyMs', Math.round(row.latencyMs));
  assertUsd('costUsd', row.costUsd);
  if (!(row.createdAt instanceof Date) || Number.isNaN(row.createdAt.getTime())) {
    throw new RangeError('createdAt must be a valid Date');
  }
}

const capKinds = (kind: CallKind): readonly CallKind[] =>
  DECISION_KINDS.includes(kind) ? DECISION_KINDS : [kind];

/** `excludeKinds` as a text array (`'none'` excludes nothing). */
const excluded = (kinds: CallKind[] | 'none'): string[] => (kinds === 'none' ? [] : [...kinds]);

/** UTC midnight of `day` as a timestamptz expression, independent of the session time zone. */
const utcMidnight = (day: string) => sql`(${day}::date::timestamp AT TIME ZONE 'UTC')`;

async function dailyBudgetUsd(db: Executor, fallbackUsd: number): Promise<number> {
  const stored = await readStoredSetting(db, 'engine.daily_budget_usd');
  return stored === undefined ? fallbackUsd : parseSetting('engine.daily_budget_usd', stored);
}

/** Committed production spend of a UTC day: settled actual plus reserved/uncertain reserves. */
async function committedProductionUsd(db: Executor, day: string): Promise<number> {
  const result = await db.execute<{ usd: string }>(sql`
    SELECT coalesce(sum(CASE WHEN r.status = 'settled' THEN r.actual_usd ELSE r.reserved_usd END), 0)::text AS usd
      FROM engine_reservations r
     WHERE r.day = ${day}::date AND r.kind <> 'eval'`);
  return Number(result.rows[0]?.usd ?? '0');
}

/**
 * Mark the 80 %/100 % crossings of the day's committed production spend in
 * `settings['engine.budget_alerts']`, each at most once per UTC day, under the row lock. A record
 * of a later day is never replaced by a late settlement of an earlier one. No email is sent here:
 * `house.alerts` alone notifies (spec 11 §6).
 */
async function markBudgetCrossings(tx: Transaction, day: string, fallbackUsd: number) {
  const budget = await dailyBudgetUsd(tx, fallbackUsd);
  if (!(budget > 0)) return;
  const committed = await committedProductionUsd(tx, day);
  const due = ALERT_THRESHOLDS.filter((t) => committed >= budget * t.ratio - EPSILON);
  if (due.length === 0) return;
  await tx.execute(sql`
    INSERT INTO settings (key, value) VALUES ('engine.budget_alerts', ${JSON.stringify({ day })}::jsonb)
    ON CONFLICT (key) DO NOTHING`);
  const locked = await tx.execute<{ value: unknown; now: string }>(sql`
    SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
      FROM settings WHERE key = 'engine.budget_alerts' FOR UPDATE`);
  const row = locked.rows[0];
  if (row === undefined) return;
  const parsed = settingSchema('engine.budget_alerts').safeParse(row.value);
  const current = parsed.success
    ? (parsed.data as SettingValue<'engine.budget_alerts'>)
    : undefined;
  if (current !== undefined && current.day > day) return;
  const next: SettingValue<'engine.budget_alerts'> =
    current?.day === day ? { ...current } : { day };
  let changed = current?.day !== day;
  for (const { key } of due) {
    if (next[key] === undefined) {
      next[key] = row.now;
      changed = true;
    }
  }
  if (!changed) return;
  await tx.execute(sql`
    UPDATE settings SET value = ${JSON.stringify(parseSetting('engine.budget_alerts', next))}::jsonb,
                        updated_at = now(), updated_by = NULL
     WHERE key = 'engine.budget_alerts'`);
}

async function upsertUsageRow(db: Executor, row: UsageRow): Promise<void> {
  await db.execute(sql`
    INSERT INTO usage_daily AS u (day, user_id, engine, kind, calls, input_tokens, output_tokens, cost_usd)
    VALUES (${row.day}::date, ${row.userId}::uuid, ${row.engine}, ${row.kind}, ${row.calls},
            ${row.inputTokens}, ${row.outputTokens}, ${costUsd(row.costUsd)}::numeric)
    ON CONFLICT (day, user_id, engine, kind) DO UPDATE
       SET calls = u.calls + EXCLUDED.calls,
           input_tokens = u.input_tokens + EXCLUDED.input_tokens,
           output_tokens = u.output_tokens + EXCLUDED.output_tokens,
           cost_usd = u.cost_usd + EXCLUDED.cost_usd`);
}

function assertUsage(row: UsageRow): void {
  assertDay(row.day);
  if (!isUuid(row.userId)) throw new RangeError('usage userId must be a UUID');
  assertKind(row.kind);
  assertCount('calls', row.calls);
  assertCount('inputTokens', row.inputTokens);
  assertCount('outputTokens', row.outputTokens);
  assertUsd('costUsd', row.costUsd);
}

/**
 * The `engine_calls` insert of one attempt (no conflict target: both unique keys are arbiters).
 * A billed attempt is always audited: an article, question set or user that does not exist (any
 * more) is stored as NULL instead of failing the settlement on its foreign key.
 */
function insertCallSql(row: EngineCallRow, reservationId: string | null, cost: string) {
  const cardIds = row.cardIds === undefined ? null : row.cardIds;
  return sql`
    INSERT INTO engine_calls (engine, kind, model, article_id, question_set_id, reservation_id,
                              logical_request_id, credential_version, article_revision, state_sha256,
                              card_ids, user_id, n_questions, input_tokens, output_tokens, cost_usd,
                              billing, latency_ms, attempts, status, error, created_at)
    VALUES (${row.engine}, ${row.kind}, ${row.model ?? null},
            (SELECT a.id FROM articles a WHERE a.id = ${row.articleId ?? null}::bigint),
            (SELECT q.id FROM question_sets q WHERE q.id = ${row.questionSetId ?? null}::bigint),
            ${reservationId}::uuid,
            ${row.logicalRequestId}::uuid, ${row.credentialVersion ?? null}::bigint,
            ${row.articleRevision ?? null}::bigint, ${row.stateSha256 ?? null},
            ${cardIds === null ? null : sql.param(cardIds)}::bigint[],
            (SELECT u.id FROM users u WHERE u.id = ${row.userId ?? null}::uuid),
            ${row.nQuestions}, ${row.inputTokens}, ${row.outputTokens}, ${cost}::numeric,
            ${row.billing}, ${row.latencyMs === undefined ? null : Math.round(row.latencyMs)},
            ${row.attempts}, ${row.status},
            ${row.error === undefined ? null : row.error.slice(0, MAX_ERROR_LENGTH)},
            ${row.createdAt.toISOString()}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING id::text AS id`;
}

type ReservationRow = {
  day: string;
  engine: string;
  kind: string;
  status: 'reserved' | 'settled' | 'uncertain';
};

export function createPgEngineStore(db: Database, options: PgEngineStoreOptions): PgEngineStore {
  assertUsd('dailyBudgetUsd', options.dailyBudgetUsd);
  const ttlMs = options.reservationTtlMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
    throw new RangeError('reservationTtlMs must be at least one second');
  }
  const fallbackBudget = options.dailyBudgetUsd;

  async function settle(
    tx: Transaction,
    id: string,
    call: EngineCallRow,
    usage: UsageRow,
    billing: 'known' | 'uncertain',
  ): Promise<void> {
    const locked = await tx.execute<ReservationRow>(sql`
      SELECT day::text AS day, engine, kind, status
        FROM engine_reservations WHERE id = ${id}::uuid FOR UPDATE`);
    const reservation = locked.rows[0];
    if (reservation === undefined) throw new AppError('NOT_FOUND', 'Unknown engine reservation');
    if (reservation.engine !== call.engine || reservation.kind !== call.kind) {
      throw new AppError('VALIDATION_FAILED', 'The call does not match its reservation');
    }
    if (usage.engine !== call.engine || usage.kind !== call.kind) {
      throw new AppError('VALIDATION_FAILED', 'The usage row does not match its call');
    }
    const cost = billing === 'known' ? call.costUsd : 0;
    const prior = await tx.execute<{
      billing: string;
      input: number;
      output: number;
      cost: string;
    }>(sql`
      SELECT billing, input_tokens AS input, output_tokens AS output, cost_usd::text AS cost
        FROM engine_calls WHERE reservation_id = ${id}::uuid`);
    const previous = prior.rows[0];
    if (previous !== undefined) {
      // A replay changes nothing, except a known settlement reconciling an uncertain one.
      if (reservation.status !== 'uncertain' || billing !== 'known') return;
      if (previous.billing !== 'uncertain') return;
      await tx.execute(sql`
        UPDATE engine_calls
           SET billing = 'known', cost_usd = ${costUsd(cost)}::numeric,
               input_tokens = ${call.inputTokens}, output_tokens = ${call.outputTokens}
         WHERE reservation_id = ${id}::uuid`);
      await tx.execute(sql`
        UPDATE engine_reservations
           SET status = 'settled', actual_usd = ${costUsd(cost)}::numeric, settled_at = now()
         WHERE id = ${id}::uuid`);
      await upsertUsageRow(tx, {
        day: reservation.day,
        userId: usage.userId,
        engine: reservation.engine,
        kind: call.kind,
        calls: 0,
        inputTokens: Math.max(0, call.inputTokens - previous.input),
        outputTokens: Math.max(0, call.outputTokens - previous.output),
        costUsd: Math.max(0, cost - Number(previous.cost)),
      });
      if (reservation.kind !== 'eval')
        await markBudgetCrossings(tx, reservation.day, fallbackBudget);
      return;
    }
    if (reservation.status === 'settled') return;
    const inserted = await tx.execute(
      insertCallSql({ ...call, billing, costUsd: cost }, id, costUsd(cost)),
    );
    if (inserted.rows.length === 0) {
      throw new AppError('CONFLICT', 'Another reservation already recorded this attempt ordinal');
    }
    if (billing === 'known') {
      await tx.execute(sql`
        UPDATE engine_reservations
           SET status = 'settled', actual_usd = ${costUsd(cost)}::numeric, settled_at = now()
         WHERE id = ${id}::uuid`);
    } else {
      await tx.execute(
        sql`UPDATE engine_reservations SET status = 'uncertain' WHERE id = ${id}::uuid`,
      );
    }
    // The attempt counts on the reservation's budget day, even when settlement crossed midnight.
    await upsertUsageRow(tx, {
      day: reservation.day,
      userId: usage.userId,
      engine: reservation.engine,
      kind: call.kind,
      calls: usage.calls,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: cost,
    });
    if (reservation.kind !== 'eval') await markBudgetCrossings(tx, reservation.day, fallbackBudget);
  }

  return {
    async reserveSpend(input) {
      assertDay(input.day);
      assertKind(input.kind);
      assertUsd('estimateUsd', input.estimateUsd);
      if (
        typeof input.engine !== 'string' ||
        input.engine.length === 0 ||
        input.engine.length > 32
      ) {
        throw new RangeError('engine must be a short name');
      }
      if (input.priority !== 'interactive' && input.priority !== 'bulk') {
        throw new RangeError('priority must be interactive or bulk');
      }
      if (input.callCap !== undefined) assertCount('callCap', input.callCap);
      if (input.userId !== undefined && !isUuid(input.userId)) {
        throw new RangeError('userId must be a UUID');
      }
      // Eval spend is exempt from the production budget, and probes have their own purpose: each
      // needs its own authorization type.
      if ((input.kind === 'eval') !== (input.authorization.type === 'eval')) return null;
      if (input.kind === 'credential_probe' && input.authorization.type !== 'credential_probe') {
        return null;
      }
      const id = newUuid();
      const reserved = reserveUsd(input.estimateUsd);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${BUDGET_LOCK_PREFIX + input.day}, 0))`,
        );
        if (!(await isInferenceAuthorized(tx, input.authorization, { lock: true }))) return null;
        if (input.callCap !== undefined) {
          const used = await tx.execute<{ calls: number }>(sql`
            SELECT coalesce(sum(r.reserved_calls), 0)::int AS calls
              FROM engine_reservations r
             WHERE r.day = ${input.day}::date AND r.engine = ${input.engine}
               AND r.kind = ANY(${sql.param([...capKinds(input.kind)])}::text[])`);
          if ((used.rows[0]?.calls ?? 0) + 1 > input.callCap) return null;
        }
        const production = input.kind !== 'eval';
        if (production) {
          const budget = await dailyBudgetUsd(tx, fallbackBudget);
          const committed = await committedProductionUsd(tx, input.day);
          const limit =
            input.priority === 'interactive' ? budget * (1 + INTERACTIVE_ALLOWANCE) : budget;
          if (committed + Number(reserved) > limit + EPSILON) return null;
        }
        await tx.execute(sql`
          INSERT INTO engine_reservations (id, day, engine, kind, user_id, reserved_usd, reserved_calls,
                                           status, expires_at)
          VALUES (${id}::uuid, ${input.day}::date, ${input.engine}, ${input.kind},
                  (SELECT u.id FROM users u WHERE u.id = ${input.userId ?? null}::uuid),
                  ${reserved}::numeric, 1, 'reserved',
                  now() + ${ttlMs}::double precision * interval '1 millisecond')`);
        if (input.authorization.type === 'suggest') {
          // The logical request's first admitted attempt consumes the day's suggestion opportunity
          // (spec 05 §7); retries of the same request find it already stamped.
          await tx.execute(sql`
            UPDATE users SET last_suggested_at = now()
             WHERE id = ${input.authorization.userId}::uuid
               AND (last_suggested_at IS NULL OR last_suggested_at <= now() - interval '24 hours')`);
        }
        if (production) await markBudgetCrossings(tx, input.day, fallbackBudget);
        return id;
      });
    },

    async authorizeInference(authorization) {
      return isInferenceAuthorized(db, authorization);
    },

    async settleReservation(id, call, usage, billing) {
      if (!isUuid(id)) throw new RangeError('reservation id must be a UUID');
      if (call.reservationId !== undefined && call.reservationId !== id) {
        throw new RangeError('call.reservationId differs from the settled reservation');
      }
      if (billing !== 'known' && billing !== 'uncertain') throw new RangeError('unknown billing');
      assertCallRow(call);
      assertUsage(usage);
      await db.transaction((tx) => settle(tx, id, call, usage, billing));
    },

    async releaseReservation(id) {
      if (!isUuid(id)) throw new RangeError('reservation id must be a UUID');
      // Only a reservation nothing was recorded against: once a call row exists, or housekeeping
      // turned it `uncertain`, the attempt may have been sent and stays charged.
      await db.execute(sql`
        DELETE FROM engine_reservations r
         WHERE r.id = ${id}::uuid AND r.status = 'reserved'
           AND NOT EXISTS (SELECT 1 FROM engine_calls c WHERE c.reservation_id = r.id)`);
    },

    async insertCall(row) {
      assertCallRow(row);
      if (row.costUsd !== 0) throw new RangeError('insertCall records zero-cost calls only');
      if (row.reservationId !== undefined) {
        throw new RangeError('a reserved attempt is recorded by settleReservation');
      }
      await db.transaction(async (tx) => {
        const inserted = await tx.execute(insertCallSql(row, null, costUsd(0)));
        // Idempotent: a replay of the same (logical request, engine, attempt) adds no usage.
        if (inserted.rows.length === 0) return;
        await upsertUsageRow(tx, {
          day: utcDay(row.createdAt),
          userId: row.userId ?? PLATFORM_USER_ID,
          engine: row.engine,
          kind: row.kind,
          calls: 1,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: 0,
        });
      });
    },

    async upsertUsage(row) {
      assertUsage(row);
      await upsertUsageRow(db, row);
    },

    async spendSince(fromUtc, opts) {
      const result = await db.execute<{ usd: string }>(sql`
        SELECT coalesce(sum(CASE WHEN r.status = 'settled' THEN r.actual_usd ELSE r.reserved_usd END), 0)::text AS usd
          FROM engine_reservations r
         WHERE r.created_at >= ${fromUtc.toISOString()}::timestamptz
           AND NOT (r.kind = ANY(${sql.param(excluded(opts.excludeKinds))}::text[]))`);
      return Number(result.rows[0]?.usd ?? '0');
    },

    async getBudgetSnapshot(dayUtc, opts): Promise<BudgetSnapshot> {
      assertDay(dayUtc);
      const exclude = excluded(opts.excludeKinds);
      const reservations = await db.execute<{
        status: ReservationRow['status'];
        engine: string;
        kind: string;
        settled: string;
        reserved: string;
        calls: number;
      }>(sql`
        SELECT r.status, r.engine, r.kind,
               coalesce(sum(r.actual_usd), 0)::text AS settled,
               coalesce(sum(r.reserved_usd), 0)::text AS reserved,
               coalesce(sum(r.reserved_calls), 0)::int AS calls
          FROM engine_reservations r
         WHERE r.day = ${dayUtc}::date AND NOT (r.kind = ANY(${sql.param(exclude)}::text[]))
         GROUP BY r.status, r.engine, r.kind`);
      // Zero-cost attempts without a reservation (e.g. LibreTranslate) are counted from the audit.
      const unreserved = await db.execute<{ engine: string; kind: string; calls: number }>(sql`
        SELECT c.engine, c.kind, count(*)::int AS calls
          FROM engine_calls c
         WHERE c.reservation_id IS NULL
           AND c.created_at >= ${utcMidnight(dayUtc)}
           AND c.created_at < ${utcMidnight(dayUtc)} + interval '1 day'
           AND NOT (c.kind = ANY(${sql.param(exclude)}::text[]))
         GROUP BY c.engine, c.kind`);
      const snapshot: BudgetSnapshot = {
        settledUsd: 0,
        reservedUsd: 0,
        uncertainUsd: 0,
        callsByEngineKind: {},
      };
      const count = (engine: string, kind: string, n: number) => {
        const key = `${engine}:${kind}`;
        snapshot.callsByEngineKind[key] = (snapshot.callsByEngineKind[key] ?? 0) + n;
      };
      for (const row of reservations.rows) {
        if (row.status === 'settled') snapshot.settledUsd += Number(row.settled);
        else if (row.status === 'reserved') snapshot.reservedUsd += Number(row.reserved);
        else snapshot.uncertainUsd += Number(row.reserved);
        count(row.engine, row.kind, row.calls);
      }
      for (const row of unreserved.rows) count(row.engine, row.kind, row.calls);
      return snapshot;
    },

    async getSetting<T>(key: string): Promise<T | undefined> {
      return (await readStoredSetting(db, key)) as T | undefined;
    },

    async setSetting<T>(key: string, value: T): Promise<void> {
      const parsed = settingSchema(key).parse(value);
      await db.execute(sql`
        INSERT INTO settings AS s (key, value, updated_at) VALUES (${key}, ${JSON.stringify(parsed)}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = NULL`);
    },

    async readCircuit() {
      const stored = await readStoredSetting(db, 'engine.circuit');
      return EngineCircuitSchema.parse(stored ?? circuitDefault());
    },

    async updateCircuit(engine, update, updateOptions) {
      if (engine !== 'typesafe' && engine !== 'llm') throw new RangeError('unknown breaker engine');
      return db.transaction(async (tx) => {
        const guard = updateOptions?.credential;
        if (guard !== undefined) {
          // Lock order as in credential activation: the credential row, then the settings row.
          const row = await tx.execute<{ active_version: string | null; enabled: boolean }>(sql`
            SELECT active_version::text AS active_version, enabled
              FROM provider_credentials WHERE provider = ${guard.provider} FOR SHARE`);
          const credential = row.rows[0];
          const current =
            guard.version === null
              ? credential === undefined
              : credential !== undefined &&
                credential.enabled &&
                credential.active_version === guard.version;
          if (!current) {
            const stored = await readStoredSetting(tx, 'engine.circuit');
            return {
              circuit: EngineCircuitSchema.parse(stored ?? circuitDefault()),
              changed: false,
            };
          }
        }
        await tx.execute(sql`
          INSERT INTO settings (key, value) VALUES ('engine.circuit', ${JSON.stringify(circuitDefault())}::jsonb)
          ON CONFLICT (key) DO NOTHING`);
        const locked = await tx.execute<{ value: unknown }>(
          sql`SELECT value FROM settings WHERE key = 'engine.circuit' FOR UPDATE`,
        );
        const current = EngineCircuitSchema.parse(locked.rows[0]?.value ?? circuitDefault());
        const next = update(structuredClone(current));
        if (next === null) return { circuit: current, changed: false };
        const circuit = EngineCircuitSchema.parse({ ...current, [engine]: next });
        await tx.execute(sql`
          UPDATE settings
             SET value = jsonb_set(value, ARRAY[${engine}]::text[], ${JSON.stringify(circuit[engine])}::jsonb),
                 updated_at = now(), updated_by = NULL
           WHERE key = 'engine.circuit'`);
        return { circuit, changed: true };
      });
    },
  };
}

function circuitDefault(): EngineCircuit {
  return EngineCircuitSchema.parse(
    settingDefault('engine.circuit', {
      dailyBudgetUsd: 0,
      languageModes: {},
      signupMode: 'invite',
    }),
  );
}
