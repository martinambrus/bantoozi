import {
  claimMatchRows,
  completeMatchRows,
  recoverMatchQueue,
  releaseMatchRows,
  renewMatchLease,
  resetArticleAnswers,
  retryTransaction,
  updateFacetFeatures,
  workerOutbox,
  type MatchClaim,
} from '@bantoozi/db';
import { MATCH_V1, dynamicQuestionSet, type ChoiceAnswer } from '@bantoozi/questions';
import type * as Questions from '@bantoozi/questions';
import { matchCoverage, type RankCard } from '@bantoozi/ranker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFILTER_MIN_CARDS } from '../src/handlers/article-match.js';
import type { ClassificationDeps } from '../src/handlers/deps.js';
import {
  ClassifyHarness,
  DAY,
  LLM_MODEL,
  MINUTE,
  NO_BRANCH_TOPICS,
  PRIMARY_MODEL,
  failure,
  forArticles,
  waitFor,
  witnessesOf,
  type SettingWrite,
} from './support/classify.js';

/**
 * M2-T9 `article.enrich` and `article.match` (spec 05 §3, §5.5; spec 04 §5) through the real
 * handlers, a migrated and seeded database and a scripted router that rechecks every request's
 * authorization like the real one.
 */

/** A second match set the worker's code knows, so a test can switch the active set. */
const MATCH_V2_VERSION = 'match-v2-test';

vi.mock('@bantoozi/questions', async (importOriginal) => {
  const original = await importOriginal<typeof Questions>();
  const v2 = original.dynamicQuestionSet({
    ...original.MATCH_V1.definition,
    version: 'match-v2-test',
    note: 'second match set of the enrich and match integration test',
  });
  return {
    ...original,
    questionSetByVersion: (version: string) =>
      version === v2.version ? v2 : original.questionSetByVersion(version),
  };
});

let h: ClassifyHarness;

const byId = (a: string, b: string): number => Number(a) - Number(b);
const sorted = (ids: readonly string[]): string[] => [...ids].sort(byId);
/** A card interest whose question cannot fit a request even alone (spec 05 §5.2). */
const oversizedInterest = (topic: string): string =>
  `${topic}: ${'Solid-state battery chemistry and pilot production lines. '.repeat(3_000)}`;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

/** An active reader of a new feed holding `cards` shared cards, and an article of that feed. */
async function scenario(options: { cards?: number; state?: string } = {}) {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const cardIds: string[] = [];
  for (let i = 0; i < (options.cards ?? 2); i += 1) {
    cardIds.push(await h.heldCard(userId, { topicIds: ['technology'] }));
  }
  const articleId = await h.article({
    feedIds: [feedId],
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  return { feedId, userId, cardIds, articleId };
}

/**
 * Two active readers of a new feed, each holding one private card, and an enriched article of that
 * feed without level-2 branches: matching it takes two packs (one per owner).
 */
async function twoPrivatePacks() {
  const feedId = await h.feed();
  const users = [await h.user(), await h.user()].sort();
  for (const userId of users) {
    await h.subscribe(userId, feedId, 'active');
    await h.hold(userId, await h.card({ visibility: 'private', ownerUserId: userId }));
  }
  const articleId = await h.article({ feedIds: [feedId] });
  h.router.topics = NO_BRANCH_TOPICS;
  await h.dispatch('article.enrich', { articleId });
  await h.clearOutbox();
  return { articleId, users };
}

/** Fails when `promise` does not settle within `ms` (a claim that waits on a row lock). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const expireLeases = (articleId: string) =>
  h.owner.query(
    `UPDATE match_queue SET lease_until = now() - interval '1 second'
      WHERE article_id = $1 AND lease_token IS NOT NULL`,
    [articleId],
  );

/** Store the second match set (once) and return its id. */
async function storeMatchV2(): Promise<string> {
  const v2 = dynamicQuestionSet({
    ...MATCH_V1.definition,
    version: MATCH_V2_VERSION,
    note: 'second match set of the enrich and match integration test',
  });
  await h.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING`,
    [v2.version, v2.sha256, JSON.stringify(v2.definition)],
  );
  const found = await h.owner.query<{ id: string }>(
    `SELECT id::text AS id FROM question_sets WHERE kind = 'match' AND version = $1`,
    [v2.version],
  );
  return found.rows[0]?.id as string;
}

const makeDue = (articleId: string) =>
  h.owner.query('UPDATE match_queue SET next_attempt_at = now() WHERE article_id = $1', [
    articleId,
  ]);

const letGo = (userId: string, cardId: string) =>
  h.owner.query('DELETE FROM user_cards WHERE user_id = $1 AND card_id = $2', [userId, cardId]);

/**
 * Until the returned cleanup runs, every write to the leased queue row of `cardId` (a lease renewal
 * or a deletion) first gives `userId` their holding of that card back, in the writing transaction:
 * demand that returns as a job drops the pair. A new holder's backfill that queues the pair again at
 * the same revision keeps the job's lease, so the job's own row is all that is left of that work.
 */
async function holdingReturnsOnWrite(userId: string, cardId: string): Promise<() => Promise<void>> {
  await h.owner.query(`
    CREATE FUNCTION test_holding_returns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    BEGIN
      INSERT INTO user_cards (user_id, card_id, strength)
      VALUES ('${userId}'::uuid, ${Number(cardId)}, 'like') ON CONFLICT DO NOTHING;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  await h.owner.query(`
    CREATE TRIGGER test_holding_returns BEFORE UPDATE OR DELETE ON match_queue FOR EACH ROW
      WHEN (OLD.card_id = ${Number(cardId)} AND OLD.lease_token IS NOT NULL)
      EXECUTE FUNCTION test_holding_returns()`);
  return async () => {
    await h.owner.query('DROP TRIGGER test_holding_returns ON match_queue');
    await h.owner.query('DROP FUNCTION test_holding_returns()');
  };
}

describe('article.enrich outcomes (spec 05 §3, spec 04 §5)', () => {
  it('writes current facets, moves to enriched, queues the admitted cards and records cluster + match', async () => {
    const s = await scenario();
    const since = await h.mark();
    await h.dispatch('article.enrich', { articleId: s.articleId });

    const asks = h.router.asksFor(s.articleId);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: 'enrich',
      priority: 'interactive',
      articleRevision: '1',
      authorized: true,
    });
    expect(witnessesOf(asks)).toEqual({ users: [s.userId], requests: [] });
    expect(await h.facetRow(s.articleId)).toMatchObject({
      revision: '1',
      engine: 'typesafe',
      model: PRIMARY_MODEL,
      variant: 'native',
      stateSha256: asks[0]?.request.stateSha256,
    });
    expect(await h.articleRow(s.articleId)).toMatchObject({
      state: 'enriched',
      enrichEngine: 'typesafe',
    });
    const rows = await h.queueRows(s.articleId);
    expect(rows.map((row) => row.cardId)).toEqual(sorted(s.cardIds));
    expect(rows.every((row) => row.priority === 5 && row.revision === '1')).toBe(true);
    expect(await h.payloads('article.cluster', since)).toEqual([{ articleId: s.articleId }]);
    expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
  });

  it.each(['budget', 'circuit_open', 'no_key'] as const)(
    'an unavailable engine (%s) degrades the article and ranks every carrier subscriber',
    async (reason) => {
      const s = await scenario();
      const off = await h.user();
      await h.subscribe(off, s.feedId, 'off');
      const otherFeed = await h.feed();
      const trainee = await h.user();
      await h.subscribe(trainee, otherFeed, 'training');
      await h.carry(otherFeed, s.articleId);
      h.router.respond = () => failure(reason);

      const since = await h.mark();
      await h.dispatch('article.enrich', { articleId: s.articleId });

      expect(h.router.asksFor(s.articleId)).toHaveLength(1);
      expect(await h.articleRow(s.articleId)).toMatchObject({
        state: 'degraded',
        enrichEngine: null,
      });
      expect(await h.facetRow(s.articleId)).toBeNull();
      expect(await h.queueRows(s.articleId)).toEqual([]);
      const ranked = (await h.payloads('user.rank', since)).sort((a, b) =>
        String(a['userId']).localeCompare(String(b['userId'])),
      );
      expect(ranked).toEqual(
        [s.userId, off, trainee].sort().map((userId) => ({ userId, reason: 'degraded' })),
      );
      expect(await h.payloads('article.match', since)).toEqual([]);
      expect(await h.payloads('article.cluster', since)).toEqual([]);
    },
  );

  it('a language-mode switch committing while the facets are written discards them and asks again', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId], lang: 'sk' });
    const modes = (await h.setting('language_modes')) as Record<string, string>;
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async (ask) => {
      if (ask.kind === 'enrich') {
        write ??= h.openSettingWrite('language_modes', { ...modes, sk: 'translate' });
        await write;
      }
      return undefined;
    };
    const since = await h.mark();
    try {
      const run = h.dispatch('article.enrich', { articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      expect(await h.facetRow(articleId)).toBeNull();
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'extracted' });
      expect(await h.payloads('article.enrich', since)).toEqual([
        { articleId, priority: 'interactive' },
      ]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('language_modes', modes);
    }
  });

  it('a language-mode switch committing while a cached Call A continues sends the job again', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId], lang: 'sk' });
    // A cache fill left current primary facets of the native input.
    await h.enrichDirect(articleId, { state: 'extracted' });
    const modes = (await h.setting('language_modes')) as Record<string, string>;
    // Written but not committed: the job's snapshot still reads the native mode.
    const write = await h.openSettingWrite('language_modes', { ...modes, sk: 'translate' });
    const since = await h.mark();
    try {
      const run = h.dispatch('article.enrich', { articleId });
      await write.commit();
      await run;
      expect(h.router.asks).toEqual([]);
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'extracted' });
      expect(await h.payloads('article.enrich', since)).toEqual([
        { articleId, priority: 'interactive' },
      ]);
      expect(await h.payloads('article.match', since)).toEqual([]);
    } finally {
      write.close();
      await h.setSetting('language_modes', modes);
    }
  });

  it('a language-mode switch committing while an invalid request is recorded sends the job again', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId], lang: 'sk' });
    const modes = (await h.setting('language_modes')) as Record<string, string>;
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async (ask) => {
      if (ask.kind !== 'enrich') return undefined;
      write ??= h.openSettingWrite('language_modes', { ...modes, sk: 'translate' });
      await write;
      return failure('invalid_request');
    };
    const since = await h.mark();
    try {
      const run = h.dispatch('article.enrich', { articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      // The old request's rejection does not fail the article: the job asks again.
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'extracted' });
      expect(await h.payloads('article.enrich', since)).toEqual([
        { articleId, priority: 'interactive' },
      ]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('language_modes', modes);
    }
  });

  it('a match-set switch during Call A builds the features from the new set’s level-2 answers', async () => {
    const s = await scenario({ cards: 0 });
    const v2 = await storeMatchV2();
    const active = (await h.setting('question_sets.active')) as Record<string, string>;
    h.router.respond = async (ask) => {
      if (ask.kind !== 'enrich') return undefined;
      // Meanwhile the second set becomes active and a cache fill writes its level-2 answers.
      await h.setSetting('question_sets.active', { ...active, match: v2 });
      await h.answerL2(s.articleId, 'technology', { engine: 'typesafe' });
      await h.answerL2(s.articleId, 'science', { engine: 'typesafe' });
      return undefined;
    };
    try {
      await h.dispatch('article.enrich', { articleId: s.articleId });
      expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
      const answered = { 't2_asked.technology': 1, 't2_asked.science': 1 };
      expect((await h.facetRow(s.articleId))?.features).toMatchObject(answered);

      // The match job finds both branches answered: it asks nothing and refreshes nothing.
      h.router.respond = undefined;
      await h.run('article.match', forArticles(s.articleId));
      expect(h.router.asksFor(s.articleId, 'match')).toEqual([]);
      expect((await h.facetRow(s.articleId))?.features).toMatchObject(answered);
    } finally {
      h.router.respond = undefined;
      await h.setSetting('question_sets.active', active);
    }
  });

  it('an invalid request fails the article; a failed recovery never downgrades an enriched one', async () => {
    const s = await scenario();
    h.router.respond = () => failure('invalid_request');
    await h.dispatch('article.enrich', { articleId: s.articleId });
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'failed' });
    expect(await h.facetRow(s.articleId)).toBeNull();

    // Enriched by the LLM fallback; the bulk recovery retry finds Jev unavailable.
    const t = await scenario();
    await h.enrichDirect(t.articleId, { engine: 'llm', model: LLM_MODEL });
    h.router.respond = () => failure('circuit_open');
    const since = await h.mark();
    await h.dispatch('article.enrich', { articleId: t.articleId, priority: 'bulk' });
    expect(h.router.asksFor(t.articleId)[0]?.priority).toBe('bulk');
    expect(await h.articleRow(t.articleId)).toMatchObject({
      state: 'enriched',
      enrichEngine: 'llm',
    });
    expect((await h.facetRow(t.articleId))?.engine).toBe('llm');
    expect(await h.payloads('user.rank', since)).toEqual([]);
  });

  it('reuses a current primary answer for the same input without a call; a fallback answer is re-asked', async () => {
    // A selected request filled the cache before automatic enrichment ran.
    const s = await scenario();
    await h.enrichDirect(s.articleId, { state: 'extracted' });
    const since = await h.mark();
    await h.dispatch('article.enrich', { articleId: s.articleId });
    expect(h.router.asks).toEqual([]);
    expect(await h.articleRow(s.articleId)).toMatchObject({
      state: 'enriched',
      enrichEngine: 'typesafe',
    });
    expect((await h.queueRows(s.articleId)).map((row) => row.cardId)).toEqual(sorted(s.cardIds));
    expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);

    // A late duplicate changes nothing.
    const again = await h.mark();
    await h.dispatch('article.enrich', { articleId: s.articleId });
    expect(h.router.asks).toEqual([]);
    expect(await h.payloads('article.match', again)).toEqual([]);

    // An LLM answer of the same input is provisional: Call A is asked.
    const t = await scenario();
    await h.enrichDirect(t.articleId, { engine: 'llm', model: LLM_MODEL, state: 'extracted' });
    await h.dispatch('article.enrich', { articleId: t.articleId });
    expect(h.router.asksFor(t.articleId, 'enrich')).toHaveLength(1);
    expect(await h.facetRow(t.articleId)).toMatchObject({
      engine: 'typesafe',
      model: PRIMARY_MODEL,
    });
  });

  it('asks nothing without live demand: off, untrained or pre-activation arrivals only', async () => {
    const feedId = await h.feed();
    const off = await h.user();
    await h.subscribe(off, feedId, 'off');
    const trainee = await h.user();
    await h.subscribe(trainee, feedId, 'training');
    const articleId = await h.article({ feedIds: [feedId] });
    // Active only since now: the article arrived an hour before activation (a hidden backlog).
    const late = await h.user();
    await h.subscribe(late, feedId, 'active', new Date());
    await h.heldCard(late);

    const since = await h.mark();
    await h.dispatch('article.enrich', { articleId });
    expect(h.router.asks).toEqual([]);
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'extracted' });
    expect(await h.payloads('user.rank', since)).toEqual([]);
  });
});

describe('article.match leases (spec 05 §5.5 steps 1, 6)', () => {
  it('claims with SKIP LOCKED: concurrent claims split the rows and a locked row is skipped', async () => {
    const s = await scenario({ cards: 10 });
    await h.queue(s.articleId, s.cardIds);
    const [a, b] = await Promise.all([
      claimMatchRows(h.db, s.articleId, { leaseMs: 60_000, limit: 5 }),
      claimMatchRows(h.db, s.articleId, { leaseMs: 60_000, limit: 5 }),
    ]);
    const idsOf = (claim: MatchClaim | null) => (claim?.rows ?? []).map((row) => row.cardId);
    expect(idsOf(a)).toHaveLength(5);
    expect(idsOf(b)).toHaveLength(5);
    expect(sorted([...idsOf(a), ...idsOf(b)])).toEqual(sorted(s.cardIds));
    expect(a?.leaseToken).not.toBe(b?.leaseToken);
    for (const row of await h.queueRows(s.articleId)) {
      expect(row.leaseToken).toBe(idsOf(a).includes(row.cardId) ? a?.leaseToken : b?.leaseToken);
      expect(row.leased).toBe(true);
    }
    // Live leases: nothing is claimable.
    expect((await claimMatchRows(h.db, s.articleId, { leaseMs: 60_000 }))?.rows).toEqual([]);

    // A row another transaction holds locked is skipped, never waited for.
    const t = await scenario({ cards: 4 });
    await h.queue(t.articleId, t.cardIds);
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT 1 FROM match_queue WHERE article_id = $1 AND card_id = ANY($2::bigint[]) FOR UPDATE',
        [t.articleId, t.cardIds.slice(0, 2)],
      );
      const claim = await within(claimMatchRows(h.db, t.articleId, { leaseMs: 60_000 }), 5_000);
      expect(sorted(idsOf(claim))).toEqual(sorted(t.cardIds.slice(2)));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const rest = await claimMatchRows(h.db, t.articleId, { leaseMs: 60_000 });
    expect(sorted(idsOf(rest))).toEqual(sorted(t.cardIds.slice(0, 2)));
  });

  it('reclaims an expired lease; the old lease can no longer renew, complete or release the rows', async () => {
    const s = await scenario({ cards: 3 });
    await h.queue(s.articleId, s.cardIds);
    const first = await claimMatchRows(h.db, s.articleId, { leaseMs: 60_000 });
    expect(first?.rows).toHaveLength(3);
    await expireLeases(s.articleId);
    const second = await claimMatchRows(h.db, s.articleId, { leaseMs: 60_000 });
    expect(sorted((second?.rows ?? []).map((row) => row.cardId))).toEqual(sorted(s.cardIds));
    expect(second?.leaseToken).not.toBe(first?.leaseToken);

    const stale = first as MatchClaim;
    expect(await renewMatchLease(h.db, s.articleId, stale.leaseToken, 60_000)).toBe(false);
    await retryTransaction(h.db, async (tx) => {
      expect(
        await completeMatchRows(tx, {
          articleId: s.articleId,
          revision: stale.revision,
          leaseToken: stale.leaseToken,
          cardIds: s.cardIds,
        }),
      ).toEqual([]);
      expect(
        await releaseMatchRows(tx, {
          articleId: s.articleId,
          leaseToken: stale.leaseToken,
          cardIds: s.cardIds,
          release: { kind: 'exhaust', lastError: 'invalid_request' },
        }),
      ).toBe(0);
    });
    const rows = await h.queueRows(s.articleId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ leaseToken: second?.leaseToken, leased: true, attempts: 0 });
    }
  });

  it('a job whose lease was reclaimed during the call writes nothing and leaves the new owner its rows', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    let reclaimed: MatchClaim | null = null;
    h.router.respond = async () => {
      // Another worker takes over after this job's lease expired while the provider was slow.
      await expireLeases(s.articleId);
      reclaimed = await claimMatchRows(h.db, s.articleId, { leaseMs: 60_000 });
      return undefined;
    };
    await h.dispatch('article.match', { articleId: s.articleId });

    expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
    const owner = reclaimed as MatchClaim | null;
    expect(owner?.rows).toHaveLength(2);
    expect(await h.cardAnswers(s.articleId)).toEqual([]);
    const rows = await h.queueRows(s.articleId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ leaseToken: owner?.leaseToken, leased: true, attempts: 0 });
    }
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
  });

  it('after a partial reclaim a job answers only the rows it still holds', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    let reclaimed: MatchClaim | null = null;
    h.router.respond = async () => {
      // Another worker reclaims one of the two expired rows while the provider is slow.
      await expireLeases(s.articleId);
      reclaimed = await claimMatchRows(h.db, s.articleId, { leaseMs: 60_000, limit: 1 });
      return undefined;
    };
    await h.dispatch('article.match', { articleId: s.articleId });

    expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
    const owner = reclaimed as MatchClaim | null;
    expect(owner?.rows).toHaveLength(1);
    const taken = owner?.rows[0]?.cardId;
    const kept = s.cardIds.find((id) => id !== taken);
    expect((await h.cardAnswers(s.articleId)).map((a) => a.cardId)).toEqual([kept]);
    const rows = await h.queueRows(s.articleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cardId: taken,
      leaseToken: owner?.leaseToken,
      leased: true,
      attempts: 0,
    });
  });

  it('a pack transaction replayed after a deadlock still answers and completes the rows it holds', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    // The pack's first rank intent deadlocks once, after its answers and completions: the whole
    // transaction rolls back and runs again (a sequence is not rolled back, so the replay passes).
    await h.owner.query('CREATE SEQUENCE test_deadlock_once');
    await h.owner.query(`
      CREATE FUNCTION test_deadlock_once() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      BEGIN
        IF nextval('test_deadlock_once') = 1 THEN
          RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $$`);
    await h.owner.query(`
      CREATE TRIGGER test_deadlock_once BEFORE INSERT ON job_outbox FOR EACH ROW
        WHEN (NEW.queue = 'user.rank') EXECUTE FUNCTION test_deadlock_once()`);
    try {
      const since = await h.mark();
      await h.dispatch('article.match', { articleId: s.articleId });
      expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
      expect(sorted((await h.cardAnswers(s.articleId)).map((a) => a.cardId))).toEqual(
        sorted(s.cardIds),
      );
      expect(await h.queueRows(s.articleId)).toEqual([]);
      expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'matched' });
      expect(await h.payloads('user.rank', since)).toEqual([{ userId: s.userId, reason: 'match' }]);
      // The deadlock did fire, and the pack's transaction ran again.
      const inserts = await h.owner.query<{ n: string }>(
        'SELECT last_value AS n FROM test_deadlock_once',
      );
      expect(Number(inserts.rows[0]?.n)).toBeGreaterThan(1);
    } finally {
      await h.owner.query('DROP TRIGGER test_deadlock_once ON job_outbox');
      await h.owner.query('DROP FUNCTION test_deadlock_once()');
      await h.owner.query('DROP SEQUENCE test_deadlock_once');
    }
  });

  it('a reset during the call discards the answers; rows without current facets are released unasked', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId);
    await h.queue(s.articleId, s.cardIds);
    h.router.respond = async (ask) => {
      if (ask.kind !== 'match') return undefined;
      await retryTransaction(h.db, (tx) =>
        resetArticleAnswers(tx, workerOutbox(tx), s.articleId, {
          reason: 'source_changed',
          nextState: 'extracted',
          keepBody: true,
        }),
      );
      return undefined;
    };
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
    expect(await h.cardAnswers(s.articleId)).toEqual([]);
    expect(await h.l2Rows(s.articleId)).toEqual([]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ revision: '2', state: 'extracted' });
    const requeued = (await h.queueRows(s.articleId)).map((row) => [
      row.cardId,
      row.revision,
      row.leased,
      row.attempts,
    ]);
    expect(requeued).toEqual(sorted(s.cardIds).map((id) => [id, '2', false, 0]));

    // The new revision has rows but no facets yet: matching waits and releases them unasked.
    h.router.respond = undefined;
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
    const released = await h.queueRows(s.articleId);
    expect(released.map((row) => [row.revision, row.leased, row.attempts])).toEqual([
      ['2', false, 0],
      ['2', false, 0],
    ]);
  });

  it('a configuration change during the call discards the pack and enqueues current work', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    h.router.respond = async () => {
      await h.setSetting('card_text_mode', 'english');
      return undefined;
    };
    try {
      const since = await h.mark();
      await h.dispatch('article.match', { articleId: s.articleId });
      expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(1);
      expect(await h.cardAnswers(s.articleId)).toEqual([]);
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due])).toEqual([
        [false, 0, true],
        [false, 0, true],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    } finally {
      await h.setSetting('card_text_mode', 'as_written');
    }
  });
});

describe('article.match completion fence (spec 05 §5.5 step 6)', () => {
  it('a configuration switch committing while the pack completes discards it and enqueues current work', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openSettingWrite('card_text_mode', 'english');
      await write;
      return undefined;
    };
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      expect(await h.cardAnswers(s.articleId)).toEqual([]);
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due])).toEqual([
        [false, 0, true],
        [false, 0, true],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('a configuration switch committing while a rejected pack is released keeps its rows for current work', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openSettingWrite('card_text_mode', 'english');
      await write;
      return failure('invalid_request');
    };
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      // Not exhausted by the old questions' rejection: due again, without an attempt.
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due, row.lastError])).toEqual([
        [false, 0, true, null],
        [false, 0, true, null],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('a configuration switch committing while a failed level-2 pack schedules its retry leaves it to current work', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId] });
    await h.dispatch('article.enrich', { articleId });
    await h.clearOutbox();
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openSettingWrite('card_text_mode', 'english');
      await write;
      return failure('error');
    };
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      // No delayed retry counting the old questions' failure: one current job, due now.
      const intents = await h.intents('article.match', { since });
      expect(intents.map((intent) => intent.payload)).toEqual([{ articleId }]);
      expect(intents[0]?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('a configuration switch committing while satisfied rows complete keeps them queued for current work', async () => {
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    // A cache fill already answered both pairs for this input.
    for (const cardId of s.cardIds) {
      await h.answerCard(s.articleId, cardId, { engine: 'typesafe' });
    }
    const answers = await h.cardAnswers(s.articleId);
    // Written but not committed: the job's snapshot still finds both pairs satisfied.
    const write = await h.openSettingWrite('card_text_mode', 'english');
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      await write.commit();
      await run;
      expect(h.router.asksFor(s.articleId, 'match')).toEqual([]);
      expect(await h.cardAnswers(s.articleId)).toEqual(answers);
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due])).toEqual([
        [false, 0, true],
        [false, 0, true],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
      expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
    } finally {
      write.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('a configuration switch committing while an oversized question is exhausted keeps its row for current work', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    // Under the snapshot this question would be exhausted as an invalid request.
    const cardId = await h.heldCard(userId, {
      topicIds: ['technology'],
      interest: oversizedInterest('Fenced'),
    });
    const articleId = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(articleId, [cardId]);
    // Written but not committed: the job's snapshot still has the old card text mode.
    const write = await h.openSettingWrite('card_text_mode', 'english');
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId });
      await write.commit();
      await run;
      expect(h.router.asksFor(articleId, 'match')).toEqual([]);
      // Not exhausted by the old question: due again, without an attempt.
      const rows = await h.queueRows(articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due, row.lastError])).toEqual([
        [false, 0, true, null],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId }]);
    } finally {
      write.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('a prefilter switch committing while its markers are written discards them and asks nothing', async () => {
    await h.setSetting('engine.prefilter_enabled', true);
    let write: SettingWrite | undefined;
    try {
      const feedId = await h.feed();
      const userId = await h.user();
      await h.subscribe(userId, feedId, 'active');
      const cardIds: string[] = [];
      for (let i = 0; i <= PREFILTER_MIN_CARDS; i += 1) {
        cardIds.push(await h.heldCard(userId, { topicIds: ['sports.football'] }));
      }
      const articleId = await h.article({ feedIds: [feedId] });
      await h.enrichDirect(articleId, { topics: NO_BRANCH_TOPICS });
      await h.queue(articleId, cardIds);
      // Written but not committed: the job's snapshot still has the prefilter enabled.
      write = await h.openSettingWrite('engine.prefilter_enabled', false);
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId });
      await write.commit();
      await run;
      expect(await h.cardAnswers(articleId)).toEqual([]);
      expect(h.router.asksFor(articleId, 'match')).toEqual([]);
      const rows = await h.queueRows(articleId);
      expect(rows).toHaveLength(cardIds.length);
      expect(rows.every((row) => !row.leased && row.attempts === 0 && row.due)).toBe(true);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId }]);
    } finally {
      write?.close();
      await h.setSetting('engine.prefilter_enabled', false);
    }
  });

  it('the first write of a compared setting committing while the pack completes is fenced too', async () => {
    // Never written: readers use its default (off), and there is no row to lock.
    await h.deleteSetting('engine.prefilter_enabled');
    const s = await scenario({ cards: 2 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openSettingWrite('engine.prefilter_enabled', true);
      await write;
      return undefined;
    };
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      expect(await h.cardAnswers(s.articleId)).toEqual([]);
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((row) => [row.leased, row.attempts, row.due])).toEqual([
        [false, 0, true],
        [false, 0, true],
      ]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('engine.prefilter_enabled', false);
    }
  });

  it('rebuilds level-2 features from facet answers an analysis fill replaces during the call', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId] });
    // Fallback facets that select two branches: the match job asks level-2 questions only.
    await h.enrichDirect(articleId, { engine: 'llm', model: LLM_MODEL });
    const fallback = await h.facetRow(articleId);
    const topic = fallback!.answers['topic_l1'] as ChoiceAnswer;
    // A selected request's primary Call A for the same input replaces them (fill mode).
    const answers = {
      ...fallback!.answers,
      topic_l1: { ...topic, probabilities: { ...topic.probabilities, technology: 0.85 } },
    };
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openWrite(
        `UPDATE article_facets SET engine = 'typesafe', model = $3, answers = $4::jsonb,
                updated_at = now()
          WHERE article_id = $1 AND question_set_id = $2`,
        [articleId, h.sets.enrich, PRIMARY_MODEL, JSON.stringify(answers)],
      );
      await write;
      return undefined;
    };
    try {
      const run = h.dispatch('article.match', { articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      expect(h.router.asksFor(articleId, 'match').map((ask) => [...ask.l2].sort())).toEqual([
        ['science', 'technology'],
      ]);
      const facets = await h.facetRow(articleId);
      expect(facets).toMatchObject({ engine: 'typesafe', model: PRIMARY_MODEL, answers });
      // The features belong to the replaced answers, with the job's level-2 answers.
      expect(facets?.features['t1.technology']).toBe(0.85);
      expect(facets?.features['t2_asked.technology']).toBe(1);
      // The update fence itself refuses features built from the replaced answers.
      const stale = await h.db.transaction((tx) =>
        updateFacetFeatures(tx, {
          articleId,
          questionSetId: h.sets.enrich,
          articleRevision: fallback!.revision,
          stateSha256: fallback!.stateSha256,
          engine: fallback!.engine,
          model: fallback!.model,
          answers: fallback!.answers,
          features: { stale: 1 },
        }),
      );
      expect(stale).toBe(false);
      expect((await h.facetRow(articleId))?.features).toEqual(facets?.features);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
    }
  });

  it('a configuration switch committing before the article state is written leaves it to current work', async () => {
    const s = await scenario({ cards: 0 });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    const write = await h.openSettingWrite('card_text_mode', 'english');
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      await write.commit();
      await run;
      expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
      expect(await h.payloads('user.rank', since)).toEqual([]);
    } finally {
      write.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
    // The current job decides the state.
    await h.run('article.match', forArticles(s.articleId));
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'matched' });
  });
});

describe('article.match packs (spec 05 §5.2, §5.5 steps 2–5)', () => {
  it('packs a private card only with its owner’s private cards; shared work is attributed to nobody', async () => {
    const feedId = await h.feed();
    const u1 = await h.user();
    const u2 = await h.user();
    await h.subscribe(u1, feedId, 'active');
    await h.subscribe(u2, feedId, 'active');
    const p1a = await h.card({ visibility: 'private', ownerUserId: u1 });
    const p1b = await h.card({ visibility: 'private', ownerUserId: u1 });
    const p2 = await h.card({ visibility: 'private', ownerUserId: u2 });
    for (const id of [p1a, p1b]) await h.hold(u1, id);
    await h.hold(u2, p2);
    const shared = await h.card();
    await h.hold(u1, shared);
    await h.hold(u2, shared);
    const articleId = await h.article({ feedIds: [feedId] });

    await h.dispatch('article.enrich', { articleId });
    await h.run('article.match', forArticles(articleId));

    const packs = h.router
      .asksFor(articleId, 'match')
      .map((ask) => ({
        cards: sorted(ask.cards),
        l2: [...ask.l2].sort(),
        userId: ask.userId,
        users: witnessesOf([ask]).users,
      }))
      .sort((x, y) => byId(x.cards[0] ?? '0', y.cards[0] ?? '0'));
    expect(packs).toEqual(
      [
        { cards: sorted([p1a, p1b]), l2: [], userId: u1, users: [u1] },
        { cards: [p2], l2: [], userId: u2, users: [u2] },
        {
          cards: [shared],
          l2: ['science', 'technology'],
          userId: undefined,
          users: [u1, u2].sort(),
        },
      ].sort((x, y) => byId(x.cards[0] ?? '0', y.cards[0] ?? '0')),
    );
    expect((await h.cardAnswers(articleId)).map((a) => a.cardId)).toEqual(
      sorted([p1a, p1b, p2, shared]),
    );
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });
  });

  it('prefilter (above 60 cards) writes provisional p = 0 markers only for off-topic cards, later re-asked', async () => {
    await h.setSetting('engine.prefilter_enabled', true);
    try {
      const feedId = await h.feed();
      const userId = await h.user();
      await h.subscribe(userId, feedId, 'active');
      const onTopic: string[] = [];
      const offTopic: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        onTopic.push(await h.heldCard(userId, { topicIds: ['technology.ai_ml'] }));
        offTopic.push(await h.heldCard(userId, { topicIds: ['sports.football'] }));
      }
      const topicless = await h.heldCard(userId);
      const mixed = await h.heldCard(userId, { topicIds: ['sports', 'science'] });
      const label = await h.heldLabel(userId, { topicIds: ['sports'] });
      const kept = sorted([...onTopic, topicless, mixed, label]);
      expect(kept.length + offTopic.length).toBeGreaterThan(PREFILTER_MIN_CARDS);
      const articleId = await h.article({ feedIds: [feedId] });

      await h.dispatch('article.enrich', { articleId });
      await h.run('article.match', forArticles(articleId));

      const answers = await h.cardAnswers(articleId);
      const markers = answers.filter((a) => a.engine === 'prefilter');
      expect(markers.map((a) => a.cardId)).toEqual(sorted(offTopic));
      expect(markers.every((a) => a.p === 0 && a.model === null)).toBe(true);
      const asked = h.router.asksFor(articleId, 'match').flatMap((ask) => ask.cards);
      expect(sorted(asked)).toEqual(kept);
      expect(answers.filter((a) => a.engine === 'typesafe').map((a) => a.cardId)).toEqual(kept);
      // Markers count as completed provisional work for the article state.
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });
      expect(await h.queueRows(articleId)).toEqual([]);

      // Provisional, never a measured negative: a backfill re-queues the marked pairs and the match
      // stage asks them (30 pending cards are below the prefilter threshold).
      await h.dispatch('card.backfill', { userId, cardIds: offTopic });
      expect((await h.queueRows(articleId)).map((row) => [row.cardId, row.priority])).toEqual(
        sorted(offTopic).map((id) => [id, 2]),
      );
      await h.run('article.match', forArticles(articleId));
      const reasked = h.router.asksFor(articleId, 'match').at(-1);
      expect(sorted(reasked?.cards ?? [])).toEqual(sorted(offTopic));
      expect(reasked?.priority).toBe('interactive');
      const after = await h.cardAnswers(articleId);
      expect(after.filter((a) => a.engine === 'prefilter')).toEqual([]);
      expect(after.filter((a) => offTopic.includes(a.cardId)).every((a) => a.p === 0.8)).toBe(true);
    } finally {
      await h.setSetting('engine.prefilter_enabled', false);
    }
  });

  it('asks only level-2 questions without card rows, needs article demand for them, and never repeats them', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId] });
    await h.dispatch('article.enrich', { articleId });
    expect(await h.queueRows(articleId)).toEqual([]);

    const since = await h.mark();
    await h.run('article.match', forArticles(articleId));
    const asks = h.router.asksFor(articleId, 'match');
    expect(asks).toHaveLength(1);
    expect([...(asks[0]?.keys ?? [])].sort()).toEqual(['t2_science', 't2_technology']);
    expect(asks[0]).toMatchObject({ cards: [], priority: 'bulk', userId: undefined });
    expect(witnessesOf(asks)).toEqual({ users: [userId], requests: [] });
    expect((await h.l2Rows(articleId)).map((row) => [row.l1, row.engine, row.revision])).toEqual([
      ['science', 'typesafe', '1'],
      ['technology', 'typesafe', '1'],
    ]);
    const facets = await h.facetRow(articleId);
    expect(facets?.features['t2_asked.technology']).toBe(1);
    expect(facets?.features['t2_asked.science']).toBe(1);
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });
    expect(await h.payloads('user.rank', since)).toEqual([{ userId, reason: 'match' }]);

    // A repeated dispatch does not regenerate the complete level-2 call.
    await h.dispatch('article.match', { articleId });
    expect(h.router.asksFor(articleId, 'match')).toHaveLength(1);

    // Without article demand (the reader switched off after enrichment) nothing is asked.
    const other = await h.feed();
    const reader = await h.user();
    await h.subscribe(reader, other, 'active');
    const idle = await h.article({ feedIds: [other] });
    await h.enrichDirect(idle);
    await h.setMode(reader, other, 'off');
    await h.dispatch('article.match', { articleId: idle });
    expect(h.router.asksFor(idle)).toEqual([]);
    expect(await h.l2Rows(idle)).toEqual([]);
    expect(await h.articleRow(idle)).toMatchObject({ state: 'enriched' });
  });

  it('is matched only when every demanded pair and selected branch is current, and demotes on new demand', async () => {
    const s = await scenario({ cards: 2 });
    const [k1, k2] = sorted(s.cardIds) as [string, string];
    // The provider answers only part of the pack: one card and one branch are missing.
    h.router.omit = (key) => key === `c${k2}` || key === 't2_science';
    await h.dispatch('article.enrich', { articleId: s.articleId });
    await h.run('article.match', forArticles(s.articleId));
    expect((await h.cardAnswers(s.articleId)).map((a) => a.cardId)).toEqual([k1]);
    expect((await h.l2Rows(s.articleId)).map((row) => row.l1)).toEqual(['technology']);
    expect(await h.queueRows(s.articleId)).toMatchObject([
      { cardId: k2, attempts: 1, lastError: 'error', due: false, leased: false },
    ]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });

    // The retry completes the pair and the missing branch only.
    h.router.omit = () => false;
    await makeDue(s.articleId);
    await h.dispatch('article.match', { articleId: s.articleId });
    const retry = h.router.asksFor(s.articleId, 'match').at(-1);
    expect(retry?.cards).toEqual([k2]);
    expect(retry?.l2).toEqual(['science']);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'matched' });
    expect(await h.queueRows(s.articleId)).toEqual([]);

    // New demand arrives (a newly held card) while Jev is out of budget: back to enriched.
    const k3 = await h.heldCard(s.userId);
    await h.queue(s.articleId, [k3]);
    const retryAt = new Date(Date.now() + DAY);
    h.router.respond = () => failure('budget', retryAt);
    // The retry's rank intent is still pending; identical pending intents coalesce.
    await h.clearOutbox();
    const since = await h.mark();
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
    const [row] = await h.queueRows(s.articleId);
    expect(row).toMatchObject({ cardId: k3, attempts: 0, lastError: 'budget', due: false });
    expect(row?.nextAttemptAt.getTime()).toBe(retryAt.getTime());
    expect(await h.payloads('user.rank', since)).toEqual([{ userId: s.userId, reason: 'match' }]);
    expect(await h.payloads('article.match', since)).toEqual([]);
  });

  it('records rank intents with the answers: a job that dies after a pack still ranks its readers', async () => {
    const { articleId, users } = await twoPrivatePacks();
    let packs = 0;
    h.router.respond = (ask) => {
      if (ask.kind !== 'match') return undefined;
      packs += 1;
      if (packs === 2) throw new Error('worker lost');
      return undefined;
    };
    const since = await h.mark();
    await expect(h.dispatch('article.match', { articleId })).rejects.toThrow('worker lost');
    expect(await h.cardAnswers(articleId)).toHaveLength(1);
    // The first pack's answers committed together with the readers' rank intents (step 9).
    const ranked = (await h.payloads('user.rank', since)).map((p) => p['userId']);
    expect([...ranked].sort()).toEqual(users);
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'enriched' });
  });

  it('starts no pack after the job budget: a follow-up job asks the rest', async () => {
    const { articleId } = await twoPrivatePacks();
    const classification = h.deps.classification as ClassificationDeps;
    classification.jobBudgetMs = 0;
    try {
      const since = await h.mark();
      await h.dispatch('article.match', { articleId });
      expect(h.router.asksFor(articleId, 'match')).toHaveLength(1);
      expect(await h.cardAnswers(articleId)).toHaveLength(1);
      // The unasked pack's row is released due, without an attempt, for the follow-up job.
      expect(
        (await h.queueRows(articleId)).map((row) => [row.leased, row.attempts, row.due]),
      ).toEqual([[false, 0, true]]);
      expect(await h.payloads('article.match', since)).toEqual([{ articleId }]);
      await h.run('article.match', forArticles(articleId));
      expect(h.router.asksFor(articleId, 'match')).toHaveLength(2);
      expect(await h.cardAnswers(articleId)).toHaveLength(2);
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });
    } finally {
      classification.jobBudgetMs = 600_000;
    }
  });

  it('retries failed level-2-only work with a delayed job, like a queue row (spec 05 §4)', async () => {
    const feedId = await h.feed();
    const userId = await h.user();
    await h.subscribe(userId, feedId, 'active');
    const articleId = await h.article({ feedIds: [feedId] });
    await h.dispatch('article.enrich', { articleId });
    await h.clearOutbox();

    // Unavailability: a retry at the known time, without a failure attempt.
    const retryAt = new Date(Date.now() + 30 * MINUTE);
    h.router.respond = () => failure('circuit_open', retryAt);
    let since = await h.mark();
    await h.dispatch('article.match', { articleId });
    let intents = await h.intents('article.match', { since });
    expect(intents.map((intent) => intent.payload)).toEqual([{ articleId, l2Attempts: 0 }]);
    expect(intents[0]?.availableAt.getTime()).toBe(retryAt.getTime());

    // Retry exhaustion: one attempt, due after the rows' backoff (1, 2, 4, 8 minutes).
    h.router.respond = () => failure('error');
    since = await h.mark();
    const before = Date.now();
    await h.dispatch('article.match', { articleId, l2Attempts: 2 });
    intents = await h.intents('article.match', { since });
    expect(intents.map((intent) => intent.payload)).toEqual([{ articleId, l2Attempts: 3 }]);
    expect(Math.round(((intents[0]?.availableAt.getTime() ?? 0) - before) / MINUTE)).toBe(4);

    // The fifth failure gives up, as an exhausted row does; an invalid request at once.
    for (const [reason, attempts] of [
      ['error', 4],
      ['invalid_request', 0],
    ] as const) {
      h.router.respond = () => failure(reason);
      since = await h.mark();
      await h.dispatch('article.match', { articleId, l2Attempts: attempts });
      expect(await h.intents('article.match', { since })).toEqual([]);
    }
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'enriched' });

    // A delivered retry that the engine answers completes the article.
    h.router.respond = undefined;
    await h.dispatch('article.match', { articleId, l2Attempts: 0 });
    expect((await h.l2Rows(articleId)).map((row) => row.l1)).toEqual(['science', 'technology']);
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });
  });

  it('reads demand under the drop’s row locks: a pair whose holder returns before it is asked, not deleted', async () => {
    const s = await scenario({ cards: 2 });
    const [, returning] = sorted(s.cardIds) as [string, string];
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    // The reader let go of one card after it was queued and holds it again as the job drops pairs.
    await letGo(s.userId, returning);
    const restore = await holdingReturnsOnWrite(s.userId, returning);
    try {
      await h.dispatch('article.match', { articleId: s.articleId });
    } finally {
      await restore();
    }

    expect(h.router.asksFor(s.articleId, 'match').map((ask) => sorted(ask.cards))).toEqual([
      sorted(s.cardIds),
    ]);
    expect(sorted((await h.cardAnswers(s.articleId)).map((a) => a.cardId))).toEqual(
      sorted(s.cardIds),
    );
    expect(await h.queueRows(s.articleId)).toEqual([]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'matched' });
  });
});

describe('article.match failures and recovery (spec 05 §5.5 step 7)', () => {
  it('retains exhausted rows: service failures stay recoverable, an invalid request does not', async () => {
    const s = await scenario({ cards: 2 });
    const [failing, invalid] = sorted(s.cardIds) as [string, string];
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });

    // A permanent invalid request is exhausted at once.
    await h.queue(s.articleId, [invalid]);
    h.router.respond = () => failure('invalid_request');
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(await h.queueRows(s.articleId)).toMatchObject([
      { cardId: invalid, attempts: 5, lastError: 'invalid_request', leased: false },
    ]);

    // Actual retry exhaustion counts one attempt per logical pack, with backoff, up to five.
    await h.queue(s.articleId, [failing]);
    h.router.respond = () => failure('error');
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue(s.articleId);
      const before = Date.now();
      await h.dispatch('article.match', { articleId: s.articleId });
      const row = (await h.queueRows(s.articleId)).find((r) => r.cardId === failing);
      expect(row).toMatchObject({ attempts: attempt, lastError: 'error', leased: false });
      delays.push(Math.round(((row?.nextAttemptAt.getTime() ?? 0) - before) / MINUTE));
    }
    // The fifth leaves the row exhausted, never due: its due time records when it gave up.
    expect(delays).toEqual([1, 2, 4, 8, 0]);
    expect(h.router.asksFor(s.articleId, 'match').map((ask) => ask.cards)).toEqual([
      [invalid],
      [failing],
      [failing],
      [failing],
      [failing],
      [failing],
    ]);

    // Exhausted rows are not claimed again.
    await makeDue(s.articleId);
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(h.router.asksFor(s.articleId, 'match')).toHaveLength(6);

    // Recovery waits six hours from then, so a pair that keeps failing is not rebilled every pass.
    const early = await retryTransaction(h.db, (tx) => recoverMatchQueue(tx, { limit: 200 }));
    expect(early.articleIds).not.toContain(s.articleId);
    expect((await h.queueRows(s.articleId)).map((row) => row.attempts)).toEqual([5, 5]);
    await h.owner.query(
      `UPDATE match_queue SET next_attempt_at = now() - interval '6 hours 1 minute'
        WHERE article_id = $1`,
      [s.articleId],
    );

    // Then it resets the service failure only, and dispatches the article.
    const recovered = await retryTransaction(h.db, (tx) => recoverMatchQueue(tx, { limit: 200 }));
    expect(recovered.articleIds).toContain(s.articleId);
    expect(await h.queueRows(s.articleId)).toMatchObject([
      { cardId: failing, attempts: 0, lastError: null, due: true },
      { cardId: invalid, attempts: 5, lastError: 'invalid_request' },
    ]);
    h.router.respond = undefined;
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(h.router.asksFor(s.articleId, 'match').at(-1)?.cards).toEqual([failing]);
    expect((await h.cardAnswers(s.articleId)).map((a) => a.cardId)).toEqual([failing]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });
  });

  it('exhausts a question that cannot fit a request even alone and still asks the others', async () => {
    const s = await scenario({ cards: 1 });
    const oversized = await h.heldCard(s.userId, {
      topicIds: ['technology'],
      interest: oversizedInterest('Exhausted'),
    });
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, [...s.cardIds, oversized]);
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(h.router.asksFor(s.articleId, 'match').map((ask) => ask.cards)).toEqual([s.cardIds]);
    expect((await h.cardAnswers(s.articleId)).map((a) => a.cardId)).toEqual(s.cardIds);
    expect(await h.queueRows(s.articleId)).toMatchObject([
      { cardId: oversized, attempts: 5, lastError: 'invalid_request', leased: false },
    ]);
  });

  it('keeps coverage per reader: one reader’s exhausted pair never blocks another reader’s answers', async () => {
    const feedId = await h.feed();
    const a = await h.user();
    const b = await h.user();
    await h.subscribe(a, feedId, 'active');
    await h.subscribe(b, feedId, 'active');
    const cardA = await h.heldCard(a);
    const cardB = await h.card({ visibility: 'private', ownerUserId: b });
    await h.hold(b, cardB);
    const articleId = await h.article({ feedIds: [feedId] });
    h.router.topics = NO_BRANCH_TOPICS;
    h.router.respond = (ask) =>
      ask.kind === 'match' && ask.cards.includes(cardB) ? failure('invalid_request') : undefined;

    await h.dispatch('article.enrich', { articleId });
    const since = await h.mark();
    await h.run('article.match', forArticles(articleId));

    const answers = await h.cardAnswers(articleId);
    expect(answers.map((x) => [x.cardId, x.engine])).toEqual([[cardA, 'typesafe']]);
    expect(await h.queueRows(articleId)).toMatchObject([
      { cardId: cardB, attempts: 5, lastError: 'invalid_request' },
    ]);
    // The article-level state waits for B's pair; each reader's coverage is their own.
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'enriched' });
    const item = {
      cardAnswers: Object.fromEntries(
        answers.map((x) => [x.cardId, { p: x.p, engine: x.engine as 'typesafe' }]),
      ),
      inferenceFeedIds: [feedId],
    };
    const rankCard = (cardId: string): RankCard => ({
      cardId,
      title: `Card ${cardId}`,
      strength: 'like',
      interest: 'anything',
    });
    expect(matchCoverage([rankCard(cardA)], item).coverage).toBe('complete');
    expect(matchCoverage([rankCard(cardB)], item, { [cardB]: 'exhausted' }).coverage).toBe(
      'unavailable',
    );
    const ranked = (await h.payloads('user.rank', since)).map((p) => p['userId']);
    expect([...ranked].sort()).toEqual([a, b].sort());
  });

  it('a no_demand failure keeps a pair whose holder returns before its rows are released', async () => {
    const s = await scenario({ cards: 2 });
    const [, returning] = sorted(s.cardIds) as [string, string];
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, s.cardIds);
    const restore = await holdingReturnsOnWrite(s.userId, returning);
    const since = await h.mark();
    try {
      // The reader lets go of one card while the pack is in flight, and holds it again as the job
      // drops the pairs the failure left without demand.
      h.router.respond = async () => {
        await letGo(s.userId, returning);
        return { ok: false, reason: 'no_demand' };
      };
      await h.dispatch('article.match', { articleId: s.articleId });
    } finally {
      await restore();
    }

    expect(await h.cardAnswers(s.articleId)).toEqual([]);
    expect(await h.queueRows(s.articleId)).toMatchObject(
      sorted(s.cardIds).map((cardId) => ({ cardId, attempts: 0, leased: false, due: true })),
    );
    expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched' });

    // The follow-up asks both pairs.
    h.router.respond = undefined;
    await h.dispatch('article.match', { articleId: s.articleId });
    expect(sorted((await h.cardAnswers(s.articleId)).map((a) => a.cardId))).toEqual(
      sorted(s.cardIds),
    );
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'matched' });
  });
});

describe('readers with different modes on one feed (spec 03 §2.2, spec 05 §5.5 step 6)', () => {
  it('only active demand reaches the provider; an off switch during a reader’s call drops that reader’s answers', async () => {
    const feedId = await h.feed();
    const [active, trainee, off, switching] = [
      await h.user(),
      await h.user(),
      await h.user(),
      await h.user(),
    ];
    await h.subscribe(active, feedId, 'active');
    await h.subscribe(trainee, feedId, 'training');
    await h.subscribe(off, feedId, 'off');
    await h.subscribe(switching, feedId, 'active');
    const privateCard = async (userId: string) => {
      const cardId = await h.card({ visibility: 'private', ownerUserId: userId });
      await h.hold(userId, cardId);
      return cardId;
    };
    const mine = await privateCard(active);
    const trained = await privateCard(trainee);
    const silent = await privateCard(off);
    const theirs = await privateCard(switching);
    const articleId = await h.article({ feedIds: [feedId] });

    // Enrichment admits only the active readers' cards: the trainee (nothing selected) and the
    // off reader create no demand, so their cards are never queued.
    await h.dispatch('article.enrich', { articleId });
    expect(witnessesOf(h.router.asksFor(articleId, 'enrich'))).toEqual({
      users: [active, switching].sort(),
      requests: [],
    });
    expect((await h.queueRows(articleId)).map((row) => row.cardId)).toEqual(sorted([mine, theirs]));

    // The second active reader switches the feed off while their own pack is in flight.
    h.router.respond = async (ask) => {
      if (ask.kind === 'match' && ask.userId === switching) {
        await h.setMode(switching, feedId, 'off');
      }
      return undefined;
    };
    await h.run('article.match', forArticles(articleId));

    const asked = h.router.provider.filter((ask) => ask.articleId === articleId);
    expect(sorted(asked.flatMap((ask) => ask.cards))).toEqual(sorted([mine, theirs]));
    for (const cardId of [trained, silent]) {
      expect(h.router.asks.some((ask) => ask.cards.includes(cardId))).toBe(false);
    }
    // The tenant-specific completion is fenced: the switched reader's answer is dropped
    // unwritten with its queue row, and the article is complete for the demand that remains.
    expect((await h.cardAnswers(articleId)).map((a) => a.cardId)).toEqual([mine]);
    expect(await h.queueRows(articleId)).toEqual([]);
    expect(await h.articleRow(articleId)).toMatchObject({ state: 'matched' });

    // Neither a retry nor switching back on revives the dropped pair: the article arrived before
    // the new activation, so it is part of the reader's hidden backlog.
    h.router.respond = undefined;
    await h.setMode(switching, feedId, 'active');
    await h.dispatch('article.match', { articleId });
    expect(h.router.asks.filter((ask) => ask.cards.includes(theirs))).toHaveLength(1);
    expect((await h.cardAnswers(articleId)).map((a) => a.cardId)).toEqual([mine]);
  });
});
