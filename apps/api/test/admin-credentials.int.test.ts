import { randomBytes } from 'node:crypto';

import { decryptProviderSecret, ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T9 (spec 08 §9.1, spec 04 §1.2): the provider credential state machine over the API. Keys are
 * write-only (encrypted with the configured keyring before they reach SQL), every transition is a
 * revision CAS, Validate only queues `provider.validate {provider, candidateVersion}`, and the
 * `env` source is reported only while a fresh worker heartbeat lists the provider.
 */

const SECRET = 'sk-live-THIS-MUST-NEVER-LEAK-1234567890';
const KEY_ID = 'k1';
const KEYS = JSON.stringify({ [KEY_ID]: randomBytes(32).toString('base64') });

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;
let keyed: FastifyInstance;

async function credentialRow(provider: string) {
  const result = await h.owner.query<{
    revision: string;
    candidate_version: string | null;
    candidate_status: string | null;
    candidate_envelope: unknown;
    enabled: boolean;
  }>(
    `SELECT revision::text AS revision, candidate_version::text AS candidate_version,
            candidate_status, candidate_envelope, enabled
       FROM provider_credentials WHERE provider = $1`,
    [provider],
  );
  return result.rows[0];
}

async function seedHeartbeat(entries: Record<string, unknown>): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(entries)],
  );
}

function heartbeat(at: Date, envCredentials: string[]) {
  return {
    at: at.toISOString(),
    queues: ['provider.validate'],
    evalIngestOnly: false,
    envCredentials,
  };
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
  keyed = await h.buildAnother({
    env: { PROVIDER_MASTER_KEY_ID: KEY_ID, PROVIDER_MASTER_KEYS: KEYS },
  });
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query('DELETE FROM provider_credentials');
  await h.owner.query("DELETE FROM settings WHERE key = 'worker.heartbeat'");
  await h.owner.query('DELETE FROM job_outbox');
});

describe('credential source (spec 08 §9.1)', () => {
  it('reports none without a row or a fresh heartbeat, env with one, and reads the row defensively', async () => {
    const client = apiClient(keyed, admin);
    let res = await client.get('/admin/engine/credentials');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        provider: 'typesafe',
        source: 'none',
        enabled: false,
        revision: '0',
      }),
      expect.objectContaining({ provider: 'ollama', source: 'none', enabled: false }),
    ]);

    await seedHeartbeat({ 'w:1': heartbeat(new Date(), ['typesafe']) });
    res = await client.get('/admin/engine/credentials');
    expect(res.json().items[0]).toMatchObject({
      provider: 'typesafe',
      source: 'env',
      enabled: true,
    });
    expect(res.json().items[1]).toMatchObject({ provider: 'ollama', source: 'none' });

    // Older than 90 s: no worker.
    await seedHeartbeat({ 'w:1': heartbeat(new Date(Date.now() - 91_000), ['typesafe']) });
    res = await client.get('/admin/engine/credentials');
    expect(res.json().items[0]).toMatchObject({ source: 'none' });

    // A malformed entry is ignored; a well-formed fresh sibling still counts.
    await seedHeartbeat({
      'bad:1': { at: 'yesterday', queues: 'all' },
      'w:2': heartbeat(new Date(), ['ollama']),
    });
    res = await client.get('/admin/engine/credentials');
    expect(res.json().items[0]).toMatchObject({ source: 'none' });
    expect(res.json().items[1]).toMatchObject({ source: 'env', enabled: true });

    // A row that is not an object at all counts as no worker.
    await h.owner.query(
      `UPDATE settings SET value = '"garbage"'::jsonb WHERE key = 'worker.heartbeat'`,
    );
    res = await client.get('/admin/engine/credentials');
    expect(res.json().items.map((c: { source: string }) => c.source)).toEqual(['none', 'none']);
  });
});

describe('credential lifecycle (spec 08 §9.1, spec 04 §1.2)', () => {
  it('stages write-only, validates, activates and tombstones with revision CAS', async () => {
    const client = apiClient(keyed, admin);

    // Stage: encrypted for candidate version 1, never echoed or stored in clear.
    const staged = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: SECRET,
      expectedRevision: '0',
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.body).not.toContain(SECRET);
    expect(staged.json().credential).toMatchObject({
      provider: 'typesafe',
      source: 'db',
      enabled: false,
      revision: '1',
      activeVersion: null,
      candidateVersion: '1',
      candidateStatus: 'pending',
      capabilities: null,
    });
    const row = await credentialRow('typesafe');
    expect(JSON.stringify(row)).not.toContain(SECRET);
    const parsed = ProviderKeyring.parse(KEY_ID, KEYS);
    if (!parsed.ok) throw new Error('keyring');
    expect(
      decryptProviderSecret({
        keyring: parsed.keyring,
        provider: 'typesafe',
        secretVersion: '1',
        envelope: row?.candidate_envelope,
      }),
    ).toBe(SECRET);
    const receipts = await h.owner.query<{ response: unknown }>(
      'SELECT response FROM api_mutations',
    );
    expect(JSON.stringify(receipts.rows)).not.toContain(SECRET);
    const listed = await client.get('/admin/engine/credentials');
    expect(listed.body).not.toContain(SECRET);

    // Stale revision.
    const stale = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: 'other',
      expectedRevision: '0',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONFLICT');

    // Activate before validation: conflict.
    const early = await client.post('/admin/engine/credentials/typesafe/activate', {
      candidateVersion: '1',
      expectedRevision: '1',
    });
    expect(early.statusCode).toBe(409);

    // Validate queues the probe with ids only.
    const wrong = await client.post('/admin/engine/credentials/typesafe/validate', {
      candidateVersion: '1',
      expectedRevision: '7',
    });
    expect(wrong.statusCode).toBe(409);
    const validate = await client.post('/admin/engine/credentials/typesafe/validate', {
      candidateVersion: '1',
      expectedRevision: '1',
    });
    expect(validate.statusCode).toBe(202);
    expect(validate.json().credential).toMatchObject({ candidateStatus: 'pending' });
    const jobs = await h.owner.query<{ queue: string; payload: unknown }>(
      'SELECT queue, payload FROM job_outbox ORDER BY id',
    );
    expect(jobs.rows).toEqual([
      { queue: 'provider.validate', payload: { provider: 'typesafe', candidateVersion: '1' } },
    ]);
    expect(JSON.stringify(jobs.rows)).not.toContain(SECRET);

    // A live validation lease is busy (D-87); an expired one may be validated again.
    await h.owner.query(
      `UPDATE provider_credentials SET candidate_status = 'validating',
              validation_token = gen_random_uuid(), validation_until = now() + interval '5 minutes'
        WHERE provider = 'typesafe'`,
    );
    const busy = await client.post('/admin/engine/credentials/typesafe/validate', {
      candidateVersion: '1',
      expectedRevision: '1',
    });
    expect(busy.statusCode).toBe(409);
    await h.owner.query(
      `UPDATE provider_credentials SET validation_until = now() - interval '1 minute'
        WHERE provider = 'typesafe'`,
    );
    const retried = await client.post('/admin/engine/credentials/typesafe/validate', {
      candidateVersion: '1',
      expectedRevision: '1',
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().credential.candidateStatus).toBe('validating');

    // The worker records a valid result with capabilities.
    await h.owner.query(
      `UPDATE provider_credentials SET candidate_status = 'valid', validation_token = NULL,
              validation_until = NULL, validated_at = now(),
              candidate_validation = '{"model":"ts-1","concurrencyLimit":4,"capabilities":{"batch":true}}'
        WHERE provider = 'typesafe'`,
    );
    const valid = await client.get('/admin/engine/credentials');
    expect(valid.json().items[0]).toMatchObject({
      candidateStatus: 'valid',
      capabilities: { model: 'ts-1', concurrencyLimit: 4, flags: { batch: true } },
    });
    expect(valid.json().items[0].validatedAt).toEqual(expect.any(String));

    const activated = await client.post('/admin/engine/credentials/typesafe/activate', {
      candidateVersion: '1',
      expectedRevision: '1',
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().credential).toMatchObject({
      source: 'db',
      enabled: true,
      revision: '2',
      activeVersion: '1',
      candidateVersion: null,
      candidateStatus: null,
    });

    // Tombstone: CAS, then disabled with no envelopes; a fresh env worker does not override it.
    const staleDelete = await client.delete('/admin/engine/credentials/typesafe', {
      query: { expectedRevision: '1' },
    });
    expect(staleDelete.statusCode).toBe(409);
    const revoked = await client.delete('/admin/engine/credentials/typesafe', {
      query: { expectedRevision: '2' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().credential).toMatchObject({
      source: 'db',
      enabled: false,
      revision: '3',
      activeVersion: null,
    });
    await seedHeartbeat({ 'w:1': heartbeat(new Date(), ['typesafe']) });
    const after = await client.get('/admin/engine/credentials');
    expect(after.json().items[0]).toMatchObject({ source: 'db', enabled: false });
  });

  it('answers 404 when validating or activating a provider with nothing staged', async () => {
    const client = apiClient(keyed, admin);
    for (const action of ['validate', 'activate']) {
      const res = await client.post(`/admin/engine/credentials/ollama/${action}`, {
        candidateVersion: '1',
        expectedRevision: '0',
      });
      expect(res.statusCode, action).toBe(404);
    }
  });

  it('rejects unsafe keys, unknown providers and a missing keyring without storing anything', async () => {
    const client = apiClient(keyed, admin);
    const crlf = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: 'abc\r\nX-Injected: 1',
      expectedRevision: '0',
    });
    expect(crlf.statusCode).toBe(400);
    expect(crlf.json().error.code).toBe('VALIDATION_FAILED');
    expect(crlf.json().error.details).toMatchObject({ field: 'apiKey' });
    expect(crlf.body).not.toContain('X-Injected');

    const blank = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: '   ',
      expectedRevision: '0',
    });
    expect(blank.statusCode).toBe(400);

    const unknown = await client.put('/admin/engine/credentials/openai', {
      apiKey: SECRET,
      expectedRevision: '0',
    });
    expect(unknown.statusCode).toBe(400);

    const badRevision = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: SECRET,
      expectedRevision: '-1',
    });
    expect(badRevision.statusCode).toBe(400);

    // The default test server has no PROVIDER_MASTER_KEY(S).
    const noKeyring = await apiClient(h.server, admin).put('/admin/engine/credentials/typesafe', {
      apiKey: SECRET,
      expectedRevision: '0',
    });
    expect(noKeyring.statusCode).toBe(503);
    expect(noKeyring.json().error).toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      details: { reason: 'keyring_unavailable' },
    });
    expect(noKeyring.body).not.toContain(SECRET);
    expect(await credentialRow('typesafe')).toBeUndefined();
  });

  it('is admin-only and needs the CSRF header', async () => {
    const forbidden = await apiClient(keyed, reader).put('/admin/engine/credentials/typesafe', {
      apiKey: SECRET,
      expectedRevision: '0',
    });
    expect(forbidden.statusCode).toBe(403);
    const noCsrf = await apiClient(keyed, admin).put(
      '/admin/engine/credentials/typesafe',
      { apiKey: SECRET, expectedRevision: '0' },
      { client: null },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(await credentialRow('typesafe')).toBeUndefined();
  });
});
