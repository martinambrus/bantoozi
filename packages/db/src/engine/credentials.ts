import {
  AppError,
  CandidateValidationSchema,
  enqueueProviderValidate,
  isBigIntString,
  isUuid,
  type CandidateStatus,
  type CandidateValidation,
  type Provider,
} from '@bantoozi/shared';
import { CredentialEnvelopeSchema } from '@bantoozi/shared/server/credential-crypto';
import { sql } from 'drizzle-orm';

import type { Database, Executor } from '../client.js';
import { workerOutbox } from '../outbox.js';

/**
 * The worker-role provider credential repository (spec 02 §2.1, §6; spec 04 §1.2). The table holds
 * encrypted envelopes and metadata only; decryption happens in the worker's credential resolver.
 *
 * - **Resolver reads**: the active envelope with the row's `revision`/`enabled`/`active_version`,
 *   re-read before every wire attempt (never cached), and the candidate envelope only for the
 *   holder of a live validation lease.
 * - **Validation lease** (`provider.validate`): claim a lease for the exact candidate version (CAS),
 *   then complete it with the same token, recording `valid`/`invalid` (or `pending` for an
 *   inconclusive run) with sanitized capability metadata. A revoked or re-staged candidate makes
 *   the completion a no-op, so a stale probe can never validate a newer candidate. A validator
 *   that stopped without a result leaves the candidate `validating` until its lease expires; the
 *   queue does not retry the job, so Validate may then be requested again (D-87).
 * - **Admin state machine** for the credentials CLI. The M0 admin SQL functions are granted to the
 *   API role only (spec 02 §6) and the CLI runs as `bantoozi_worker` (whose login
 *   `admin_context_allowed()` treats as operational), so these statements mirror
 *   `admin_stage_provider_credential`, `admin_validate_provider_credential`,
 *   `admin_activate_provider_credential` and `admin_set_provider_enabled` on the worker's table
 *   grants: the same row lock, optimistic `revision` CAS and state rules. Activation additionally
 *   requires the candidate's recorded configuration fingerprint to equal the current one.
 *
 * Nothing here returns an envelope except the two resolver reads; metadata never includes one.
 */

export type CredentialProviderName = Provider;

export interface CredentialMetadataRecord {
  provider: CredentialProviderName;
  revision: string;
  enabled: boolean;
  activeVersion: string | null;
  candidateVersion: string | null;
  candidateStatus: CandidateStatus | null;
  candidateValidation: CandidateValidation;
  updatedAt: Date | null;
  activatedAt: Date | null;
  validatedAt: Date | null;
  lastErrorCode: string | null;
  /**
   * A `validating` candidate whose lease expired: its validator stopped without recording a result,
   * and Validate may be requested again (D-87).
   */
  validationLeaseExpired: boolean;
}

type MetadataRow = {
  provider: CredentialProviderName;
  revision: string;
  enabled: boolean;
  active_version: string | null;
  candidate_version: string | null;
  candidate_status: CandidateStatus | null;
  candidate_validation: unknown;
  updated_at: Date | string | null;
  activated_at: Date | string | null;
  validated_at: Date | string | null;
  last_error_code: string | null;
  validation_lease_expired: boolean;
};

const date = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value);

function toMetadata(row: MetadataRow): CredentialMetadataRecord {
  const validation = CandidateValidationSchema.safeParse(row.candidate_validation ?? {});
  return {
    provider: row.provider,
    revision: row.revision,
    enabled: row.enabled,
    activeVersion: row.active_version,
    candidateVersion: row.candidate_version,
    candidateStatus: row.candidate_status,
    candidateValidation: validation.success ? validation.data : {},
    updatedAt: date(row.updated_at),
    activatedAt: date(row.activated_at),
    validatedAt: date(row.validated_at),
    lastErrorCode: row.last_error_code,
    validationLeaseExpired: row.validation_lease_expired,
  };
}

/**
 * Whether Validate may be requested for a candidate (spec 04 §1.2 step 2): a settled one (`pending`,
 * `valid`, `invalid`), or one still `validating` after its lease expired (D-87). The new probe
 * reclaims that lease; a live lease means a validator is still at work.
 */
export function validationRequestable(candidate: {
  candidateStatus: CandidateStatus | null;
  validationLeaseExpired: boolean;
}): boolean {
  const status = candidate.candidateStatus;
  return (
    status === 'pending' ||
    status === 'valid' ||
    status === 'invalid' ||
    (status === 'validating' && candidate.validationLeaseExpired)
  );
}

function assertProvider(provider: string): asserts provider is CredentialProviderName {
  if (provider !== 'typesafe' && provider !== 'ollama') {
    throw new AppError('VALIDATION_FAILED', 'Unknown provider');
  }
}

function assertVersion(name: string, value: string, { allowZero }: { allowZero: boolean }) {
  if (!isBigIntString(value) || BigInt(value) < (allowZero ? 0n : 1n)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${name} must be a decimal ${allowZero ? 'revision' : 'version'}`,
    );
  }
}

/** A `validating` candidate whose lease expired (the lease columns are set exactly then). */
const LEASE_EXPIRED = sql`
  coalesce(c.candidate_status = 'validating' AND c.validation_until <= now(), false)`;

const METADATA = sql`
  c.provider, c.revision::text AS revision, c.enabled, c.active_version::text AS active_version,
  c.candidate_version::text AS candidate_version, c.candidate_status, c.candidate_validation,
  c.updated_at, c.activated_at, c.validated_at, c.last_error_code,
  ${LEASE_EXPIRED} AS validation_lease_expired`;

/** Metadata of one provider's row, or null when no row exists (no envelope is read). */
export async function readCredentialMetadata(
  db: Executor,
  provider: CredentialProviderName,
): Promise<CredentialMetadataRecord | null> {
  assertProvider(provider);
  const result = await db.execute<MetadataRow>(
    sql`SELECT ${METADATA} FROM provider_credentials c WHERE c.provider = ${provider}`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toMetadata(row);
}

/** Metadata of every provider row, ordered by provider. */
export async function listCredentialMetadata(db: Executor): Promise<CredentialMetadataRecord[]> {
  const result = await db.execute<MetadataRow>(
    sql`SELECT ${METADATA} FROM provider_credentials c ORDER BY c.provider`,
  );
  return result.rows.map(toMetadata);
}

export type ActiveCredentialSecret =
  | { state: 'missing' }
  | {
      state: 'present';
      revision: string;
      enabled: boolean;
      activeVersion: string | null;
      /** A staged candidate's version (its envelope is not read), for the unavailable reason. */
      candidateVersion: string | null;
      /** The encrypted envelope (never plaintext); null while no version is active. */
      envelope: unknown;
    };

/** The active envelope and the fields admission rechecks, read fresh for one wire attempt. */
export async function readActiveCredentialSecret(
  db: Executor,
  provider: CredentialProviderName,
): Promise<ActiveCredentialSecret> {
  assertProvider(provider);
  const result = await db.execute<{
    revision: string;
    enabled: boolean;
    active_version: string | null;
    candidate_version: string | null;
    active_envelope: unknown;
  }>(sql`
    SELECT c.revision::text AS revision, c.enabled, c.active_version::text AS active_version,
           c.candidate_version::text AS candidate_version, c.active_envelope
      FROM provider_credentials c WHERE c.provider = ${provider}`);
  const row = result.rows[0];
  if (row === undefined) return { state: 'missing' };
  return {
    state: 'present',
    revision: row.revision,
    enabled: row.enabled,
    activeVersion: row.active_version,
    candidateVersion: row.candidate_version,
    envelope: row.active_envelope,
  };
}

/** The candidate envelope, only while `validationToken` holds the live validation lease. */
export async function readCandidateCredentialSecret(
  db: Executor,
  input: { provider: CredentialProviderName; candidateVersion: string; validationToken: string },
): Promise<{ envelope: unknown } | null> {
  assertProvider(input.provider);
  if (!isBigIntString(input.candidateVersion) || !isUuid(input.validationToken)) return null;
  const result = await db.execute<{ candidate_envelope: unknown }>(sql`
    SELECT c.candidate_envelope
      FROM provider_credentials c
     WHERE c.provider = ${input.provider}
       AND c.candidate_version = ${input.candidateVersion}::bigint
       AND c.candidate_status = 'validating'
       AND c.validation_token = ${input.validationToken}::uuid
       AND c.validation_until > now()`);
  const row = result.rows[0];
  return row === undefined ? null : { envelope: row.candidate_envelope };
}

/**
 * Claim the validation lease of exactly this candidate version (spec 04 §1.2 step 2): from
 * `pending`, `valid` or `invalid` (a requested re-validation), or from `validating` whose lease has
 * expired (a crashed validator). Null when the candidate was replaced, revoked or is being
 * validated under a live lease.
 */
export async function claimCredentialValidation(
  db: Executor,
  input: { provider: CredentialProviderName; candidateVersion: string; leaseMs: number },
): Promise<{ validationToken: string; revision: string } | null> {
  assertProvider(input.provider);
  assertVersion('candidateVersion', input.candidateVersion, { allowZero: false });
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000) {
    throw new RangeError('leaseMs must be at least one second');
  }
  const result = await db.execute<{ validation_token: string; revision: string }>(sql`
    UPDATE provider_credentials c
       SET candidate_status = 'validating', validation_token = gen_random_uuid(),
           validation_until = now() + ${input.leaseMs}::double precision * interval '1 millisecond'
     WHERE c.provider = ${input.provider}
       AND c.candidate_version = ${input.candidateVersion}::bigint
       AND (c.candidate_status IN ('pending', 'valid', 'invalid')
            OR (c.candidate_status = 'validating' AND c.validation_until <= now()))
    RETURNING c.validation_token::text AS validation_token, c.revision::text AS revision`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { validationToken: row.validation_token, revision: row.revision };
}

export interface ValidationResult {
  /** `pending`: inconclusive (budget, provider unavailable); the admin may request it again. */
  status: 'valid' | 'invalid' | 'pending';
  validation: CandidateValidation;
  /** Sanitized error code (`[a-z][a-z0-9_]{0,63}`); never provider text. */
  errorCode?: string;
}

/**
 * Complete a validation lease with its token. `valid`/`invalid` stamp `validated_at`; `pending`
 * leaves the candidate unvalidated with its error code. False when the lease is no longer this
 * token's (revoked, re-staged or reclaimed) or has expired, even before another worker reclaims
 * it: the result is discarded, like a candidate-secret read outside the lease.
 */
export async function completeCredentialValidation(
  db: Executor,
  input: {
    provider: CredentialProviderName;
    candidateVersion: string;
    validationToken: string;
    result: ValidationResult;
  },
): Promise<boolean> {
  assertProvider(input.provider);
  if (!isBigIntString(input.candidateVersion) || !isUuid(input.validationToken)) return false;
  const validation = CandidateValidationSchema.parse(input.result.validation);
  const errorCode = input.result.errorCode ?? null;
  if (errorCode !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)) {
    throw new RangeError('errorCode must be a sanitized code');
  }
  const decided = input.result.status !== 'pending';
  const result = await db.execute(sql`
    UPDATE provider_credentials c
       SET candidate_status = ${input.result.status},
           candidate_validation = ${JSON.stringify(validation)}::jsonb,
           validated_at = CASE WHEN ${decided} THEN now() ELSE NULL END,
           last_error_code = ${errorCode},
           validation_token = NULL, validation_until = NULL
     WHERE c.provider = ${input.provider}
       AND c.candidate_version = ${input.candidateVersion}::bigint
       AND c.candidate_status = 'validating'
       AND c.validation_token = ${input.validationToken}::uuid
       AND c.validation_until > now()`);
  return result.rowCount === 1;
}

// ── Admin state machine (credentials CLI, worker role) ──────────────────────────────────────────

type LockedRow = {
  revision: string;
  enabled: boolean;
  active_version: string | null;
  candidate_version: string | null;
  candidate_status: CandidateStatus | null;
  candidate_validation: unknown;
  validated_recently: boolean | null;
  validation_lease_expired: boolean;
};

async function lockRow(
  tx: Executor,
  provider: CredentialProviderName,
  { create }: { create: boolean },
): Promise<LockedRow | undefined> {
  if (create) {
    await tx.execute(sql`
      INSERT INTO provider_credentials (provider) VALUES (${provider}) ON CONFLICT (provider) DO NOTHING`);
  }
  const result = await tx.execute<LockedRow>(sql`
    SELECT c.revision::text AS revision, c.enabled, c.active_version::text AS active_version,
           c.candidate_version::text AS candidate_version, c.candidate_status, c.candidate_validation,
           (c.validated_at >= now() - interval '24 hours') AS validated_recently,
           ${LEASE_EXPIRED} AS validation_lease_expired
      FROM provider_credentials c WHERE c.provider = ${provider} FOR UPDATE`);
  return result.rows[0];
}

const stale = () => new AppError('CONFLICT', 'The credential changed; re-read its revision');

/**
 * Stage an already encrypted envelope as the candidate for the exact next revision (mirrors
 * `admin_stage_provider_credential`): no provider call, no validation; the active version stays.
 * The caller encrypts with `secretVersion = expectedRevision + 1`.
 */
export async function stageProviderCredential(
  db: Database,
  input: {
    provider: CredentialProviderName;
    expectedRevision: string;
    envelope: unknown;
    adminUserId?: string | null;
  },
): Promise<{ revision: string; candidateVersion: string }> {
  assertProvider(input.provider);
  assertVersion('expectedRevision', input.expectedRevision, { allowZero: true });
  const envelope = CredentialEnvelopeSchema.safeParse(input.envelope);
  if (!envelope.success) throw new AppError('VALIDATION_FAILED', 'Invalid credential envelope');
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, input.provider, { create: true });
    if (row === undefined || row.revision !== input.expectedRevision) throw stale();
    const result = await tx.execute<{ revision: string; candidate_version: string }>(sql`
      UPDATE provider_credentials c
         SET revision = c.revision + 1, candidate_version = c.revision + 1,
             candidate_envelope = ${JSON.stringify(envelope.data)}::jsonb,
             candidate_status = 'pending', candidate_validation = '{}', validation_token = NULL,
             validation_until = NULL, validated_at = NULL, last_error_code = NULL,
             updated_at = now(), updated_by = ${input.adminUserId ?? null}::uuid
       WHERE c.provider = ${input.provider}
      RETURNING c.revision::text AS revision, c.candidate_version::text AS candidate_version`);
    const updated = result.rows[0]!;
    return { revision: updated.revision, candidateVersion: updated.candidate_version };
  });
}

/**
 * Explicit Validate (mirrors `admin_validate_provider_credential`): queue
 * `provider.validate {provider, candidateVersion}` through the outbox, only for the current
 * candidate at the expected revision that is not being validated under a live lease
 * (`validationRequestable`). The payload carries no secret.
 */
export async function requestProviderValidation(
  db: Database,
  input: { provider: CredentialProviderName; candidateVersion: string; expectedRevision: string },
): Promise<void> {
  assertProvider(input.provider);
  assertVersion('candidateVersion', input.candidateVersion, { allowZero: false });
  assertVersion('expectedRevision', input.expectedRevision, { allowZero: true });
  await db.transaction(async (tx) => {
    const row = await lockRow(tx, input.provider, { create: false });
    if (row === undefined) throw new AppError('NOT_FOUND', 'No credential staged');
    if (
      row.revision !== input.expectedRevision ||
      row.candidate_version !== input.candidateVersion ||
      !validationRequestable({
        candidateStatus: row.candidate_status,
        validationLeaseExpired: row.validation_lease_expired,
      })
    ) {
      throw new AppError('CONFLICT', 'Stale or busy credential candidate');
    }
    await enqueueProviderValidate(workerOutbox(tx), {
      provider: input.provider,
      candidateVersion: input.candidateVersion,
    });
  });
}

/**
 * Activate the exact validated candidate (mirrors `admin_activate_provider_credential`): the
 * current revision, a `valid` result no older than 24 hours, and the same endpoint/model-policy
 * fingerprint the validation recorded. Swaps it into the active slot, clears the superseded
 * envelope and candidate state, enables the provider, and closes the provider's breaker when it
 * is in auth mode (the old credential's incident).
 */
export async function activateProviderCredential(
  db: Database,
  input: {
    provider: CredentialProviderName;
    expectedRevision: string;
    candidateVersion: string;
    /** The current configuration fingerprint (endpoint and pinned models). */
    configFingerprint: string;
    adminUserId?: string | null;
  },
): Promise<{ revision: string; activeVersion: string }> {
  assertProvider(input.provider);
  assertVersion('candidateVersion', input.candidateVersion, { allowZero: false });
  assertVersion('expectedRevision', input.expectedRevision, { allowZero: true });
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, input.provider, { create: false });
    if (row === undefined) throw new AppError('NOT_FOUND', 'No credential staged');
    const validation = CandidateValidationSchema.safeParse(row.candidate_validation ?? {});
    if (
      row.revision !== input.expectedRevision ||
      row.candidate_version !== input.candidateVersion ||
      row.candidate_status !== 'valid' ||
      row.validated_recently !== true
    ) {
      throw new AppError('CONFLICT', 'The candidate is not a current valid validation');
    }
    if (!validation.success || validation.data.configFingerprint !== input.configFingerprint) {
      throw new AppError('CONFLICT', 'The provider configuration changed since validation');
    }
    const result = await tx.execute<{ revision: string; active_version: string }>(sql`
      UPDATE provider_credentials c
         SET revision = c.revision + 1, enabled = true,
             active_version = c.candidate_version, active_envelope = c.candidate_envelope,
             candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
             candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
             activated_at = now(), last_error_code = NULL, updated_at = now(),
             updated_by = ${input.adminUserId ?? null}::uuid
       WHERE c.provider = ${input.provider}
      RETURNING c.revision::text AS revision, c.active_version::text AS active_version`);
    const breaker = input.provider === 'typesafe' ? 'typesafe' : 'llm';
    await tx.execute(sql`
      UPDATE settings s
         SET value = jsonb_set(s.value, ARRAY[${breaker}]::text[], '{"state":"closed","reopenCount":0}'::jsonb),
             updated_at = now(), updated_by = ${input.adminUserId ?? null}::uuid
       WHERE s.key = 'engine.circuit' AND s.value #>> ARRAY[${breaker}, 'state']::text[] = 'auth'`);
    const updated = result.rows[0]!;
    return { revision: updated.revision, activeVersion: updated.active_version };
  });
}

/**
 * Enable an active credential, or disable (revoke locally): clear both envelopes and leave an
 * `enabled = false` tombstone that blocks the environment fallback (mirrors
 * `admin_set_provider_enabled`, spec 04 §1.2 step 4). Outstanding validation leases are
 * invalidated; the provider-side key is not revoked by this.
 */
export async function setProviderCredentialEnabled(
  db: Database,
  input: {
    provider: CredentialProviderName;
    expectedRevision: string;
    enabled: boolean;
    adminUserId?: string | null;
  },
): Promise<{ revision: string; enabled: boolean }> {
  assertProvider(input.provider);
  assertVersion('expectedRevision', input.expectedRevision, { allowZero: true });
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, input.provider, { create: true });
    if (row === undefined || row.revision !== input.expectedRevision) throw stale();
    const admin = input.adminUserId ?? null;
    if (input.enabled) {
      if (row.active_version === null) {
        throw new AppError('CONFLICT', 'No active credential to enable');
      }
      const result = await tx.execute<{ revision: string; enabled: boolean }>(sql`
        UPDATE provider_credentials c
           SET enabled = true, revision = c.revision + 1, updated_at = now(), updated_by = ${admin}::uuid
         WHERE c.provider = ${input.provider}
        RETURNING c.revision::text AS revision, c.enabled`);
      return result.rows[0]!;
    }
    const result = await tx.execute<{ revision: string; enabled: boolean }>(sql`
      UPDATE provider_credentials c
         SET enabled = false, revision = c.revision + 1, active_version = NULL, active_envelope = NULL,
             candidate_version = NULL, candidate_envelope = NULL, candidate_status = NULL,
             candidate_validation = '{}', validation_token = NULL, validation_until = NULL,
             updated_at = now(), updated_by = ${admin}::uuid
       WHERE c.provider = ${input.provider}
      RETURNING c.revision::text AS revision, c.enabled`);
    return result.rows[0]!;
  });
}

export interface StoredEnvelope {
  slot: 'active' | 'candidate';
  version: string;
  envelope: unknown;
}

/** Every stored envelope with its version (master-key rotation reads them to rewrap). */
export async function readStoredEnvelopes(
  db: Executor,
  provider: CredentialProviderName,
): Promise<StoredEnvelope[]> {
  assertProvider(provider);
  const result = await db.execute<{
    active_version: string | null;
    active_envelope: unknown;
    candidate_version: string | null;
    candidate_envelope: unknown;
  }>(sql`
    SELECT c.active_version::text AS active_version, c.active_envelope,
           c.candidate_version::text AS candidate_version, c.candidate_envelope
      FROM provider_credentials c WHERE c.provider = ${provider}`);
  const row = result.rows[0];
  if (row === undefined) return [];
  const out: StoredEnvelope[] = [];
  if (row.active_version !== null) {
    out.push({ slot: 'active', version: row.active_version, envelope: row.active_envelope });
  }
  if (row.candidate_version !== null) {
    out.push({
      slot: 'candidate',
      version: row.candidate_version,
      envelope: row.candidate_envelope,
    });
  }
  return out;
}

/**
 * Replace one stored envelope by its rewrapped form (master-key rotation, spec 04 §1.2): a CAS on
 * the slot's version and exact current envelope, so a concurrent stage, activation or revocation
 * wins and nothing stale is written. The credential revision is unchanged (same secret version).
 */
export async function rewrapProviderCredential(
  db: Executor,
  input: {
    provider: CredentialProviderName;
    slot: 'active' | 'candidate';
    version: string;
    currentEnvelope: unknown;
    envelope: unknown;
  },
): Promise<boolean> {
  assertProvider(input.provider);
  assertVersion('version', input.version, { allowZero: false });
  const envelope = CredentialEnvelopeSchema.safeParse(input.envelope);
  if (!envelope.success) throw new AppError('VALIDATION_FAILED', 'Invalid credential envelope');
  const next = JSON.stringify(envelope.data);
  const current = JSON.stringify(input.currentEnvelope);
  const result =
    input.slot === 'active'
      ? await db.execute(sql`
          UPDATE provider_credentials c SET active_envelope = ${next}::jsonb, updated_at = now()
           WHERE c.provider = ${input.provider} AND c.active_version = ${input.version}::bigint
             AND c.active_envelope = ${current}::jsonb`)
      : await db.execute(sql`
          UPDATE provider_credentials c SET candidate_envelope = ${next}::jsonb, updated_at = now()
           WHERE c.provider = ${input.provider} AND c.candidate_version = ${input.version}::bigint
             AND c.candidate_envelope = ${current}::jsonb`);
  return result.rowCount === 1;
}

/** The id of an active administrator account by email (CLI attribution, `--admin <email>`). */
export async function resolveAdminUserId(db: Executor, email: string): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT u.id::text AS id FROM users u
     WHERE u.email = ${email} AND u.role = 'admin' AND u.deleted_at IS NULL`);
  const row = result.rows[0];
  if (row === undefined) throw new AppError('FORBIDDEN', 'Not an active administrator');
  return row.id;
}
