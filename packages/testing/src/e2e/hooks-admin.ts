import { HookParamsError, record, runner, type Hook, type NamedHook } from './hooks-kit.js';

/**
 * SQL hooks of the admin scenarios of spec 09 §9 (credentials, cards and labels). Each one moves a
 * clock the scenario cannot wait for, writes a state that only an older or a later product would
 * reach, or reads what no HTTP endpoint shows (the audit basis of a publication, feedback events).
 */

/** A bigint key as the API prints it: digits only, no leading zero, below 2^63. */
function databaseId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/.test(value)) {
    throw new HookParamsError(`${name} must be a database id (digits, no leading zero)`);
  }
  return value;
}

function emailAddress(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new HookParamsError(`${name} must be an email address of at most 254 characters`);
  }
  return value;
}

/** Ten years: far beyond any policy window, far below what `make_interval` can hold. */
const MAX_DAYS = 3650;
const MAX_HOURS = MAX_DAYS * 24;

function wholeNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HookParamsError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

const PROVIDERS = ['typesafe', 'ollama'] as const;
type Provider = (typeof PROVIDERS)[number];

function provider(value: unknown, name: string): Provider {
  const found = PROVIDERS.find((candidate) => candidate === value);
  if (found === undefined)
    throw new HookParamsError(`${name} must be one of ${PROVIDERS.join(', ')}`);
  return found;
}

/** The longest public title of a library card (spec 08 §9). */
const MAX_TITLE_LENGTH = 60;

function proposalTitle(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new HookParamsError(`${name} must be a trimmed, non-empty title`);
  }
  if ([...value].length > MAX_TITLE_LENGTH) {
    throw new HookParamsError(`${name} must have at most ${MAX_TITLE_LENGTH} characters`);
  }
  return value;
}

/**
 * Makes an account's last activity `daysAgo` days old, as 30 days without a visit would leave it
 * (spec 05 §8.1): the only measure of the original creator's inactivity. Any later sign-in of the
 * account sets it to now again, which is how a scenario brings a creator back.
 */
const setLastActive: Hook<{ email: string; daysAgo: number }> = {
  parse(params) {
    const fields = record(params, ['email', 'daysAgo']);
    return {
      email: emailAddress(fields['email'], 'email'),
      daysAgo: wholeNumber(fields['daysAgo'], 'daysAgo', 0, MAX_DAYS),
    };
  },
  async run(db, { email, daysAgo }) {
    const { rows } = await db.query(
      `UPDATE users
          SET last_active_at = clock_timestamp() - make_interval(days => $2::int)
        WHERE email = $1 AND deleted_at IS NULL
       RETURNING id`,
      [email, daysAgo],
    );
    return { updated: rows.length };
  },
};

/**
 * Inserts the pending publication request an administrator made `daysOld` days ago for a shared
 * card, addressed to its original creator. The API cannot make one: the database sets
 * `requested_at` and the guard trigger keeps it. The listing it proposes is the card's own title
 * under a generated slug. A card that already has an open request, is not a shared interest card
 * or has no known creator gets none.
 */
const createOldPublicationRequest: Hook<{ cardId: string; daysOld: number }> = {
  parse(params) {
    const fields = record(params, ['cardId', 'daysOld']);
    return {
      cardId: databaseId(fields['cardId'], 'cardId'),
      daysOld: wholeNumber(fields['daysOld'], 'daysOld', 1, MAX_DAYS),
    };
  },
  async run(db, { cardId, daysOld }) {
    const { rows } = await db.query(
      `INSERT INTO card_publication_requests
              (user_id, card_id, requested_by, card_text_hash, publication_payload, publication_sha,
               requested_at)
       SELECT c.creator_user_id, c.id,
              (SELECT a.id FROM users a
                WHERE a.role = 'admin' AND a.deleted_at IS NULL
                ORDER BY a.created_at, a.id LIMIT 1),
              c.text_hash, p.payload, encode(sha256(convert_to(p.payload::text, 'UTF8')), 'hex'),
              now() - make_interval(days => $2::int)
         FROM interest_cards c
        CROSS JOIN LATERAL (
              SELECT jsonb_build_object('slug', 'old-request-' || c.id::text, 'title', c.title,
                                        'topic_ids', '[]'::jsonb) AS payload) p
        WHERE c.id = $1::bigint AND c.visibility = 'shared' AND c.kind = 'interest'
          AND c.creator_user_id IS NOT NULL
       RETURNING id::text AS "requestId", version::text AS "version"`,
      [cardId, daysOld],
    );
    return rows[0] ?? null;
  },
};

/**
 * Changes the public title of an open publication request after the creator may have answered it,
 * the way the database accepts a changed proposal (spec 02 §3.6): a new version that awaits a fresh
 * response, so the earlier approval no longer counts. No endpoint edits a proposal.
 */
const reviseProposalTitle: Hook<{ requestId: string; title: string }> = {
  parse(params) {
    const fields = record(params, ['requestId', 'title']);
    return {
      requestId: databaseId(fields['requestId'], 'requestId'),
      title: proposalTitle(fields['title'], 'title'),
    };
  },
  async run(db, { requestId, title }) {
    const { rows } = await db.query(
      `WITH open AS (
         SELECT r.id, jsonb_set(r.publication_payload, '{title}', to_jsonb($2::text)) AS payload
           FROM card_publication_requests r
          WHERE r.id = $1::bigint AND r.status IN ('pending', 'approved')
       )
       UPDATE card_publication_requests r
          SET publication_payload = o.payload,
              publication_sha = encode(sha256(convert_to(o.payload::text, 'UTF8')), 'hex'),
              status = 'pending', responded_at = NULL, version = r.version + 1
         FROM open o
        WHERE r.id = o.id
       RETURNING r.version::text AS "version"`,
      [requestId, title],
    );
    return rows[0] ?? null;
  },
};

/**
 * Makes the validation of a provider's staged key `hours` hours old, as a day's wait would leave it:
 * a validation is good for 24 hours (spec 04 §1.2), and no endpoint moves its time. Only a candidate
 * that is valid has one.
 */
const ageCredentialValidation: Hook<{ provider: Provider; hours: number }> = {
  parse(params) {
    const fields = record(params, ['provider', 'hours']);
    return {
      provider: provider(fields['provider'], 'provider'),
      hours: wholeNumber(fields['hours'], 'hours', 1, MAX_HOURS),
    };
  },
  async run(db, { provider: name, hours }) {
    const { rows } = await db.query(
      `UPDATE provider_credentials
          SET validated_at = clock_timestamp() - make_interval(hours => $2::int)
        WHERE provider = $1 AND candidate_status = 'valid' AND validated_at IS NOT NULL
       RETURNING provider`,
      [name, hours],
    );
    return { updated: rows.length };
  },
};

export interface PublicationAudit {
  status: string;
  version: string;
  /** Null unless the creator answered; an inactivity promotion leaves it null. */
  respondedAt: string | null;
  promotedAt: string | null;
  authorizationKind: 'creator_approval' | 'creator_inactive_30d' | null;
  /** The recorded evidence of the basis; null until the promotion. */
  authorizationEvidence: Record<string, unknown> | null;
  cardVisibility: string;
  /** The card carries the creator's decline. */
  vetoed: boolean;
}

/** One publication request as the database records it: the audit basis and the card's visibility. */
const publicationAudit: Hook<{ requestId: string }> = {
  parse: (params) => ({
    requestId: databaseId(record(params, ['requestId'])['requestId'], 'requestId'),
  }),
  async run(db, { requestId }) {
    const { rows } = await db.query(
      `SELECT r.status AS "status", r.version::text AS "version",
              to_char(r.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS "respondedAt",
              to_char(r.promoted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                AS "promotedAt",
              r.authorization_kind AS "authorizationKind",
              r.authorization_evidence AS "authorizationEvidence",
              c.visibility AS "cardVisibility",
              c.publication_veto_at IS NOT NULL AS "vetoed"
         FROM card_publication_requests r
         JOIN interest_cards c ON c.id = r.card_id
        WHERE r.id = $1::bigint`,
      [requestId],
    );
    return (rows[0] as PublicationAudit | undefined) ?? null;
  },
};

export interface FeedbackEventRow {
  id: string;
  kind: string;
  articleId: string;
}

/** The feedback events one account has written, oldest first (spec 02: the kinds of `feedback_events`). */
const feedbackEvents: Hook<{ email: string }> = {
  parse: (params) => ({ email: emailAddress(record(params, ['email'])['email'], 'email') }),
  async run(db, { email }) {
    const { rows } = await db.query(
      `SELECT e.id::text AS "id", e.kind AS "kind", e.article_id::text AS "articleId"
         FROM feedback_events e
         JOIN users u ON u.id = e.user_id
        WHERE u.email = $1
        ORDER BY e.id`,
      [email],
    );
    return rows as FeedbackEventRow[];
  },
};

export const ADMIN_HOOKS: readonly NamedHook[] = [
  ['setLastActive', runner(setLastActive)],
  ['createOldPublicationRequest', runner(createOldPublicationRequest)],
  ['reviseProposalTitle', runner(reviseProposalTitle)],
  ['ageCredentialValidation', runner(ageCredentialValidation)],
  ['publicationAudit', runner(publicationAudit)],
  ['feedbackEvents', runner(feedbackEvents)],
];
