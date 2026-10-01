import { CardTextModeSchema, type CallStatus } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { parseCardBody } from '../cards/body.js';
import type { CardKind } from '../cards/types.js';
import type { Executor } from '../client.js';
import { readStoredSetting } from '../settings.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * The read side of the card library, suggestions, publication requests and topics (spec 08 §7), and
 * the API's narrow accounting of its card-text translation calls (spec 02 §6, spec 07 §5). The card
 * and label lifecycle itself lives in `../cards`. Everything here runs in the caller's tenant
 * transaction: public library rows are readable by every tenant, while suggestions and publication
 * requests are the tenant's own rows under RLS.
 */

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// ── Card text mode and translation accounting ─────────────────────────────────────────────────────

/** `settings.card_text_mode` (spec 07 §5); an unset or unreadable value is `as_written`. */
export async function readCardTextMode(db: Executor): Promise<'as_written' | 'english'> {
  const parsed = CardTextModeSchema.safeParse(await readStoredSetting(db, 'card_text_mode'));
  return parsed.success ? parsed.data : 'as_written';
}

/** One HTTP attempt of a card-text translation, as `record_card_translation` accepts it. */
export interface CardTranslationAttemptRecord {
  /** 1-based attempt ordinal. */
  attempt: number;
  status: CallStatus;
  latencyMs: number;
  /** The translator's log-safe failure code (e.g. `http_503`, `network:ECONNRESET`). */
  error?: string | undefined;
}

/** The bounded error-code allowlist of `record_card_translation` (spec 02 §6). */
export type CardTranslationErrorCode =
  | 'timeout'
  | 'network'
  | 'http_4xx'
  | 'http_5xx'
  | 'rate_limited'
  | 'invalid_response'
  | 'unsupported_language'
  | 'text_too_long'
  | 'unavailable';

/** Map a translator failure code onto the allowlist; raw text never reaches the audit row. */
export function cardTranslationErrorCode(
  status: CallStatus,
  error: string | undefined,
): CardTranslationErrorCode | null {
  if (status === 'ok') return null;
  if (status === 'timeout') return 'timeout';
  if (status === 'rate_limited') return 'rate_limited';
  const code = error ?? '';
  if (code.startsWith('timeout')) return 'timeout';
  if (code.startsWith('network')) return 'network';
  if (code === 'http_429') return 'rate_limited';
  if (/^http_4\d\d$/.test(code)) return 'http_4xx';
  if (/^http_5\d\d$/.test(code)) return 'http_5xx';
  if (code.startsWith('invalid_response') || status === 'invalid_response') {
    return 'invalid_response';
  }
  if (code === 'unsupported_language' || code === 'text_too_long') return code;
  return 'unavailable';
}

/**
 * Record each HTTP attempt of one logical card-text translation through `record_card_translation`
 * (spec 02 §6: zero-cost `libretranslate`/`translate` rows attributed to the tenant, at most once
 * per attempt, metadata only). Run it in its own transaction, so a failed attempt stays recorded
 * even when the card mutation that follows rolls back.
 */
export async function recordCardTranslationAttempts(
  tx: TenantTx,
  logicalRequestId: string,
  attempts: readonly CardTranslationAttemptRecord[],
): Promise<void> {
  for (const attempt of attempts) {
    const latency = Math.min(600_000, Math.max(0, Math.round(attempt.latencyMs)));
    await tx.execute(sql`
      SELECT record_card_translation(${logicalRequestId}::uuid, ${attempt.attempt}::int,
                                     ${latency}::int, ${attempt.status}::text,
                                     ${cardTranslationErrorCode(attempt.status, attempt.error)}::text)`);
  }
}

// ── Library ───────────────────────────────────────────────────────────────────────────────────────

/** A public library card as the repository reads it (localization happens in the API). */
export interface LibraryCardRow {
  id: string;
  slug: string | null;
  title: string;
  interest: string;
  notFor: string | null;
  examplesYes: string[];
  examplesNo: string[];
  topicIds: string[];
  lang: string;
  i18n: Record<string, unknown>;
  /** The level-1 topic of the first topic id; `null` without a known topic. */
  l1TopicId: string | null;
  /** The card's `library_card_versions.version`, `null` when it has none. */
  version: number | null;
  held: boolean;
}

/** Keyset of the library order: level-1 topic sort, level-1 topic id, card id. */
export type LibraryCursorKey = [number, string, string];

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type LibrarySqlRow = {
  id: string;
  slug: string | null;
  title: string;
  body: unknown;
  topic_ids: string[];
  lang: string;
  i18n: unknown;
  l1_id: string | null;
  l1_sort: number;
  l1_key: string;
  version: number | null;
  held: boolean;
};

/** Cards without a known topic sort after every topic. */
const NO_TOPIC_SORT = 2147483647;
const NO_TOPIC_KEY = '~';

function libraryColumns(userId: string): SQL {
  return sql`c.id::text AS id, c.slug, c.title, c.body, c.topic_ids, c.lang, c.i18n,
    g.l1_id, coalesce(g.l1_sort, ${NO_TOPIC_SORT})::int AS l1_sort,
    coalesce(g.l1_id, ${NO_TOPIC_KEY}) AS l1_key,
    (SELECT v.version FROM library_card_versions v WHERE v.card_id = c.id) AS version,
    EXISTS (SELECT 1 FROM user_cards uc
             WHERE uc.user_id = ${userId}::uuid AND uc.card_id = c.id) AS held`;
}

/** The level-1 topic of a card's first topic (`g.l1_id`, `g.l1_sort`). */
const L1_JOIN = sql`LEFT JOIN LATERAL (
    SELECT coalesce(p.id, t.id) AS l1_id, coalesce(p.sort, t.sort) AS l1_sort
      FROM topics t LEFT JOIN topics p ON p.id = t.parent_id
     WHERE t.id = c.topic_ids[1]) g ON true`;

function libraryCardRow(row: LibrarySqlRow): LibraryCardRow {
  const body = parseCardBody(row.body);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    interest: body.interest,
    notFor: body.notFor,
    examplesYes: body.examplesYes,
    examplesNo: body.examplesNo,
    topicIds: row.topic_ids,
    lang: row.lang,
    i18n: asRecord(row.i18n),
    l1TopicId: row.l1_id,
    version: row.version,
    held: row.held,
  };
}

/** `LIKE` pattern matching `text` literally anywhere. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface LibraryListInput {
  /** A level-1 or level-2 topic id: cards tagged with it, or with a child of it. */
  topic?: string | undefined;
  /** Case-insensitive substring of the title, interest, `not_for` or the localized title/interest. */
  q?: string | undefined;
  /** The locale whose `i18n` text `q` also searches. */
  locale: string;
  after: LibraryCursorKey | null;
  limit: number;
}

/**
 * `GET /library` (spec 08 §7): current public interest cards (not retired, and not an older version
 * of a library entry: older versions stay readable for their holders through updates only), ordered
 * by level-1 topic and card id, `limit + 1` rows so the caller can tell whether a page follows.
 */
export async function listLibraryCards(
  tx: TenantTx,
  input: LibraryListInput,
): Promise<{ rows: LibraryCardRow[]; keys: LibraryCursorKey[] }> {
  const filters: SQL[] = [];
  if (input.topic !== undefined) {
    filters.push(sql`AND (${input.topic} = ANY (c.topic_ids)
      OR EXISTS (SELECT 1 FROM topics t WHERE t.id = ANY (c.topic_ids) AND t.parent_id = ${input.topic}))`);
  }
  if (input.q !== undefined) {
    const pattern = containsPattern(input.q);
    filters.push(sql`AND (c.title ILIKE ${pattern} ESCAPE '\\'
      OR c.body->>'interest' ILIKE ${pattern} ESCAPE '\\'
      OR coalesce(c.body->>'not_for', '') ILIKE ${pattern} ESCAPE '\\'
      OR coalesce(c.i18n->${input.locale}->>'title', '') ILIKE ${pattern} ESCAPE '\\'
      OR coalesce(c.i18n->${input.locale}->>'interest', '') ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (input.after !== null) {
    const [sort, l1, id] = input.after;
    filters.push(sql`AND (coalesce(g.l1_sort, ${NO_TOPIC_SORT}), coalesce(g.l1_id, ${NO_TOPIC_KEY}), c.id)
      > (${sort}::int, ${l1}::text, ${id}::bigint)`);
  }
  const result = await tx.execute<LibrarySqlRow>(sql`
    SELECT ${libraryColumns(tenantUserId(tx))}
      FROM interest_cards c ${L1_JOIN}
     WHERE c.kind = 'interest' AND c.visibility = 'public' AND c.retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM library_card_versions o
                         JOIN library_card_versions n
                           ON n.library_slug = o.library_slug AND n.version > o.version
                        WHERE o.card_id = c.id)
       ${sql.join(filters, sql` `)}
     ORDER BY coalesce(g.l1_sort, ${NO_TOPIC_SORT}), coalesce(g.l1_id, ${NO_TOPIC_KEY}), c.id
     LIMIT ${input.limit + 1}`);
  return {
    rows: result.rows.map(libraryCardRow),
    keys: result.rows.map((row) => [row.l1_sort, row.l1_key, row.id]),
  };
}

// ── Suggestions ───────────────────────────────────────────────────────────────────────────────────

export interface CardSuggestionRow {
  card: LibraryCardRow;
  score: number;
}

/**
 * `GET /cards/suggestions` (spec 08 §7, spec 05 §7): the tenant's undismissed suggestions produced by
 * the active `suggest` set under the current Jev model pin (suggestion calls are bulk and never use
 * the LLM fallback, so the pin identifies them), of readable non-retired interest cards the user
 * holds neither directly, as a label, nor through a private fork of it. Best score first.
 */
export async function listCardSuggestions(tx: TenantTx): Promise<CardSuggestionRow[]> {
  const userId = tenantUserId(tx);
  const result = await tx.execute<LibrarySqlRow & { score: number }>(sql`
    SELECT ${libraryColumns(userId)}, s.score
      FROM card_suggestions s
      JOIN interest_cards c ON c.id = s.card_id AND c.kind = 'interest' AND c.retired_at IS NULL
      ${L1_JOIN}
     WHERE s.user_id = ${userId}::uuid AND s.dismissed_at IS NULL
       AND s.question_set_id::text = (SELECT value->>'suggest' FROM settings
                                       WHERE key = 'question_sets.active')
       AND s.model_pin = (SELECT value->>'model' FROM settings WHERE key = 'engine.model_pin')
       AND NOT EXISTS (SELECT 1 FROM user_cards uc JOIN interest_cards h ON h.id = uc.card_id
                        WHERE uc.user_id = ${userId}::uuid
                          AND (uc.card_id = s.card_id OR h.parent_card_id = s.card_id))
       AND NOT EXISTS (SELECT 1 FROM user_labels ul
                        WHERE ul.user_id = ${userId}::uuid AND ul.card_id = s.card_id)
     ORDER BY s.score DESC, s.card_id`);
  return result.rows.map((row) => ({ card: libraryCardRow(row), score: row.score }));
}

/**
 * `POST /cards/suggestions/:cardId/dismiss`: stamp `dismissed_at` (kept when already dismissed).
 * `false` when the tenant has no suggestion of that card.
 */
export async function dismissCardSuggestion(tx: TenantTx, cardId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE card_suggestions SET dismissed_at = coalesce(dismissed_at, now())
     WHERE user_id = ${tenantUserId(tx)}::uuid AND card_id = ${cardId}::bigint`);
  return (result.rowCount ?? 0) > 0;
}

// ── Publication requests ──────────────────────────────────────────────────────────────────────────

export interface PublicationRequestRow {
  id: string;
  cardId: string;
  kind: CardKind;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'promoted';
  version: string;
  card: {
    title: string;
    interest: string;
    notFor: string | null;
    examplesYes: string[];
    examplesNo: string[];
    textHash: string;
  };
  proposed: {
    slug: string | null;
    title: string | null;
    topicIds: string[];
    i18n: Record<string, Record<string, string>>;
  };
  publicationSha: string;
  requestedAt: Date;
  expiresAt: Date | null;
  respondedAt: Date | null;
}

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type PublicationSqlRow = {
  id: string;
  card_id: string;
  kind: CardKind;
  status: PublicationRequestRow['status'];
  version: string;
  title: string;
  body: unknown;
  card_text_hash: string;
  publication_payload: unknown;
  publication_sha: string;
  requested_at: RawTimestamp;
  expires_at: RawTimestamp | null;
  responded_at: RawTimestamp | null;
};

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The proposal's display fields; anything outside the admin-validated payload shape is dropped. */
function proposal(payload: unknown): PublicationRequestRow['proposed'] {
  const raw = asRecord(payload);
  const topicIds = Array.isArray(raw['topic_ids'])
    ? raw['topic_ids'].filter((id): id is string => typeof id === 'string')
    : [];
  const i18n: Record<string, Record<string, string>> = {};
  for (const [locale, entry] of Object.entries(asRecord(raw['i18n']))) {
    const fields = Object.entries(asRecord(entry)).filter(
      (field): field is [string, string] => typeof field[1] === 'string',
    );
    i18n[locale] = Object.fromEntries(fields);
  }
  return {
    slug: stringOrNull(raw['slug']),
    title: stringOrNull(raw['title']),
    topicIds,
    i18n,
  };
}

function publicationRow(row: PublicationSqlRow): PublicationRequestRow {
  const body = parseCardBody(row.body);
  return {
    id: row.id,
    cardId: row.card_id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    card: {
      title: row.title,
      interest: body.interest,
      notFor: body.notFor,
      examplesYes: body.examplesYes,
      examplesNo: body.examplesNo,
      textHash: row.card_text_hash,
    },
    proposed: proposal(row.publication_payload),
    publicationSha: row.publication_sha,
    requestedAt: toDate(row.requested_at),
    expiresAt: toDateOrNull(row.expires_at),
    respondedAt: toDateOrNull(row.responded_at),
  };
}

/** Requests are bounded per creator by the one-open-request-per-card index; cap the list anyway. */
const PUBLICATION_LIST_LIMIT = 100;

async function selectPublicationRequests(
  tx: TenantTx,
  filter: SQL,
): Promise<PublicationRequestRow[]> {
  const result = await tx.execute<PublicationSqlRow>(sql`
    SELECT r.id::text AS id, r.card_id::text AS card_id, c.kind, r.status, r.version::text AS version,
           c.title, c.body, r.card_text_hash, r.publication_payload, r.publication_sha,
           r.requested_at, r.expires_at, r.responded_at
      FROM card_publication_requests r
      JOIN interest_cards c ON c.id = r.card_id AND c.visibility <> 'private'
     WHERE r.user_id = ${tenantUserId(tx)}::uuid ${filter}
     ORDER BY r.requested_at DESC, r.id DESC
     LIMIT ${PUBLICATION_LIST_LIMIT}`);
  return result.rows.map(publicationRow);
}

/**
 * `GET /cards/publication-requests` (spec 08 §7): the requests addressed to the tenant as the
 * original creator, newest first, with the exact card text and proposed payload.
 */
export function listPublicationRequests(tx: TenantTx): Promise<PublicationRequestRow[]> {
  return selectPublicationRequests(tx, sql``);
}

/**
 * `POST /cards/publication-requests/:id/respond` (spec 08 §7, §9.2): the creator's genuine response
 * through `respond_card_publication` (creator-only, CAS on `expectedVersion`; another user's or a
 * missing request is `BZ404`, a stale version or an unanswerable state `BZ409`). Returns the
 * request as committed.
 */
export async function respondToPublicationRequest(
  tx: TenantTx,
  input: { requestId: string; expectedVersion: string; approve: boolean },
): Promise<PublicationRequestRow> {
  await tx.execute(sql`
    SELECT * FROM respond_card_publication(${input.requestId}::bigint,
                                           ${input.expectedVersion}::bigint, ${input.approve})`);
  const [row] = await selectPublicationRequests(tx, sql`AND r.id = ${input.requestId}::bigint`);
  if (row === undefined) throw new Error('answered publication request is not readable');
  return row;
}

// ── Topics ────────────────────────────────────────────────────────────────────────────────────────

export interface TopicRow {
  id: string;
  parent: string | null;
  level: 1 | 2;
  nameEn: string;
  nameSk: string;
  description: string;
}

/** `GET /topics`: the taxonomy, each level-1 topic followed by its children, in seeded order. */
export async function listTopics(db: Executor): Promise<TopicRow[]> {
  const result = await db.execute<{
    id: string;
    parent_id: string | null;
    level: number;
    name_en: string;
    name_sk: string;
    description: string;
  }>(sql`
    SELECT t.id, t.parent_id, t.level, t.name_en, t.name_sk, t.description
      FROM topics t LEFT JOIN topics p ON p.id = t.parent_id
     ORDER BY coalesce(p.sort, t.sort), coalesce(p.id, t.id), t.level, t.sort, t.id`);
  return result.rows.map((row) => ({
    id: row.id,
    parent: row.parent_id,
    level: row.level === 1 ? 1 : 2,
    nameEn: row.name_en,
    nameSk: row.name_sk,
    description: row.description,
  }));
}
