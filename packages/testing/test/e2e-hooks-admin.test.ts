import { describe, expect, it } from 'vitest';

import { HookParamsError, runSqlHook, sqlHookNames, type HookDb } from '../src/e2e/hooks.js';
import { ADMIN_HOOKS } from '../src/e2e/hooks-admin.js';

type Call = [string, unknown[]?];

function recordingDb(rows: unknown[] = []): { db: HookDb; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      async query(text, values) {
        calls.push(values === undefined ? [text] : [text, values]);
        return { rows };
      },
    },
  };
}

/** The statement and the values of the one query a hook ran. */
function onlyQuery(calls: Call[]): { text: string; values: unknown[] | undefined } {
  expect(calls).toHaveLength(1);
  const [text = '', values] = calls[0] ?? [];
  return { text, values };
}

const EMAIL = 'creator+one@example.com';
const ID = '9007199254740993';

/** Parameters every hook must refuse before it queries, whatever its own fields are. */
const NOT_AN_OBJECT = [undefined, null, [], 'x', 1, true];

describe('admin SQL hooks', () => {
  it('are registered once each, after articleStates', () => {
    const names = sqlHookNames();
    expect(names[0]).toBe('articleStates');
    expect(new Set(names).size).toBe(names.length);
    for (const [name] of ADMIN_HOOKS) expect(names).toContain(name);
    expect(ADMIN_HOOKS.map(([name]) => name)).toEqual([
      'setLastActive',
      'createOldPublicationRequest',
      'reviseProposalTitle',
      'ageCredentialValidation',
      'publicationAudit',
      'feedbackEvents',
    ]);
  });

  describe('setLastActive', () => {
    it('moves the last activity of one live account back and binds both values', async () => {
      const { db, calls } = recordingDb([{ id: 'u' }]);
      await expect(runSqlHook(db, 'setLastActive', { email: EMAIL, daysAgo: 31 })).resolves.toEqual(
        { updated: 1 },
      );
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL, 31]);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('UPDATE users');
      expect(text).toContain('last_active_at = clock_timestamp() - make_interval(days => $2::int)');
      expect(text).toContain('deleted_at IS NULL');
      expect(text).not.toMatch(/DELETE|DROP|TRUNCATE/);
    });

    it('reports an unknown account as nothing updated', async () => {
      const { db } = recordingDb([]);
      await expect(runSqlHook(db, 'setLastActive', { email: EMAIL, daysAgo: 0 })).resolves.toEqual({
        updated: 0,
      });
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: EMAIL },
        { daysAgo: 31 },
        { email: 1, daysAgo: 31 },
        { email: '', daysAgo: 31 },
        { email: 'no-at-sign', daysAgo: 31 },
        { email: 'white space@example.com', daysAgo: 31 },
        { email: "x'; DROP TABLE users; --@example.com", daysAgo: 31 },
        { email: `${'a'.repeat(250)}@example.com`, daysAgo: 31 },
        { email: EMAIL, daysAgo: '31' },
        { email: EMAIL, daysAgo: -1 },
        { email: EMAIL, daysAgo: 1.5 },
        { email: EMAIL, daysAgo: Number.NaN },
        { email: EMAIL, daysAgo: Number.POSITIVE_INFINITY },
        { email: EMAIL, daysAgo: 3651 },
        { email: EMAIL, daysAgo: null },
        { email: EMAIL, daysAgo: 31, extra: 1 },
      ]) {
        await expect(runSqlHook(db, 'setLastActive', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('createOldPublicationRequest', () => {
    it('inserts one pending request for a shared card, backdated by the bound days', async () => {
      const row = { requestId: '12', version: '1' };
      const { db, calls } = recordingDb([row]);
      await expect(
        runSqlHook(db, 'createOldPublicationRequest', { cardId: ID, daysOld: 60 }),
      ).resolves.toBe(row);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([ID, 60]);
      expect(text).not.toContain(ID);
      expect(text).toContain('INSERT INTO card_publication_requests');
      expect(text).toContain('now() - make_interval(days => $2::int)');
      // Addressed to the card's creator, bound to the card's exact text and the proposal's hash.
      expect(text).toContain('c.creator_user_id');
      expect(text).toContain('c.text_hash');
      expect(text).toContain("encode(sha256(convert_to(p.payload::text, 'UTF8')), 'hex')");
      // Only a shared interest card with a known creator; nothing is updated or deleted.
      expect(text).toContain("c.visibility = 'shared'");
      expect(text).toContain("c.kind = 'interest'");
      expect(text).toContain('c.creator_user_id IS NOT NULL');
      expect(text).not.toMatch(/UPDATE|DELETE|DROP|TRUNCATE/);
      // The proposal only has keys the request function accepts.
      for (const key of ["'slug'", "'title'", "'topic_ids'"]) expect(text).toContain(key);
      expect(text).not.toContain("'status'");
      expect(text).not.toContain('responded_at');
    });

    it('reports a card that cannot get one as nothing inserted', async () => {
      const { db } = recordingDb([]);
      await expect(
        runSqlHook(db, 'createOldPublicationRequest', { cardId: ID, daysOld: 40 }),
      ).resolves.toBeNull();
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { cardId: ID },
        { daysOld: 60 },
        { cardId: 5, daysOld: 60 },
        { cardId: '0', daysOld: 60 },
        { cardId: '012', daysOld: 60 },
        { cardId: '5; DROP TABLE interest_cards', daysOld: 60 },
        { cardId: '1'.repeat(19), daysOld: 60 },
        { cardId: ID, daysOld: '60' },
        { cardId: ID, daysOld: 0 },
        { cardId: ID, daysOld: -3 },
        { cardId: ID, daysOld: 2.5 },
        { cardId: ID, daysOld: 3651 },
        { cardId: ID, daysOld: 60, requestedAt: 'now' },
      ]) {
        await expect(runSqlHook(db, 'createOldPublicationRequest', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('reviseProposalTitle', () => {
    it('makes the open request a new version that awaits an answer and binds both values', async () => {
      const row = { version: '3' };
      const { db, calls } = recordingDb([row]);
      await expect(
        runSqlHook(db, 'reviseProposalTitle', { requestId: ID, title: 'A revised title' }),
      ).resolves.toBe(row);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([ID, 'A revised title']);
      expect(text).not.toContain(ID);
      expect(text).not.toContain('A revised title');
      // The guard's one path for a changed proposal: pending, no response, a higher version, and
      // the hash of the new payload.
      expect(text).toContain("status IN ('pending', 'approved')");
      expect(text).toContain("jsonb_set(r.publication_payload, '{title}', to_jsonb($2::text))");
      expect(text).toContain("encode(sha256(convert_to(o.payload::text, 'UTF8')), 'hex')");
      expect(text).toContain("status = 'pending', responded_at = NULL, version = r.version + 1");
      // It never writes a basis, a promotion or a veto.
      expect(text).not.toMatch(/authorization|promoted|veto|DELETE|DROP|TRUNCATE/);
    });

    it('reports a request that is not open as nothing revised', async () => {
      const { db } = recordingDb([]);
      await expect(
        runSqlHook(db, 'reviseProposalTitle', { requestId: ID, title: 'T' }),
      ).resolves.toBeNull();
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { requestId: ID },
        { title: 'T' },
        { requestId: 5, title: 'T' },
        { requestId: '0', title: 'T' },
        { requestId: '5 OR 1=1', title: 'T' },
        { requestId: ID, title: 7 },
        { requestId: ID, title: '' },
        { requestId: ID, title: ' padded' },
        { requestId: ID, title: 'padded ' },
        { requestId: ID, title: 'a'.repeat(61) },
        { requestId: ID, title: 'T', slug: 'other' },
      ]) {
        await expect(runSqlHook(db, 'reviseProposalTitle', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });

    it('takes a title of exactly 60 characters and keeps quotes as data', async () => {
      const { db, calls } = recordingDb([{ version: '2' }]);
      const quoted = `${"'; DROP TABLE users; --".padEnd(59, 'x')}é`;
      expect([...quoted]).toHaveLength(60);
      await runSqlHook(db, 'reviseProposalTitle', { requestId: ID, title: quoted });
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([ID, quoted]);
      expect(text).not.toContain('DROP TABLE');
    });
  });

  describe('ageCredentialValidation', () => {
    it('ages the validation of a valid staged key of one provider and binds both values', async () => {
      const { db, calls } = recordingDb([{ provider: 'typesafe' }]);
      await expect(
        runSqlHook(db, 'ageCredentialValidation', { provider: 'typesafe', hours: 25 }),
      ).resolves.toEqual({ updated: 1 });
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual(['typesafe', 25]);
      expect(text).not.toContain('typesafe');
      expect(text).toContain('UPDATE provider_credentials');
      expect(text).toContain('validated_at = clock_timestamp() - make_interval(hours => $2::int)');
      expect(text).toContain("candidate_status = 'valid'");
      // It moves one timestamp: no key, envelope, status or revision is written.
      expect(text).not.toMatch(/envelope|revision|enabled|active_version|DELETE|DROP|TRUNCATE/);
    });

    it('reports a provider with no valid staged key as nothing updated', async () => {
      const { db } = recordingDb([]);
      await expect(
        runSqlHook(db, 'ageCredentialValidation', { provider: 'ollama', hours: 1 }),
      ).resolves.toEqual({ updated: 0 });
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { provider: 'typesafe' },
        { hours: 25 },
        { provider: 'openai', hours: 25 },
        { provider: 'typesafe; DROP TABLE provider_credentials', hours: 25 },
        { provider: 1, hours: 25 },
        { provider: 'typesafe', hours: '25' },
        { provider: 'typesafe', hours: 0 },
        { provider: 'typesafe', hours: -5 },
        { provider: 'typesafe', hours: 1.5 },
        { provider: 'typesafe', hours: 3650 * 24 + 1 },
        { provider: 'typesafe', hours: 25, status: 'valid' },
      ]) {
        await expect(runSqlHook(db, 'ageCredentialValidation', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('publicationAudit', () => {
    it('returns the one row of a request through a bound id', async () => {
      const row = {
        status: 'promoted',
        version: '2',
        respondedAt: null,
        promotedAt: '2026-10-08T10:00:00.000000Z',
        authorizationKind: 'creator_inactive_30d',
        authorizationEvidence: { policyVersion: 1 },
        cardVisibility: 'public',
        vetoed: false,
      };
      const { db, calls } = recordingDb([row]);
      await expect(runSqlHook(db, 'publicationAudit', { requestId: ID })).resolves.toBe(row);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([ID]);
      expect(text).not.toContain(ID);
      expect(text).toContain('FROM card_publication_requests r');
      expect(text).toContain('r.authorization_kind');
      expect(text).toContain('r.authorization_evidence');
      expect(text).toContain('c.visibility');
      expect(text).toContain('c.publication_veto_at IS NOT NULL');
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/);
    });

    it('returns null for a request that does not exist', async () => {
      const { db } = recordingDb([]);
      await expect(runSqlHook(db, 'publicationAudit', { requestId: ID })).resolves.toBeNull();
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { requestId: 1 },
        { requestId: '' },
        { requestId: '0' },
        { requestId: '-1' },
        { requestId: '1; SELECT pg_sleep(10)' },
        { requestId: ID, cardId: '5' },
      ]) {
        await expect(runSqlHook(db, 'publicationAudit', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('feedbackEvents', () => {
    it('lists one account’s events through a bound email', async () => {
      const rows = [{ id: '4', kind: 'label', articleId: '9' }];
      const { db, calls } = recordingDb(rows);
      await expect(runSqlHook(db, 'feedbackEvents', { email: EMAIL })).resolves.toBe(rows);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL]);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('FROM feedback_events e');
      expect(text).toContain('ORDER BY e.id');
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: 1 },
        { email: '' },
        { email: 'no-at-sign' },
        { email: 'two@@example.com' },
        { email: "x'; DELETE FROM feedback_events; --@example.com" },
        { email: EMAIL, kind: 'rate' },
      ]) {
        await expect(runSqlHook(db, 'feedbackEvents', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });
});
