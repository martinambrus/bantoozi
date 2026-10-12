import { createHmac, randomUUID } from 'node:crypto';

import { completeAnalysisRequest, purgeUser } from '@bantoozi/db';
import { ERASURE_BACKUP_LOCK_KEY } from '@bantoozi/shared';
import * as sharedServer from '@bantoozi/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { RetentionBWorld } from './support/retention-b-world.js';
import {
  DAY,
  FakeLedger,
  LEDGER_KEY,
  MINUTE,
  PLATFORM_USER_ID,
  RetentionCWorld,
  startOfUtcDay,
  utcDay,
} from './support/retention-c-world.js';
import { RetentionWorld } from './support/retention-world.js';

/**
 * M8-T2 (PLAN §14, spec 11 §5, §5.1, §5.3, §6): `house.purge-engine-calls`, `house.retire-cards` and
 * `house.purge-users` with the deletion ledger, through the registered handlers against a migrated
 * database. The clock of most runs is a fake `NOW` 100 days after the real one and every fixture
 * is placed relative to it, so a handler that reads the database clock sees a different world;
 * each boundary is probed one minute on either side. The ledger is an in-memory fake that checks,
 * at every append, whether the user row still exists. Effects are read from the database only.
 */

const NOW = new Date(Date.now() + 100 * DAY);
const HOUR = 60 * MINUTE;
const before = (ms: number): Date => new Date(NOW.getTime() - ms);
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const PURGE_ENGINE_CALLS = 'house.purge-engine-calls' as const;
const RETIRE_CARDS = 'house.retire-cards' as const;
const PURGE_USERS = 'house.purge-users' as const;

/** The helper `@bantoozi/shared/server` must export (HMAC-SHA256 hex over the normalized email). */
const deletionEmailHmac = (email: string, key: string): string =>
  (
    sharedServer as unknown as { deletionEmailHmac(email: string, key: string): string }
  ).deletionEmailHmac(email, key);

let h: ClassifyHarness;
let w: RetentionWorld;
let b: RetentionBWorld;
let c: RetentionCWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new RetentionWorld(h);
  b = new RetentionBWorld(w);
  c = new RetentionCWorld(b);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

/** A pending analysis request of a fresh user and article, created at `createdAt`. */
async function pendingRequest(createdAt: Date): Promise<string> {
  const user = await b.user();
  const feed = await b.subscribedFeed([user]);
  const article = await w.article([{ feedId: feed, at: new Date() }]);
  return b.analysisRequest(user, feed, article, createdAt, 'pending');
}

/** A failed (terminal) analysis request created and finished at `createdAt`. */
async function terminalRequest(createdAt: Date, status: 'failed' | 'cancelled'): Promise<string> {
  const user = await b.user();
  const feed = await b.subscribedFeed([user]);
  const article = await w.article([{ feedId: feed, at: new Date() }]);
  return b.analysisRequest(user, feed, article, createdAt, status);
}

const requestExists = (id: string): Promise<boolean> =>
  b.exists('SELECT 1 FROM analysis_requests WHERE id = $1', id);

// ── house.purge-engine-calls ─────────────────────────────────────────────────────────────────

describe('house.purge-engine-calls', () => {
  it('cancels a pending or running request 180 days after creation, not one minute earlier', async () => {
    const pendingOld = await pendingRequest(before(180 * DAY + MINUTE));
    const pendingYoung = await pendingRequest(before(180 * DAY - MINUTE));
    const runningOld = await pendingRequest(before(180 * DAY + MINUTE));
    const runningYoung = await pendingRequest(before(180 * DAY - MINUTE));
    const oldToken = randomUUID();
    const youngToken = randomUUID();
    await c.runRequest(runningOld, oldToken, at(NOW, HOUR));
    await c.runRequest(runningYoung, youngToken, at(NOW, HOUR));

    await c.run(PURGE_ENGINE_CALLS, NOW);

    for (const id of [pendingOld, runningOld]) {
      const row = await c.request(id);
      expect(row, id).not.toBeNull();
      expect(row).toMatchObject({
        status: 'cancelled',
        last_error_code: 'retention_expired',
        lease_token: null,
        lease_until: null,
      });
      // Finished by the run's clock, not the database's.
      const completed = (row!.completed_at as Date).getTime();
      expect(Math.abs(completed - NOW.getTime())).toBeLessThan(HOUR);
    }
    expect(await c.request(pendingYoung)).toMatchObject({
      status: 'pending',
      last_error_code: null,
    });
    expect(await c.request(runningYoung)).toMatchObject({
      status: 'running',
      lease_token: youngToken,
    });
    // A late completion of the cancelled request's old lease fails its token check.
    expect(
      await completeAnalysisRequest(h.deps.db, runningOld, oldToken, { late: true }),
    ).toBeNull();
    expect((await c.request(runningOld))!.status).toBe('cancelled');
    expect((await c.request(runningOld))!.result_snapshot).toBeNull();
  });

  it('cancels a stale request once: a second run leaves the cancelled record as it is', async () => {
    const id = await pendingRequest(before(181 * DAY));
    await c.run(PURGE_ENGINE_CALLS, NOW);
    const first = await c.request(id);
    expect(first).toMatchObject({ status: 'cancelled', last_error_code: 'retention_expired' });
    await c.run(PURGE_ENGINE_CALLS, NOW);
    expect(await c.request(id)).toEqual(first);
  });

  it('settles an uncertain reservation at its reserved amount 7 days after its day, not 6', async () => {
    const day = utcDay(before(7 * DAY)); // day + 7 is the UTC date of NOW
    const today = startOfUtcDay(utcDay(NOW));
    const justBefore = at(today, -MINUTE); // UTC date day + 6
    const justAfter = at(today, MINUTE); // UTC date day + 7
    const user = await b.user();
    const nextDay = utcDay(at(startOfUtcDay(day), DAY));

    // Without an engine_calls row: the call is counted with its cost, on the platform bucket.
    const bare = await c.reservation({
      day,
      status: 'uncertain',
      reservedUsd: 0.5,
      reservedCalls: 2,
      engine: 'typesafe',
      kind: 'enrich',
    });
    // With one: the usage row already counts the call at cost 0; only the cost is added.
    const called = await c.reservation({
      day,
      status: 'uncertain',
      reservedUsd: 0.7,
      userId: user,
      engine: 'llm',
      kind: 'match',
    });
    await c.call({
      createdAt: startOfUtcDay(day),
      reservationId: called,
      userId: user,
      engine: 'llm',
      kind: 'match',
      billing: 'uncertain',
    });
    await c.setUsage(day, user, 'llm', 'match', { calls: 1 });
    // One day younger: due only a day later.
    const late = await c.reservation({
      day: nextDay,
      status: 'uncertain',
      reservedUsd: 0.3,
      engine: 'laya',
      kind: 'cluster',
    });

    await c.run(PURGE_ENGINE_CALLS, justBefore);
    expect((await c.reservationRow(bare))!.status).toBe('uncertain');
    expect((await c.reservationRow(called))!.status).toBe('uncertain');
    expect(await c.usage(day, PLATFORM_USER_ID, 'typesafe', 'enrich')).toBeNull();
    expect((await c.usage(day, user, 'llm', 'match'))!.costUsd).toBe(0);

    await c.run(PURGE_ENGINE_CALLS, justAfter);
    for (const [id, usd] of [
      [bare, 0.5],
      [called, 0.7],
    ] as const) {
      const row = (await c.reservationRow(id))!;
      expect(row.status, id).toBe('settled');
      expect(row.actualUsd, id).toBeCloseTo(usd, 8);
      expect(Math.abs(row.settledAt!.getTime() - justAfter.getTime()), id).toBeLessThan(HOUR);
    }
    expect(await c.usage(day, PLATFORM_USER_ID, 'typesafe', 'enrich')).toMatchObject({ calls: 2 });
    expect((await c.usage(day, PLATFORM_USER_ID, 'typesafe', 'enrich'))!.costUsd).toBeCloseTo(
      0.5,
      8,
    );
    expect(await c.usage(day, user, 'llm', 'match')).toMatchObject({ calls: 1 });
    expect((await c.usage(day, user, 'llm', 'match'))!.costUsd).toBeCloseTo(0.7, 8);
    expect((await c.reservationRow(late))!.status).toBe('uncertain');
    expect(await c.usage(nextDay, PLATFORM_USER_ID, 'laya', 'cluster')).toBeNull();

    // Running again, and on the next day, adds nothing twice and settles the younger one.
    const totals = await c.usageTotals();
    await c.run(PURGE_ENGINE_CALLS, justAfter);
    expect(await c.usageTotals()).toEqual(totals);
    await c.run(PURGE_ENGINE_CALLS, at(today, DAY + MINUTE));
    expect((await c.reservationRow(late))!.status).toBe('settled');
    expect((await c.usage(nextDay, PLATFORM_USER_ID, 'laya', 'cluster'))!.costUsd).toBeCloseTo(
      0.3,
      8,
    );
    const after = await c.usageTotals();
    expect(after.costUsd).toBeCloseTo(totals.costUsd + 0.3, 6);
    await c.run(PURGE_ENGINE_CALLS, at(today, DAY + MINUTE));
    expect(await c.usageTotals()).toEqual(after);
  });

  it('settles an old uncertain reservation before purging it with its call, keeping the spend in usage_daily', async () => {
    const day = utcDay(before(190 * DAY));
    const user = await b.user();
    const bare = await c.reservation({
      day,
      status: 'uncertain',
      reservedUsd: 1.5,
      reservedCalls: 3,
      engine: 'libretranslate',
      kind: 'translate',
    });
    const called = await c.reservation({
      day,
      status: 'uncertain',
      reservedUsd: 0.9,
      userId: user,
      engine: 'llm',
      kind: 'suggest',
    });
    const callId = await c.call({
      createdAt: startOfUtcDay(day),
      reservationId: called,
      userId: user,
      engine: 'llm',
      kind: 'suggest',
      billing: 'uncertain',
    });
    await c.setUsage(day, user, 'llm', 'suggest', { calls: 1 });

    await c.run(PURGE_ENGINE_CALLS, NOW);
    expect(await c.reservationRow(bare)).toBeNull();
    expect(await c.reservationRow(called)).toBeNull();
    expect(await c.callExists(callId)).toBe(false);
    expect(await c.usage(day, PLATFORM_USER_ID, 'libretranslate', 'translate')).toMatchObject({
      calls: 3,
    });
    expect(
      (await c.usage(day, PLATFORM_USER_ID, 'libretranslate', 'translate'))!.costUsd,
    ).toBeCloseTo(1.5, 8);
    expect(await c.usage(day, user, 'llm', 'suggest')).toMatchObject({ calls: 1 });
    expect((await c.usage(day, user, 'llm', 'suggest'))!.costUsd).toBeCloseTo(0.9, 8);

    const totals = await c.usageTotals();
    await c.run(PURGE_ENGINE_CALLS, NOW);
    expect(await c.usageTotals()).toEqual(totals);
  });

  it('purges engine calls, settled reservations and terminal requests at 180 days, keeping younger ones and open work', async () => {
    const oldDay = utcDay(before(181 * DAY));
    const youngDay = utcDay(before(179 * DAY));
    const oldReservation = await c.reservation({
      day: oldDay,
      status: 'settled',
      reservedUsd: 0.1,
    });
    const oldReservationCall = await c.call({
      createdAt: at(startOfUtcDay(oldDay), HOUR),
      reservationId: oldReservation,
    });
    const youngReservation = await c.reservation({
      day: youngDay,
      status: 'settled',
      reservedUsd: 0.1,
    });
    const youngReservationCall = await c.call({
      createdAt: at(startOfUtcDay(youngDay), HOUR),
      reservationId: youngReservation,
    });
    const callOld = await c.call({ createdAt: before(180 * DAY + MINUTE) });
    const callYoung = await c.call({ createdAt: before(180 * DAY - MINUTE) });
    const usageDay = utcDay(before(300 * DAY));
    await c.setUsage(usageDay, PLATFORM_USER_ID, 'typesafe', 'eval', { calls: 4, costUsd: 2 });
    const usageBefore = await c.usageTotals();

    const failedOld = await terminalRequest(before(180 * DAY + MINUTE), 'failed');
    const failedYoung = await terminalRequest(before(180 * DAY - MINUTE), 'failed');
    const cancelledOld = await terminalRequest(before(180 * DAY + MINUTE), 'cancelled');
    const pendingYoung = await pendingRequest(before(180 * DAY - MINUTE));

    await c.run(PURGE_ENGINE_CALLS, NOW);

    expect(await c.reservationRow(oldReservation)).toBeNull();
    expect(await c.callExists(oldReservationCall)).toBe(false);
    expect(await c.reservationRow(youngReservation)).not.toBeNull();
    expect(await c.callExists(youngReservationCall)).toBe(true);
    expect(await c.callExists(callOld)).toBe(false);
    expect(await c.callExists(callYoung)).toBe(true);
    expect(await requestExists(failedOld)).toBe(false);
    expect(await requestExists(cancelledOld)).toBe(false);
    expect(await requestExists(failedYoung)).toBe(true);
    expect(await requestExists(pendingYoung)).toBe(true);
    // Aggregate totals are forever.
    expect(await c.usageTotals()).toEqual(usageBefore);
    expect(await c.usage(usageDay, PLATFORM_USER_ID, 'typesafe', 'eval')).toMatchObject({
      calls: 4,
    });
  });

  it('deletes feedback events after 365 days and delivered outbox rows after 7, never pending or failed intents', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const article = await w.article([{ feedId: feed, at: new Date() }]);
    const eventOld = await c.feedbackEvent(user, article, before(365 * DAY + MINUTE));
    const eventYoung = await c.feedbackEvent(user, article, before(365 * DAY - MINUTE));
    const eventMid = await c.feedbackEvent(user, article, before(200 * DAY));

    const old = before(400 * DAY);
    const deliveredOld = await c.outbox({ createdAt: old, deliveredAt: before(7 * DAY + MINUTE) });
    const deliveredYoung = await c.outbox({
      createdAt: old,
      deliveredAt: before(7 * DAY - MINUTE),
    });
    const pending = await c.outbox({ createdAt: old });
    const failed = await c.outbox({ createdAt: old, attempts: 6 });

    await c.run(PURGE_ENGINE_CALLS, NOW);

    expect(await c.feedbackEventExists(eventOld)).toBe(false);
    expect(await c.feedbackEventExists(eventYoung)).toBe(true);
    expect(await c.feedbackEventExists(eventMid)).toBe(true);
    expect(await c.outboxExists(deliveredOld)).toBe(false);
    expect(await c.outboxExists(deliveredYoung)).toBe(true);
    expect(await c.outboxExists(pending)).toBe(true);
    expect(await c.outboxExists(failed)).toBe(true);
    await c.run(PURGE_ENGINE_CALLS, NOW);
    expect(await c.feedbackEventExists(eventYoung)).toBe(true);
    expect(await c.outboxExists(deliveredYoung)).toBe(true);
  });
});

// ── house.retire-cards ───────────────────────────────────────────────────────────────────────

describe('house.retire-cards', () => {
  it('retires an unheld non-public card but not a held, public or rater-referenced one', async () => {
    const user = await b.user();
    const privateCard = await c.privateCard(user);
    const sharedCard = await c.sharedCard(user);
    const heldCard = await c.privateCard(user);
    await c.hold(user, heldCard);
    const heldLabel = await c.privateCard(user, 'label');
    await c.holdLabel(user, heldLabel);
    const publicCard = await c.publicCard();
    const raterCard = await c.privateCard(user);
    await c.evalRaterCard(raterCard);

    await c.run(RETIRE_CARDS, NOW);

    for (const id of [privateCard, sharedCard]) {
      const row = await c.card(id);
      expect(row, id).not.toBeNull();
      expect(row!.retiredAt, id).not.toBeNull();
      // Retired by the run's clock, not the database's.
      expect(Math.abs(row!.retiredAt!.getTime() - NOW.getTime()), id).toBeLessThan(HOUR);
    }
    for (const id of [heldCard, heldLabel, publicCard, raterCard]) {
      expect((await c.card(id))!.retiredAt, id).toBeNull();
    }

    // The mark is stable: a later run keeps the first retirement time.
    const first = (await c.card(privateCard))!.retiredAt;
    await c.run(RETIRE_CARDS, at(NOW, HOUR));
    expect((await c.card(privateCard))!.retiredAt).toEqual(first);
  });

  it('deletes the answers and then the card 30 days after retirement, not one minute earlier', async () => {
    const user = await b.user();
    const old = await c.privateCard(user);
    const young = await c.privateCard(user);
    await c.answers(old);
    await c.answers(young);
    const oldAt = before(30 * DAY + MINUTE);
    const youngAt = before(30 * DAY - MINUTE);
    await c.retiredAt(old, oldAt);
    await c.retiredAt(young, youngAt);
    // A held fork of the old card: it keeps working with no parent.
    const fork = await c.fork(old, user);

    await c.run(RETIRE_CARDS, NOW);
    expect(await c.cardExists(old)).toBe(false);
    expect(await c.answerCount(old)).toBe(0);
    expect((await c.card(fork))!.parent).toBeNull();
    expect(await c.cardExists(young)).toBe(true);
    expect(await c.answerCount(young)).toBe(2);
    expect((await c.card(young))!.retiredAt).toEqual(youngAt);

    await c.run(RETIRE_CARDS, NOW);
    expect(await c.cardExists(old)).toBe(false);
    expect(await c.cardExists(fork)).toBe(true);
    expect(await c.answerCount(young)).toBe(2);
    expect((await c.card(young))!.retiredAt).toEqual(youngAt);
    // At its own 30 days the young one goes too.
    await c.run(RETIRE_CARDS, at(NOW, 2 * MINUTE));
    expect(await c.cardExists(young)).toBe(false);
    expect(await c.answerCount(young)).toBe(0);
  });

  it('deletes the answers of a card that a library version, publication request or eval row references, and keeps the card', async () => {
    const user = await b.user();
    const retired = before(31 * DAY);
    const plain = await c.privateCard(user);
    const library = await c.privateCard(user);
    await c.libraryVersion(library);
    const publication = await c.privateCard(user);
    await c.publicationRequest(publication);
    const evalRun = await c.privateCard(user);
    await c.evalRunAnswer(evalRun);
    const raterCard = await c.privateCard(user);
    await c.evalRaterCard(raterCard);
    for (const id of [plain, library, publication, evalRun]) {
      await c.answers(id);
      await c.retiredAt(id, retired);
    }
    await c.retiredAt(raterCard, retired);

    await c.run(RETIRE_CARDS, NOW);

    expect(await c.cardExists(plain)).toBe(false);
    for (const id of [library, publication, evalRun]) {
      expect(await c.cardExists(id), id).toBe(true);
      expect(await c.answerCount(id), id).toBe(0);
    }
    // An eval.rater_cards row protects the card from both steps.
    expect(await c.cardExists(raterCard)).toBe(true);
    expect(await b.exists('SELECT 1 FROM eval.rater_cards WHERE card_id = $1', raterCard)).toBe(
      true,
    );
    // The audit row of the publication request is kept.
    expect(
      await b.exists('SELECT 1 FROM card_publication_requests WHERE card_id = $1', publication),
    ).toBe(true);
  });

  it('keeps a card that was held again during its grace, un-retired and with its answers', async () => {
    const user = await b.user();
    const pastGrace = await c.privateCard(user);
    const inGrace = await c.privateCard(user, 'label');
    await c.answers(pastGrace);
    await c.answers(inGrace);
    await c.retiredAt(pastGrace, before(31 * DAY));
    await c.retiredAt(inGrace, before(10 * DAY));
    await c.hold(user, pastGrace);
    await c.holdLabel(user, inGrace);

    await c.run(RETIRE_CARDS, NOW);
    for (const id of [pastGrace, inGrace]) {
      expect(await c.cardExists(id), id).toBe(true);
      expect((await c.card(id))!.retiredAt, id).toBeNull();
      expect(await c.answerCount(id), id).toBe(2);
    }
    await c.run(RETIRE_CARDS, NOW);
    for (const id of [pastGrace, inGrace]) {
      expect((await c.card(id))!.retiredAt, id).toBeNull();
      expect(await c.answerCount(id), id).toBe(2);
    }
  });
});

// ── house.purge-users ────────────────────────────────────────────────────────────────────────

describe('house.purge-users', () => {
  it('exports the HMAC helper over the normalized email', () => {
    const key = 'k1';
    const expected = createHmac('sha256', key).update('a.b@example.test').digest('hex');
    expect(deletionEmailHmac('a.b@example.test', key)).toBe(expected);
    expect(deletionEmailHmac('  A.B@Example.TEST ', key)).toBe(expected);
    expect(deletionEmailHmac('a.b@example.test', 'k2')).not.toBe(expected);
    expect(deletionEmailHmac('other@example.test', key)).not.toBe(expected);
  });

  it('hard-deletes a user 7 days after deletion, not one minute earlier, and never a live account', async () => {
    const due = await c.deletedUser(before(7 * DAY));
    const early = await c.deletedUser(before(7 * DAY - MINUTE));
    const live = await c.deletedUser(null);
    const restored = await c.deletedUser(before(30 * DAY));
    await h.owner.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [restored.id]);
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(due.id)).toBe(false);
    expect(await c.userExists(early.id)).toBe(true);
    expect(await c.userExists(live.id)).toBe(true);
    expect(await c.userExists(restored.id)).toBe(true);
    expect(ledger.of(due.id)).toHaveLength(1);
    for (const kept of [early, live, restored]) expect(ledger.of(kept.id)).toHaveLength(0);

    await c.run(PURGE_USERS, at(NOW, 2 * MINUTE), c.ledgerDeps(ledger));
    expect(await c.userExists(early.id)).toBe(false);
    expect(ledger.of(early.id)).toHaveLength(1);
  });

  it('appends the ledger entry before the user row disappears, with only the HMAC of the email', async () => {
    const deletedAt = before(8 * DAY);
    const user = await c.deletedUser(deletedAt, 'Mixed.Case+Tag@Example.TEST');
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(user.id)).toBe(false);
    const entries = ledger.of(user.id);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(ledger.userPresent.get(user.id)).toBe(true);
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.emailHmac).toBe(deletionEmailHmac(user.email, LEDGER_KEY));
    expect(entry.emailHmac).toBe(
      createHmac('sha256', LEDGER_KEY).update('mixed.case+tag@example.test').digest('hex'),
    );
    expect(Number.isNaN(Date.parse(entry.deletedAt))).toBe(false);
    // The deletion time: the account's soft-deletion or this run.
    expect([deletedAt.toISOString(), NOW.toISOString()]).toContain(
      new Date(entry.deletedAt).toISOString(),
    );
    const text = JSON.stringify(entry).toLowerCase();
    expect(text).not.toContain('mixed.case');
    expect(text).not.toContain('example.test');
    expect(Object.keys(entry).sort()).toEqual(['deletedAt', 'emailHmac', 'id', 'userId']);
  });

  it('waits for the erasure/backup advisory lock and then purges (R3)', async () => {
    const user = await c.deletedUser(before(8 * DAY));
    const ledger = new FakeLedger(h.owner);
    const holder = await h.owner.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ERASURE_BACKUP_LOCK_KEY]);
      let finished = false;
      const run = c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger)).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(finished, 'the purge waits while a backup holds the lock').toBe(false);
      expect(await c.userExists(user.id)).toBe(true);
      expect(ledger.attempts, 'no tombstone appended while the lock is held').toHaveLength(0);
      await holder.query('SELECT pg_advisory_unlock($1)', [ERASURE_BACKUP_LOCK_KEY]);
      await run;
    } finally {
      holder.release();
    }
    expect(await c.userExists(user.id)).toBe(false);
    expect(ledger.of(user.id)).toHaveLength(1);
    const left = await h.owner.query(
      'SELECT 1 FROM pg_locks WHERE locktype = $1 AND objid = $2 AND granted',
      ['advisory', ERASURE_BACKUP_LOCK_KEY % 2 ** 32],
    );
    expect(left.rowCount, 'the purge released the lock').toBe(0);
  });

  it('keeps the user for the next run when the lock stays held past the wait (R3)', async () => {
    const user = await c.deletedUser(before(8 * DAY));
    const ledger = new FakeLedger(h.owner);
    const holder = await h.owner.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ERASURE_BACKUP_LOCK_KEY]);
      const outcome = await purgeUser(
        h.deps.db,
        { id: user.id, email: user.email, deletedAt: before(8 * DAY) },
        {
          now: NOW,
          emailHmac: (e) => deletionEmailHmac(e, LEDGER_KEY),
          append: (entry) => ledger.append(entry),
          lockWaitMs: 600,
        },
      );
      expect(outcome).toBe('busy');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [ERASURE_BACKUP_LOCK_KEY]);
      holder.release();
    }
    expect(await c.userExists(user.id)).toBe(true);
    expect(ledger.attempts).toHaveLength(0);
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    expect(await c.userExists(user.id)).toBe(false);
  });

  it('defers the hard delete while the ledger is unconfigured', async () => {
    const user = await c.deletedUser(before(8 * DAY));
    const day = utcDay(before(40 * DAY));
    await c.setUsage(day, user.id, 'typesafe', 'enrich', { calls: 2, costUsd: 0.4 });

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(undefined)).catch(() => undefined);
    expect(await c.userExists(user.id)).toBe(true);
    expect(await c.usage(day, user.id, 'typesafe', 'enrich')).toMatchObject({ calls: 2 });
    expect(await c.usage(day, PLATFORM_USER_ID, 'typesafe', 'enrich')).toBeNull();

    // Once the ledger is configured the deferred deletion goes through.
    const ledger = new FakeLedger(h.owner);
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    expect(await c.userExists(user.id)).toBe(false);
    expect(ledger.of(user.id)).toHaveLength(1);
  });

  it('records a disabled reason while users past grace wait for an unconfigured ledger (R2)', async () => {
    const progressOf = async (): Promise<Record<string, unknown> | undefined> => {
      const row = (
        await h.owner.query<{ value: Record<string, Record<string, unknown>> }>(
          "SELECT value FROM settings WHERE key = 'house.progress'",
        )
      ).rows[0];
      return row?.value[PURGE_USERS];
    };
    await h.owner.query(
      `UPDATE users SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
      [before(7 * DAY)],
    );
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(undefined));
    expect((await progressOf())?.['cursor'], 'nobody is due').toBeUndefined();

    const user = await c.deletedUser(before(8 * DAY));
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(undefined));
    expect((await progressOf())?.['cursor']).toEqual({ disabled: 'ledger_unconfigured' });
    await c.run(PURGE_USERS, NOW, { deletionLedger: new FakeLedger(h.owner) });
    expect((await progressOf())?.['cursor'], 'no HMAC key').toEqual({
      disabled: 'ledger_unconfigured',
    });
    expect(await c.userExists(user.id)).toBe(true);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(new FakeLedger(h.owner)));
    expect(await c.userExists(user.id)).toBe(false);
    expect((await progressOf())?.['cursor'], 'configured again').toBeUndefined();
  });

  it('defers the hard delete when the ledger append fails, retrying with the same entry key', async () => {
    const user = await c.deletedUser(before(8 * DAY));
    const failing = new FakeLedger(h.owner, (entry) => entry.userId === user.id);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(failing)).catch(() => undefined);
    expect(await c.userExists(user.id)).toBe(true);
    expect(failing.of(user.id)).toHaveLength(0);
    expect(failing.attempts.filter((entry) => entry.userId === user.id).length).toBeGreaterThan(0);

    const working = new FakeLedger(h.owner);
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(working));
    expect(await c.userExists(user.id)).toBe(false);
    const retried = working.of(user.id);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.id).toBe(failing.attempts.find((entry) => entry.userId === user.id)!.id);
    expect(retried[0]!.emailHmac).toBe(deletionEmailHmac(user.email, LEDGER_KEY));
  });

  it('a failed ledger append leaves the run incomplete with a failure cursor, a clean run clears it (R7)', async () => {
    const progressOf = async (): Promise<Record<string, unknown> | undefined> => {
      const row = (
        await h.owner.query<{ value: Record<string, Record<string, unknown>> }>(
          "SELECT value FROM settings WHERE key = 'house.progress'",
        )
      ).rows[0];
      return row?.value[PURGE_USERS];
    };
    await h.owner.query(
      `UPDATE users SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
      [before(7 * DAY)],
    );
    await c.run(PURGE_USERS, NOW, c.ledgerDeps(new FakeLedger(h.owner)));
    const completedAt = (await progressOf())?.['completedAt'];
    expect(completedAt, 'a clean run completes').toBeDefined();

    const later = at(NOW, HOUR);
    const user = await c.deletedUser(before(8 * DAY));
    await c.run(
      PURGE_USERS,
      later,
      c.ledgerDeps(new FakeLedger(h.owner, (entry) => entry.userId === user.id)),
    );
    expect(await c.userExists(user.id)).toBe(true);
    const failed = await progressOf();
    expect(failed?.['cursor']).toEqual({
      failed: { ledger: 1, db: 0, blocked: 0 },
      at: later.toISOString(),
    });
    expect(failed?.['completedAt'], 'completedAt is not advanced').toBe(completedAt);

    await c.run(PURGE_USERS, at(later, HOUR), c.ledgerDeps(new FakeLedger(h.owner)));
    expect(await c.userExists(user.id)).toBe(false);
    const clean = await progressOf();
    expect(clean?.['cursor']).toBeUndefined();
    expect(clean?.['completedAt']).toBe(at(later, HOUR).toISOString());
  });

  it('folds the user usage into the platform bucket, preserving every total, and drops the attribution', async () => {
    const user = await c.deletedUser(before(8 * DAY));
    const d1 = utcDay(before(41 * DAY));
    const d2 = utcDay(before(42 * DAY));
    await c.setUsage(d1, user.id, 'typesafe', 'match', {
      calls: 3,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1.25,
    });
    await c.setUsage(d2, user.id, 'llm', 'enrich', {
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
    });
    // The platform bucket of the same key already holds spend.
    await c.setUsage(d1, PLATFORM_USER_ID, 'typesafe', 'match', {
      calls: 2,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.75,
    });
    const reservation = await c.reservation({
      day: d1,
      status: 'settled',
      reservedUsd: 0.2,
      userId: user.id,
    });
    const callId = await c.call({
      createdAt: before(41 * DAY),
      reservationId: reservation,
      userId: user.id,
    });
    const totals = await c.usageTotals();
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(user.id)).toBe(false);
    expect(await c.usageTotals()).toEqual(totals);
    expect(await c.usage(d1, PLATFORM_USER_ID, 'typesafe', 'match')).toMatchObject({
      calls: 5,
      inputTokens: 110,
      outputTokens: 55,
    });
    expect((await c.usage(d1, PLATFORM_USER_ID, 'typesafe', 'match'))!.costUsd).toBeCloseTo(2, 8);
    expect(await c.usage(d2, PLATFORM_USER_ID, 'llm', 'enrich')).toMatchObject({
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(await b.exists('SELECT 1 FROM usage_daily WHERE user_id = $1', user.id)).toBe(false);
    // The audit rows survive without the user.
    expect(await c.callExists(callId)).toBe(true);
    expect(await b.exists('SELECT 1 FROM engine_calls WHERE user_id = $1', user.id)).toBe(false);
    expect(await b.exists('SELECT 1 FROM engine_reservations WHERE user_id = $1', user.id)).toBe(
      false,
    );
    expect(await c.reservationRow(reservation)).not.toBeNull();

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    expect(await c.usageTotals()).toEqual(totals);
    expect((await c.usage(d1, PLATFORM_USER_ID, 'typesafe', 'match'))!.costUsd).toBeCloseTo(2, 8);
  });

  it('deletes the waitlist row and unused email-bound invites, and clears the invites the user consumed', async () => {
    const email = 'Pre.Account@Example.TEST';
    const user = await c.deletedUser(before(8 * DAY), email);
    const inviter = await b.user();
    const bystander = await b.user();
    await c.waitlist(email);
    await c.waitlist(`other-${randomUUID()}@example.test`);
    const bound = await c.invite({ createdBy: inviter, email });
    const boundOther = await c.invite({
      createdBy: inviter,
      email: `else-${randomUUID()}@example.test`,
    });
    const unbound = await c.invite({ createdBy: inviter });
    const consumed = await c.invite({
      createdBy: inviter,
      email,
      note: 'welcome',
      usedBy: user.id,
    });
    const consumedByOther = await c.invite({
      createdBy: inviter,
      email: 'keeper@example.test',
      note: 'kept',
      usedBy: bystander,
    });
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(user.id)).toBe(false);
    expect(await c.waitlisted(email)).toBe(false);
    expect(await b.exists('SELECT 1 FROM waitlist')).toBe(true);
    expect(await c.inviteRow(bound)).toBeNull();
    expect(await c.inviteRow(boundOther)).not.toBeNull();
    expect(await c.inviteRow(unbound)).not.toBeNull();
    expect(await c.inviteRow(consumed)).toEqual({ email: null, note: null, usedBy: null });
    expect(await c.inviteRow(consumedByOther)).toEqual({
      email: 'keeper@example.test',
      note: 'kept',
      usedBy: bystander,
    });
  });

  it('removes the account graph and its pending work, leaving the shared feed and article rows', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const article = await w.article([{ feedId: feed, at: new Date() }]);
    await w.read(user, article, new Date());
    const card = await c.privateCard(user);
    await c.hold(user, card);
    const request = await b.analysisRequest(user, feed, article, new Date(), 'pending');
    const pending = await c.outbox({ createdAt: new Date(), userId: user });
    await c.outbox({ createdAt: new Date(), userId: user, deliveredAt: new Date() });
    const other = await b.user();
    const otherPending = await c.outbox({ createdAt: new Date(), userId: other });
    await h.owner.query(`UPDATE users SET deleted_at = $2 WHERE id = $1`, [user, before(9 * DAY)]);
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(user)).toBe(false);
    for (const table of [
      'subscriptions',
      'user_article',
      'feedback_events',
      'user_cards',
      'analysis_requests',
    ]) {
      expect(await b.exists(`SELECT 1 FROM ${table} WHERE user_id = $1`, user), table).toBe(false);
    }
    expect(await c.cardExists(card)).toBe(false);
    expect(await requestExists(request)).toBe(false);
    expect(await c.outboxExists(pending)).toBe(false);
    expect(await c.outboxExists(otherPending)).toBe(true);
    expect(await b.articleExists(article)).toBe(true);
    expect(await b.feedExists(feed)).toBe(true);
  });

  it('keeps a snapshot another user still bookmarks and marks the ones only the user referenced', async () => {
    const owner = await b.user();
    const bystander = await b.user();
    const arrival = before(DAY);
    const shared = await b.saved({ arrival, userId: owner });
    const bystanderFeed = await b.subscribedFeed([bystander]);
    await b.alsoSave(bystander, bystanderFeed, shared.articleId);
    const bystanderSnapshot = (await b.bookmarkOf(bystander, shared.articleId)).snapshotId;
    expect(bystanderSnapshot).toBe(shared.snapshotId);
    const solo = await b.saved({ arrival, userId: owner });
    await h.owner.query(`UPDATE users SET deleted_at = $2 WHERE id = $1`, [owner, before(9 * DAY)]);
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(owner)).toBe(false);
    const kept = await b.snapshot(shared.snapshotId);
    expect(kept).not.toBeNull();
    expect(kept!.unreferenced_at).toBeNull();
    expect((await b.bookmarkOf(bystander, shared.articleId)).snapshotId).toBe(shared.snapshotId);
    const orphan = await b.snapshot(solo.snapshotId);
    expect(orphan).not.toBeNull();
    expect(orphan!.unreferenced_at).not.toBeNull();
  });

  it('refreshes the subscriber counts of the feeds the user left', async () => {
    const leaving = await b.user();
    const staying = await b.user();
    const shared = await b.subscribedFeed([leaving, staying]);
    const alone = await b.subscribedFeed([leaving]);
    expect(await c.subscriberCount(shared)).toBe(2);
    expect(await c.subscriberCount(alone)).toBe(1);
    await h.owner.query(`UPDATE users SET deleted_at = $2 WHERE id = $1`, [
      leaving,
      before(9 * DAY),
    ]);
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(leaving)).toBe(false);
    expect(await c.subscriberCount(shared)).toBe(1);
    expect(await c.subscriberCount(alone)).toBe(0);
    const idle = await b.rows<{ unsubscribed_at: Date | null }>(
      `SELECT unsubscribed_at FROM feeds WHERE id = $1`,
      [alone],
    );
    expect(idle[0]!.unsubscribed_at).not.toBeNull();
  });

  it('changes nothing on a second run and writes one ledger entry per user', async () => {
    const user = await c.deletedUser(before(10 * DAY));
    const feed = await b.subscribedFeed([user.id]);
    const day = utcDay(before(45 * DAY));
    await c.setUsage(day, user.id, 'laya', 'cluster', { calls: 2, costUsd: 0.2 });
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    const totals = await c.usageTotals();
    const count = ledger.entries.length;
    const platform = await c.usage(day, PLATFORM_USER_ID, 'laya', 'cluster');
    const subscribers = await c.subscriberCount(feed);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    expect(ledger.entries.length).toBe(count);
    expect(ledger.of(user.id)).toHaveLength(1);
    expect(await c.usageTotals()).toEqual(totals);
    expect(await c.usage(day, PLATFORM_USER_ID, 'laya', 'cluster')).toEqual(platform);
    expect(await c.subscriberCount(feed)).toBe(subscribers);
    expect(new Set(ledger.entries.map((entry) => entry.id)).size).toBe(ledger.entries.length);
  });

  it('nulls creatorUserId in the publication evidence and nothing else, once', async () => {
    const creator = await c.deletedUser(before(10 * DAY));
    const card = await c.sharedCard(creator.id);
    await c.publicationRequest(card);
    const evidence = {
      policyVersion: 1,
      creatorUserId: creator.id,
      cardTextHash: 'hash-x',
      publicationSha: 'sha-x',
      requestVersion: '1',
      respondedAt: before(20 * DAY).toISOString(),
      approvedVersion: '1',
    };
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('bantoozi.card_promotion', $1, true)`, [card]);
      await client.query(`SELECT set_config('bantoozi.card_publication_response', $1, true)`, [
        card,
      ]);
      await client.query(
        `UPDATE card_publication_requests
            SET status = 'promoted', responded_at = $2, authorization_kind = 'creator_approval',
                authorization_evidence = $3::jsonb, promoted_at = $2
          WHERE card_id = $1`,
        [card, before(20 * DAY), JSON.stringify(evidence)],
      );
      await client.query(`UPDATE interest_cards SET visibility = 'public' WHERE id = $1`, [card]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const read = () =>
      b.rows<{ user_id: string | null; status: string; evidence: Record<string, unknown> }>(
        `SELECT user_id::text, status, authorization_evidence AS evidence
           FROM card_publication_requests WHERE card_id = $1`,
        [card],
      );
    expect((await read())[0]!.evidence['creatorUserId']).toBe(creator.id);
    const ledger = new FakeLedger(h.owner);

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));

    expect(await c.userExists(creator.id)).toBe(false);
    const after = await read();
    expect(after).toHaveLength(1);
    expect(after[0]!.user_id).toBeNull();
    expect(after[0]!.status).toBe('promoted');
    expect(after[0]!.evidence).toEqual({ ...evidence, creatorUserId: null });

    await c.run(PURGE_USERS, NOW, c.ledgerDeps(ledger));
    expect(await read()).toEqual(after);
  });
});
