import { randomUUID } from 'node:crypto';

import {
  encryptProviderSecret,
  ProviderKeyring,
  rewrapProviderSecret,
  type CredentialEnvelope,
} from '@bantoozi/shared/server/credential-crypto';
import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activateProviderCredential,
  claimCredentialValidation,
  completeCredentialValidation,
  listCredentialMetadata,
  readActiveCredentialSecret,
  readCandidateCredentialSecret,
  readCredentialMetadata,
  readStoredEnvelopes,
  requestProviderValidation,
  resolveAdminUserId,
  rewrapProviderCredential,
  setProviderCredentialEnabled,
  stageProviderCredential,
} from '../../src/engine/index.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * The worker-role provider credential repository (M2-T3; spec 04 §1.2, spec 02 §2.1, §6): the
 * stage → validate → activate → revoke state machine the credentials CLI drives, validation
 * leases, the resolver's envelope reads and master-key rewrap, against a real database.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const FINGERPRINT = 'f'.repeat(64);

function keyring(ids: Record<string, number>, active: string): ProviderKeyring {
  const parsed = ProviderKeyring.parse(
    active,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(ids).map(([id, fill]) => [id, Buffer.alloc(32, fill).toString('base64')]),
      ),
    ),
  );
  if (!parsed.ok) throw new Error(`keyring: ${parsed.reason}`);
  return parsed.keyring;
}

const k1 = keyring({ k1: 1 }, 'k1');

const envelope = (provider: 'typesafe' | 'ollama', version: string, secret = 'test-secret') =>
  encryptProviderSecret({ keyring: k1, provider, secretVersion: version, secret });

async function row(provider: 'typesafe' | 'ollama') {
  const { rows } = await ctx.owner.query<Record<string, unknown>>(
    `SELECT revision::text AS revision, enabled, active_version::text AS active_version,
            candidate_version::text AS candidate_version, candidate_status,
            active_envelope IS NOT NULL AS has_active, candidate_envelope IS NOT NULL AS has_candidate,
            validation_token IS NOT NULL AS leased, updated_by::text AS updated_by
       FROM provider_credentials WHERE provider = $1`,
    [provider],
  );
  return rows[0];
}

/** Stage, validate (valid) and return the candidate at its current revision. */
async function validatedCandidate(provider: 'typesafe' | 'ollama', secret: string) {
  const current = (await readCredentialMetadata(ctx.worker, provider))?.revision ?? '0';
  const version = String(BigInt(current) + 1n);
  const staged = await stageProviderCredential(ctx.worker, {
    provider,
    expectedRevision: current,
    envelope: envelope(provider, version, secret),
  });
  const lease = await claimCredentialValidation(ctx.worker, {
    provider,
    candidateVersion: staged.candidateVersion,
    leaseMs: 60_000,
  });
  expect(
    await completeCredentialValidation(ctx.worker, {
      provider,
      candidateVersion: staged.candidateVersion,
      validationToken: lease!.validationToken,
      result: { status: 'valid', validation: { configFingerprint: FINGERPRINT } },
    }),
  ).toBe(true);
  return staged;
}

describe('credential state machine (spec 04 §1.2)', () => {
  it('stages, validates under a lease, activates and keeps metadata free of envelopes', async () => {
    const admin = await createUser(ctx.owner, { role: 'admin', email: 'root@example.test' });
    expect(await readCredentialMetadata(ctx.worker, 'typesafe')).toBeNull();
    expect(await readActiveCredentialSecret(ctx.worker, 'typesafe')).toEqual({ state: 'missing' });
    const adminId = await resolveAdminUserId(ctx.worker, 'root@example.test');
    expect(adminId).toBe(admin.id);

    // 1. Stage: the candidate is the next revision, pending; no provider traffic.
    const staged = await stageProviderCredential(ctx.worker, {
      provider: 'typesafe',
      expectedRevision: '0',
      envelope: envelope('typesafe', '1'),
      adminUserId: adminId,
    });
    expect(staged).toEqual({ revision: '1', candidateVersion: '1' });
    expect(await row('typesafe')).toMatchObject({
      revision: '1',
      enabled: false,
      candidate_status: 'pending',
      has_candidate: true,
      has_active: false,
      updated_by: admin.id,
    });
    // A staged row without an active key is present but not usable.
    expect(await readActiveCredentialSecret(ctx.worker, 'typesafe')).toEqual({
      state: 'present',
      revision: '1',
      enabled: false,
      activeVersion: null,
      candidateVersion: '1',
      envelope: null,
    });

    // 2. Validate: the request goes through the outbox without any secret.
    await requestProviderValidation(ctx.worker, {
      provider: 'typesafe',
      candidateVersion: '1',
      expectedRevision: '1',
    });
    const { rows: intents } = await ctx.owner.query<{ payload: unknown }>(
      `SELECT payload FROM job_outbox WHERE queue = 'provider.validate'`,
    );
    expect(intents).toEqual([{ payload: { provider: 'typesafe', candidateVersion: '1' } }]);
    expect(JSON.stringify(intents)).not.toContain('ciphertext');

    const lease = await claimCredentialValidation(ctx.worker, {
      provider: 'typesafe',
      candidateVersion: '1',
      leaseMs: 60_000,
    });
    expect(lease).toMatchObject({ revision: '1' });
    // One validator at a time; the candidate envelope only for the lease holder.
    expect(
      await claimCredentialValidation(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '1',
        leaseMs: 60_000,
      }),
    ).toBeNull();
    const read = (token: string) =>
      readCandidateCredentialSecret(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '1',
        validationToken: token,
      });
    expect(await read(lease!.validationToken)).toEqual({
      envelope: expect.objectContaining({ format: 1, key_id: 'k1' }),
    });
    expect(await read(randomUUID())).toBeNull();
    expect(await read('not-a-token')).toBeNull();
    await expect(
      requestProviderValidation(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '1',
        expectedRevision: '1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const checkedAt = new Date().toISOString();
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '1',
        validationToken: lease!.validationToken,
        result: {
          status: 'valid',
          validation: {
            configFingerprint: FINGERPRINT,
            model: 'jev-1.13.0',
            checkedAt,
            capabilities: { noul: true, choice: true, score: true },
            attempts: 1,
            latencyMs: 40,
          },
        },
      }),
    ).toBe(true);
    // The finished lease cannot complete twice.
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '1',
        validationToken: lease!.validationToken,
        result: { status: 'invalid', validation: {}, errorCode: 'auth_rejected' },
      }),
    ).toBe(false);

    const metadata = await readCredentialMetadata(ctx.worker, 'typesafe');
    expect(metadata).toMatchObject({
      provider: 'typesafe',
      revision: '1',
      enabled: false,
      activeVersion: null,
      candidateVersion: '1',
      candidateStatus: 'valid',
      candidateValidation: {
        configFingerprint: FINGERPRINT,
        model: 'jev-1.13.0',
        capabilities: { noul: true, choice: true, score: true },
      },
      lastErrorCode: null,
    });
    expect(metadata?.validatedAt).toBeInstanceOf(Date);
    expect(Object.keys(metadata!).sort()).toEqual([
      'activatedAt',
      'activeVersion',
      'candidateStatus',
      'candidateValidation',
      'candidateVersion',
      'enabled',
      'lastErrorCode',
      'provider',
      'revision',
      'updatedAt',
      'validatedAt',
      'validationLeaseExpired',
    ]);
    expect(JSON.stringify(await listCredentialMetadata(ctx.worker))).not.toMatch(
      /ciphertext|wrapped_key|nonce|test-secret/,
    );

    // 3. Activate: exact candidate, current revision, same configuration fingerprint.
    await ctx.owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.circuit', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          typesafe: { state: 'auth', reopenCount: 2 },
          llm: { state: 'open', reopenCount: 1 },
          resetRequested: {},
        }),
      ],
    );
    await expect(
      activateProviderCredential(ctx.worker, {
        provider: 'typesafe',
        expectedRevision: '1',
        candidateVersion: '1',
        configFingerprint: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      activateProviderCredential(ctx.worker, {
        provider: 'typesafe',
        expectedRevision: '0',
        candidateVersion: '1',
        configFingerprint: FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await activateProviderCredential(ctx.worker, {
        provider: 'typesafe',
        expectedRevision: '1',
        candidateVersion: '1',
        configFingerprint: FINGERPRINT,
        adminUserId: adminId,
      }),
    ).toEqual({ revision: '2', activeVersion: '1' });
    expect(await row('typesafe')).toMatchObject({
      revision: '2',
      enabled: true,
      active_version: '1',
      candidate_version: null,
      has_candidate: false,
    });
    // The old credential's auth breaker is invalidated; the other engine is untouched.
    const { rows: circuit } = await ctx.owner.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM settings WHERE key = 'engine.circuit'`,
    );
    expect(circuit[0]?.value).toMatchObject({
      typesafe: { state: 'closed', reopenCount: 0 },
      llm: { state: 'open', reopenCount: 1 },
    });
    const active = await readActiveCredentialSecret(ctx.worker, 'typesafe');
    expect(active).toMatchObject({
      state: 'present',
      enabled: true,
      activeVersion: '1',
      candidateVersion: null,
    });
    expect(await readActiveCredentialSecret(ctx.worker, 'typesafe')).toMatchObject({
      envelope: expect.objectContaining({ format: 1, key_id: 'k1' }),
    });
  });

  it('keeps the active key usable while a replacement is staged, and rejects stale writes', async () => {
    await validatedCandidate('ollama', 'first');
    await activateProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '1',
      candidateVersion: '1',
      configFingerprint: FINGERPRINT,
    });
    const staged = await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '2',
      envelope: envelope('ollama', '3', 'second'),
    });
    expect(staged).toEqual({ revision: '3', candidateVersion: '3' });
    expect(await readActiveCredentialSecret(ctx.worker, 'ollama')).toMatchObject({
      enabled: true,
      activeVersion: '1',
      candidateVersion: '3',
    });
    await expect(
      stageProviderCredential(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '2',
        envelope: envelope('ollama', '3'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      stageProviderCredential(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '3',
        envelope: { format: 1, key_id: 'k1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // A pending candidate cannot be activated.
    await expect(
      activateProviderCredential(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '3',
        candidateVersion: '3',
        configFingerprint: FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('records inconclusive and invalid validations without stamping them valid', async () => {
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'ollama'`);
    const staged = await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '0',
      envelope: envelope('ollama', '1'),
    });
    const claim = () =>
      claimCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: staged.candidateVersion,
        leaseMs: 60_000,
      });
    const first = await claim();
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: first!.validationToken,
        result: { status: 'pending', validation: { attempts: 0 }, errorCode: 'budget_exhausted' },
      }),
    ).toBe(true);
    expect(await readCredentialMetadata(ctx.worker, 'ollama')).toMatchObject({
      candidateStatus: 'pending',
      validatedAt: null,
      lastErrorCode: 'budget_exhausted',
    });
    // Revalidation is allowed from pending/invalid/valid.
    const second = await claim();
    await expect(
      completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: second!.validationToken,
        result: { status: 'invalid', validation: {}, errorCode: 'Bad Key!' },
      }),
    ).rejects.toThrow(RangeError);
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: second!.validationToken,
        result: { status: 'invalid', validation: { attempts: 1 }, errorCode: 'auth_rejected' },
      }),
    ).toBe(true);
    expect(await readCredentialMetadata(ctx.worker, 'ollama')).toMatchObject({
      candidateStatus: 'invalid',
      lastErrorCode: 'auth_rejected',
    });
    expect((await readCredentialMetadata(ctx.worker, 'ollama'))?.validatedAt).toBeInstanceOf(Date);
    await expect(
      claimCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        leaseMs: 10,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('reclaims an expired validation lease and never lets the stale holder finish', async () => {
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'ollama'`);
    await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '0',
      envelope: envelope('ollama', '1'),
    });
    const input = { provider: 'ollama' as const, candidateVersion: '1', leaseMs: 60_000 };
    const crashed = await claimCredentialValidation(ctx.worker, input);
    await ctx.owner.query(
      `UPDATE provider_credentials SET validation_until = now() - interval '1 second'
        WHERE provider = 'ollama'`,
    );
    expect(
      await readCandidateCredentialSecret(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: crashed!.validationToken,
      }),
    ).toBeNull();
    // A probe that finishes after its lease expired is discarded even before anyone reclaims it.
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: crashed!.validationToken,
        result: { status: 'valid', validation: {} },
      }),
    ).toBe(false);
    const late = await ctx.owner.query<{ candidate_status: string; validated_at: Date | null }>(
      `SELECT candidate_status, validated_at FROM provider_credentials WHERE provider = 'ollama'`,
    );
    expect(late.rows[0]).toEqual({ candidate_status: 'validating', validated_at: null });
    const reclaimed = await claimCredentialValidation(ctx.worker, input);
    expect(reclaimed?.validationToken).not.toBe(crashed?.validationToken);
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: '1',
        validationToken: crashed!.validationToken,
        result: { status: 'valid', validation: {} },
      }),
    ).toBe(false);
  });

  it('queues Validate again for a candidate whose validator stopped, once its lease expired', async () => {
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'ollama'`);
    const ollamaIntents = `FROM job_outbox
                            WHERE queue = 'provider.validate' AND payload->>'provider' = 'ollama'`;
    await ctx.owner.query(`DELETE ${ollamaIntents}`);
    await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '0',
      envelope: envelope('ollama', '1'),
    });
    const request = { provider: 'ollama' as const, candidateVersion: '1', expectedRevision: '1' };
    const input = { provider: 'ollama' as const, candidateVersion: '1', leaseMs: 60_000 };
    const stopped = await claimCredentialValidation(ctx.worker, input);
    expect(stopped).not.toBeNull();
    // A validator at work (a live lease) is refused.
    await expect(requestProviderValidation(ctx.worker, request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await readCredentialMetadata(ctx.worker, 'ollama')).toMatchObject({
      candidateStatus: 'validating',
      validationLeaseExpired: false,
    });
    // It exited without recording a result, and the queue does not retry `provider.validate`.
    await ctx.owner.query(
      `UPDATE provider_credentials SET validation_until = now() - interval '1 second'
        WHERE provider = 'ollama'`,
    );
    expect(await readCredentialMetadata(ctx.worker, 'ollama')).toMatchObject({
      candidateStatus: 'validating',
      validationLeaseExpired: true,
    });
    await requestProviderValidation(ctx.worker, request);
    expect((await ctx.owner.query(`SELECT payload ${ollamaIntents}`)).rows).toEqual([
      { payload: { provider: 'ollama', candidateVersion: '1' } },
    ]);
    // The queued probe reclaims the expired lease; a live lease refuses Validate again.
    const reclaimed = await claimCredentialValidation(ctx.worker, input);
    expect(reclaimed?.validationToken).not.toBe(stopped?.validationToken);
    await expect(requestProviderValidation(ctx.worker, request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('revokes into a tombstone that invalidates leases and blocks re-enabling', async () => {
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'ollama'`);
    await validatedCandidate('ollama', 'soon-revoked');
    await activateProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '1',
      candidateVersion: '1',
      configFingerprint: FINGERPRINT,
    });
    const staged = await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '2',
      envelope: envelope('ollama', '3'),
    });
    const lease = await claimCredentialValidation(ctx.worker, {
      provider: 'ollama',
      candidateVersion: staged.candidateVersion,
      leaseMs: 60_000,
    });
    await expect(
      setProviderCredentialEnabled(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '2',
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await setProviderCredentialEnabled(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '3',
        enabled: false,
      }),
    ).toEqual({ revision: '4', enabled: false });
    expect(await row('ollama')).toMatchObject({
      enabled: false,
      active_version: null,
      candidate_version: null,
      has_active: false,
      has_candidate: false,
      leased: false,
    });
    // An in-flight probe cannot resurrect the revoked candidate.
    expect(
      await completeCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: staged.candidateVersion,
        validationToken: lease!.validationToken,
        result: { status: 'valid', validation: {} },
      }),
    ).toBe(false);
    expect(await readActiveCredentialSecret(ctx.worker, 'ollama')).toEqual({
      state: 'present',
      revision: '4',
      enabled: false,
      activeVersion: null,
      candidateVersion: null,
      envelope: null,
    });
    await expect(
      setProviderCredentialEnabled(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '4',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      requestProviderValidation(ctx.worker, {
        provider: 'typesafe',
        candidateVersion: '9',
        expectedRevision: '9',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('re-enables a disabled row that still has its active key', async () => {
    await ctx.owner.query(
      `INSERT INTO provider_credentials (provider, revision, enabled, active_version, active_envelope)
       VALUES ('ollama', 7, false, 6, $1::jsonb)
       ON CONFLICT (provider) DO UPDATE SET revision = 7, enabled = false, active_version = 6,
              active_envelope = EXCLUDED.active_envelope, candidate_version = NULL,
              candidate_envelope = NULL, candidate_status = NULL`,
      [JSON.stringify(envelope('ollama', '6'))],
    );
    expect(
      await setProviderCredentialEnabled(ctx.worker, {
        provider: 'ollama',
        expectedRevision: '7',
        enabled: true,
      }),
    ).toEqual({ revision: '8', enabled: true });
  });
});

describe('master-key rotation (spec 04 §1.2)', () => {
  it('rewraps stored envelopes under the new key with a CAS on the current envelope', async () => {
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'typesafe'`);
    await validatedCandidate('typesafe', 'rotating');
    await activateProviderCredential(ctx.worker, {
      provider: 'typesafe',
      expectedRevision: '1',
      candidateVersion: '1',
      configFingerprint: FINGERPRINT,
    });
    await stageProviderCredential(ctx.worker, {
      provider: 'typesafe',
      expectedRevision: '2',
      envelope: envelope('typesafe', '3', 'candidate'),
    });
    const stored = await readStoredEnvelopes(ctx.worker, 'typesafe');
    expect(stored.map((e) => [e.slot, e.version])).toEqual([
      ['active', '1'],
      ['candidate', '3'],
    ]);
    const rotated = keyring({ k1: 1, k2: 2 }, 'k2');
    for (const entry of stored) {
      const next = rewrapProviderSecret({
        keyring: rotated,
        provider: 'typesafe',
        secretVersion: entry.version,
        envelope: entry.envelope,
      });
      expect(
        await rewrapProviderCredential(ctx.worker, {
          provider: 'typesafe',
          slot: entry.slot,
          version: entry.version,
          currentEnvelope: entry.envelope,
          envelope: next,
        }),
      ).toBe(true);
      // A stale rewrap (someone else already replaced it) writes nothing.
      expect(
        await rewrapProviderCredential(ctx.worker, {
          provider: 'typesafe',
          slot: entry.slot,
          version: entry.version,
          currentEnvelope: entry.envelope,
          envelope: next,
        }),
      ).toBe(false);
    }
    const after = await readStoredEnvelopes(ctx.worker, 'typesafe');
    expect(after.map((e) => (e.envelope as CredentialEnvelope).key_id)).toEqual(['k2', 'k2']);
    // The credential revision is unchanged: the same secret versions.
    expect(await row('typesafe')).toMatchObject({ revision: '3', active_version: '1' });
    await expect(
      rewrapProviderCredential(ctx.worker, {
        provider: 'typesafe',
        slot: 'active',
        version: '1',
        currentEnvelope: after[0]!.envelope,
        envelope: { format: 1 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readStoredEnvelopes(ctx.worker, 'ollama')).not.toHaveLength(3);
  });
});

describe('administrator attribution', () => {
  it('resolves only active administrators by email', async () => {
    await createUser(ctx.owner, { email: 'reader@example.test' });
    await createUser(ctx.owner, {
      role: 'admin',
      email: 'gone@example.test',
      deletedAt: new Date(),
    });
    await expect(resolveAdminUserId(ctx.worker, 'reader@example.test')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(resolveAdminUserId(ctx.worker, 'gone@example.test')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(resolveAdminUserId(ctx.worker, 'nobody@example.test')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(readCredentialMetadata(ctx.worker, 'laya' as never)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
