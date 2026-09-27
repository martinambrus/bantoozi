import { createArticle, createUser } from '@bantoozi/testing';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addCardExample, adoptLibraryCard, createUserCard } from '../../src/cards/index.js';
import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from '../support/test-db.js';
import { asUser, createReader, holdings, storedCard } from './helpers.js';

/**
 * Publication of a user card to the public library (spec 05 §8.1, spec 02 §3.6, §6): the existing
 * SQL functions `admin_request_card_publication`, `respond_card_publication` and
 * `admin_promote_card`, exercised on cards and holders made through the card repository. Covers
 * exact-version creator approval, who may approve, the hold for active, deleted and unknown
 * creators, the 30-day inactivity boundary to the second, the durable decline veto, the recorded
 * authorization basis and the three-holder threshold.
 */

let ctx: DbTestContext;
/** An active administrator (`users.role = 'admin'`). */
let admin: string;

beforeAll(async () => {
  ctx = await setupDbTest();
  admin = (await createUser(ctx.owner, { role: 'admin' })).id;
});

afterAll(async () => {
  await ctx.close();
});

let sequence = 0;
function uniqueText(label: string): string {
  sequence += 1;
  return `${label} worth publishing number ${sequence}`;
}

/** The single row one statement returns as `bantoozi_app` for tenant `userId`. */
async function appRow<R extends QueryResultRow>(
  userId: string,
  text: string,
  values: unknown[],
): Promise<R> {
  const { rows } = await asTenant(ctx.appPool, userId, (client) => client.query<R>(text, values));
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error('expected exactly one row');
  return row;
}

const PAYLOAD = {
  title: 'Promoted title',
  topic_ids: [],
  i18n: { sk: { title: 'Povýšený názov' } },
};

const requestPublication = (cardId: string, payload: object = PAYLOAD) =>
  appRow<{ request_id: string; version: string }>(
    admin,
    'SELECT * FROM admin_request_card_publication($1, $2::jsonb, NULL)',
    [cardId, JSON.stringify(payload)],
  );

const respond = (userId: string, requestId: string, expected: number, approve: boolean) =>
  appRow<{ status: string; version: string }>(
    userId,
    'SELECT * FROM respond_card_publication($1, $2, $3)',
    [requestId, expected, approve],
  );

const promote = (requestId: string, expected: number) =>
  appRow<{ card_id: string; authorization_kind: string }>(
    admin,
    'SELECT * FROM admin_promote_card($1, $2)',
    [requestId, expected],
  );

/** Last activity `ago` before the database clock. */
const setLastActive = (userId: string, ago: string) =>
  ctx.owner.query(
    'UPDATE users SET last_active_at = clock_timestamp() - $2::interval WHERE id = $1',
    [userId, ago],
  );

const iso = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface RequestRow {
  status: string;
  version: string;
  responded: string | null;
  promoted: string | null;
  authorization_kind: string | null;
  authorization_evidence: Record<string, unknown> | null;
  publication_sha: string;
  card_text_hash: string;
}

async function requestRow(id: string): Promise<RequestRow> {
  const { rows } = await ctx.owner.query<RequestRow>(
    `SELECT status, version::text AS version, ${iso('responded_at')} AS responded,
            ${iso('promoted_at')} AS promoted, authorization_kind, authorization_evidence,
            publication_sha, card_text_hash
       FROM card_publication_requests WHERE id = $1`,
    [id],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`request ${id} is missing`);
  return row;
}

async function vetoOf(cardId: string): Promise<Date | null> {
  const { rows } = await ctx.owner.query<{ veto: Date | null }>(
    'SELECT publication_veto_at AS veto FROM interest_cards WHERE id = $1',
    [cardId],
  );
  return rows[0]?.veto ?? null;
}

interface Proposal {
  creator: string;
  holders: string[];
  cardId: string;
  interest: string;
  requestId: string;
}

/**
 * A card created through the repository (so `creator_user_id` is its first author), `holders`
 * holders in total (the creator included; the others create the same text and reuse the card), and
 * an open publication request.
 */
async function proposal(options: { holders?: number } = {}): Promise<Proposal> {
  const creator = await createReader(ctx);
  const interest = uniqueText('A carefully written interest');
  const created = await asUser(ctx, creator.id, (tx) =>
    createUserCard(tx, { title: 'First title', interest, strength: 'like' }),
  );
  const holders: string[] = [];
  for (let i = 1; i < (options.holders ?? 3); i += 1) {
    const holder = await createReader(ctx);
    const reused = await asUser(ctx, holder.id, (tx) =>
      createUserCard(tx, { interest: interest.toLowerCase(), strength: 'love' }),
    );
    expect(reused.card.id).toBe(created.card.id);
    holders.push(holder.id);
  }
  const request = await requestPublication(created.card.id);
  expect(request.version).toBe('1');
  return {
    creator: creator.id,
    holders,
    cardId: created.card.id,
    interest,
    requestId: request.request_id,
  };
}

/**
 * Set the creator's last activity `ago` before the clock and call `admin_promote_card` in the same
 * transaction, so no more than a few statements of time pass between the two. Commits a promotion
 * unless `rollback`; returns the authorization kind or the SQLSTATE.
 */
async function promoteAfterInactivity(
  p: Proposal,
  expected: number,
  ago: string,
  options: { rollback?: boolean } = {},
): Promise<string> {
  const client = await ctx.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET last_active_at = clock_timestamp() - $2::interval WHERE id = $1',
      [p.creator, ago],
    );
    await client.query('SET LOCAL ROLE bantoozi_app');
    await client.query("SELECT set_config('app.user_id', $1, true)", [admin]);
    try {
      const { rows } = await client.query<{ authorization_kind: string }>(
        'SELECT * FROM admin_promote_card($1, $2)',
        [p.requestId, expected],
      );
      await client.query(options.rollback === true ? 'ROLLBACK' : 'COMMIT');
      return rows[0]?.authorization_kind ?? 'no row';
    } catch (error) {
      await client.query('ROLLBACK');
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : `unexpected: ${String(error)}`;
    }
  } finally {
    client.release();
  }
}

const APPROVAL_KEYS = [
  'approvedVersion',
  'cardTextHash',
  'creatorUserId',
  'policyVersion',
  'publicationSha',
  'requestVersion',
  'respondedAt',
];
const INACTIVITY_KEYS = [
  'anchorAt',
  'anchorSource',
  'cardTextHash',
  'checkedAt',
  'creatorUserId',
  'policyVersion',
  'publicationSha',
  'requestVersion',
];

describe('publication promotion', () => {
  it('promotes on the creator’s approval of the exact proposal version; a revised proposal needs a new one', async () => {
    const p = await proposal();
    const original = await storedCard(ctx, p.cardId);
    const [holder] = p.holders as [string];
    // Only the original author answers: another holder or an administrator finds no request.
    expect(await sqlStateOf(respond(holder, p.requestId, 1, true))).toBe('BZ404');
    expect(await sqlStateOf(respond(admin, p.requestId, 1, true))).toBe('BZ404');
    expect(await sqlStateOf(respond(p.creator, p.requestId, 2, true))).toBe('BZ409');
    expect(await respond(p.creator, p.requestId, 1, true)).toEqual({
      status: 'approved',
      version: '2',
    });

    // A revised proposal is a new version awaiting a fresh response (the guard's only path).
    const revised = { ...PAYLOAD, title: 'Revised title' };
    await ctx.owner.query(
      `UPDATE card_publication_requests
          SET publication_payload = $2::jsonb,
              publication_sha = encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'),
              status = 'pending', responded_at = NULL, version = version + 1
        WHERE id = $1`,
      [p.requestId, JSON.stringify(revised)],
    );
    expect(await sqlStateOf(promote(p.requestId, 2))).toBe('BZ409'); // stale version
    expect(await sqlStateOf(promote(p.requestId, 3))).toBe('BZ409'); // active, not approved
    expect(await sqlStateOf(respond(p.creator, p.requestId, 2, true))).toBe('BZ409');
    expect(await respond(p.creator, p.requestId, 3, true)).toEqual({
      status: 'approved',
      version: '4',
    });
    expect(await promote(p.requestId, 4)).toEqual({
      card_id: p.cardId,
      authorization_kind: 'creator_approval',
    });

    const row = await requestRow(p.requestId);
    expect(row).toMatchObject({ status: 'promoted', version: '4' });
    expect(row.authorization_evidence).toEqual({
      policyVersion: 1,
      creatorUserId: p.creator,
      cardTextHash: original.text_hash,
      publicationSha: row.publication_sha,
      requestVersion: '4',
      respondedAt: row.responded,
      approvedVersion: '4',
    });
    // The same immutable row is now public under the approved title; holders keep holding it.
    expect(await storedCard(ctx, p.cardId)).toMatchObject({
      visibility: 'public',
      origin: 'user',
      title: 'Revised title',
      text_hash: original.text_hash,
      body: original.body,
      creator_user_id: p.creator,
    });
    for (const userId of [p.creator, ...p.holders]) {
      expect((await holdings(ctx, userId))[0]?.startsWith(`${p.cardId}:`)).toBe(true);
    }
    // Later writers of the same text reuse it, and it can be adopted from the library.
    const newcomer = await createReader(ctx);
    const reused = await asUser(ctx, newcomer.id, (tx) =>
      createUserCard(tx, { interest: p.interest, strength: 'like' }),
    );
    expect(reused.card).toMatchObject({
      id: p.cardId,
      visibility: 'public',
      title: 'Revised title',
    });
    const adopter = await createReader(ctx);
    const adopted = await asUser(ctx, adopter.id, (tx) =>
      adoptLibraryCard(tx, { cardId: p.cardId, strength: 'must' }),
    );
    expect(adopted.card.id).toBe(p.cardId);
    expect((await storedCard(ctx, p.cardId)).creator_user_id).toBe(p.creator);
  });

  it('keeps the request of an active creator on hold without an approval', async () => {
    const p = await proposal();
    expect(await sqlStateOf(promote(p.requestId, 1))).toBe('BZ409'); // account created just now
    await setLastActive(p.creator, '29 days');
    expect(await sqlStateOf(promote(p.requestId, 1))).toBe('BZ409');
    expect(await requestRow(p.requestId)).toMatchObject({
      status: 'pending',
      version: '1',
      authorization_kind: null,
    });
    expect((await storedCard(ctx, p.cardId)).visibility).toBe('shared');
  });

  it('keeps the request of a deleted or erased creator on hold', async () => {
    const deleted = await proposal();
    await setLastActive(deleted.creator, '40 days');
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.creator]);
    expect(await sqlStateOf(promote(deleted.requestId, 1))).toBe('BZ409');
    expect((await storedCard(ctx, deleted.cardId)).visibility).toBe('shared');

    // Erasure unlinks the creator from the card and the request: never promotable again, and
    // the unknown creator cannot be asked in a new request either.
    const erased = await proposal();
    await ctx.owner.query('DELETE FROM users WHERE id = $1', [erased.creator]);
    expect((await storedCard(ctx, erased.cardId)).creator_user_id).toBeNull();
    expect(await sqlStateOf(promote(erased.requestId, 1))).toBe('BZ409');
    expect(await requestRow(erased.requestId)).toMatchObject({ status: 'pending' });
    expect(await sqlStateOf(requestPublication(erased.cardId))).toBe('BZ409');
    expect((await storedCard(ctx, erased.cardId)).visibility).toBe('shared');
  });

  it('promotes after 30 days of verified inactivity but not a second earlier; activity resets it', async () => {
    const p = await proposal();
    expect(await promoteAfterInactivity(p, 1, '719 hours 59 minutes 59 seconds')).toBe('BZ409');
    // Eligible at 40 days (rolled back to keep the request open) …
    expect(await promoteAfterInactivity(p, 1, '40 days', { rollback: true })).toBe(
      'creator_inactive_30d',
    );
    // … but any recent activity restarts the 30 days.
    await setLastActive(p.creator, '1 hour');
    expect(await sqlStateOf(promote(p.requestId, 1))).toBe('BZ409');
    await setLastActive(p.creator, '29 days 23 hours');
    expect(await sqlStateOf(promote(p.requestId, 1))).toBe('BZ409');
    expect(await requestRow(p.requestId)).toMatchObject({ status: 'pending', version: '1' });

    expect(await promoteAfterInactivity(p, 1, '720 hours')).toBe('creator_inactive_30d');
    const row = await requestRow(p.requestId);
    const { rows } = await ctx.owner.query<{ anchor: string; full: boolean; bounded: boolean }>(
      `SELECT ${iso('last_active_at')} AS anchor,
              span >= interval '720 hours' AS full, span < interval '720 hours 1 minute' AS bounded
         FROM users,
              LATERAL (SELECT (r.authorization_evidence->>'checkedAt')::timestamptz
                              - (r.authorization_evidence->>'anchorAt')::timestamptz AS span
                         FROM card_publication_requests r WHERE r.id = $2) x
        WHERE users.id = $1`,
      [p.creator, p.requestId],
    );
    expect(row).toMatchObject({
      status: 'promoted',
      version: '1',
      // Inactivity never fakes a response.
      responded: null,
      authorization_kind: 'creator_inactive_30d',
    });
    expect(row.authorization_evidence).toEqual({
      policyVersion: 1,
      creatorUserId: p.creator,
      cardTextHash: row.card_text_hash,
      publicationSha: row.publication_sha,
      requestVersion: '1',
      anchorSource: 'last_active_at',
      anchorAt: rows[0]?.anchor,
      checkedAt: row.promoted,
    });
    expect(rows[0]).toMatchObject({ full: true, bounded: true });
    expect((await storedCard(ctx, p.cardId)).visibility).toBe('public');
  });

  it('blocks publication after a decline, and a fresh request cannot bypass it', async () => {
    const p = await proposal();
    expect(await respond(p.creator, p.requestId, 1, false)).toEqual({
      status: 'rejected',
      version: '2',
    });
    const veto = await vetoOf(p.cardId);
    expect(veto).toBeInstanceOf(Date);
    await setLastActive(p.creator, '40 days');
    expect(await sqlStateOf(promote(p.requestId, 2))).toBe('BZ409');

    // A new request is possible, but the veto outlives it: inactivity cannot override a decline.
    const fresh = (await requestPublication(p.cardId, { title: 'Asking again' })).request_id;
    expect(await sqlStateOf(promote(fresh, 1))).toBe('BZ409');
    expect(await vetoOf(p.cardId)).toEqual(veto);
    expect((await storedCard(ctx, p.cardId)).visibility).toBe('shared');

    // Only the creator's own later approval lifts it.
    expect(await respond(p.creator, fresh, 1, true)).toEqual({ status: 'approved', version: '2' });
    expect(await vetoOf(p.cardId)).toBeNull();
    expect(await promote(fresh, 2)).toEqual({
      card_id: p.cardId,
      authorization_kind: 'creator_approval',
    });
    expect(await requestRow(p.requestId)).toMatchObject({ status: 'rejected', version: '2' });
  });

  it('records the authorization basis that applied, approval taking precedence', async () => {
    const approvedAndInactive = await proposal();
    expect(
      await respond(approvedAndInactive.creator, approvedAndInactive.requestId, 1, true),
    ).toMatchObject({ version: '2' });
    await setLastActive(approvedAndInactive.creator, '40 days');
    expect(await promote(approvedAndInactive.requestId, 2)).toMatchObject({
      authorization_kind: 'creator_approval',
    });
    const inactiveOnly = await proposal();
    await setLastActive(inactiveOnly.creator, '40 days');
    expect(await promote(inactiveOnly.requestId, 1)).toMatchObject({
      authorization_kind: 'creator_inactive_30d',
    });

    const approval = await requestRow(approvedAndInactive.requestId);
    const inactivity = await requestRow(inactiveOnly.requestId);
    expect(Object.keys(approval.authorization_evidence ?? {}).sort()).toEqual(APPROVAL_KEYS);
    expect(Object.keys(inactivity.authorization_evidence ?? {}).sort()).toEqual(INACTIVITY_KEYS);
    expect(approval.responded).not.toBeNull();
    expect(inactivity.responded).toBeNull();
  });

  it('needs three distinct active holders of the card itself; forks and deleted holders do not count', async () => {
    const p = await proposal({ holders: 2 });
    await setLastActive(p.creator, '40 days');

    // A holder who customizes the card holds a private fork instead.
    const forker = await createReader(ctx);
    await asUser(ctx, forker.id, (tx) =>
      createUserCard(tx, { interest: p.interest, strength: 'like' }),
    );
    const article = await createArticle(ctx.owner, {
      feedIds: [forker.active[0]],
      title: 'A private example',
    });
    const fork = await asUser(ctx, forker.id, (tx) =>
      addCardExample(tx, { cardId: p.cardId, articleId: article.id, side: 'yes' }),
    );
    expect(fork.card.parentCardId).toBe(p.cardId);
    // A soft-deleted holder does not count either.
    const gone = await createReader(ctx);
    await asUser(ctx, gone.id, (tx) =>
      createUserCard(tx, { interest: p.interest, strength: 'like' }),
    );
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [gone.id]);
    expect(await sqlStateOf(promote(p.requestId, 1))).toBe('BZ409');
    expect((await storedCard(ctx, p.cardId)).visibility).toBe('shared');

    const third = await createReader(ctx);
    await asUser(ctx, third.id, (tx) =>
      createUserCard(tx, { interest: p.interest, strength: 'like' }),
    );
    expect(await promote(p.requestId, 1)).toEqual({
      card_id: p.cardId,
      authorization_kind: 'creator_inactive_30d',
    });
    // The fork stays private and keeps its parent.
    expect(await storedCard(ctx, fork.card.id)).toMatchObject({
      visibility: 'private',
      owner_user_id: forker.id,
      parent_card_id: p.cardId,
    });
  });
});
