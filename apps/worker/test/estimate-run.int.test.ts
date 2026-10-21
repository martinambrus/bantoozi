import { insertEstimateModel, lockEstimateUser, MATCH_MAX_ATTEMPTS } from '@bantoozi/db';
import { buildJobIntent, parseJobPayload } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, HOUR, MINUTE, ago } from './support/classify.js';
import {
  ESTIMATE_KINDS,
  WORDS,
  WORD_P,
  RULES_1B,
  RunReader,
  buildModel,
  continuationOf,
  dropModels,
  featureOf,
  fingerprint,
  lastRunOf,
  nudged,
  rulesOf,
  runRank,
  setEstimates,
  storeModel,
  storedRow,
  storedRows,
  tierOf,
  withP,
  type EstimateKind,
  type StoredRow,
  type Word,
  type WorldRow,
} from './support/estimate-run-world.js';

/**
 * EST-3b `user.rank` estimate refresh (visible-learning §4.4, spec 06 §8.6) through the real
 * handler: which rows it visits and writes, the skip rule, the moved counters in `lastRun`,
 * continuations, the superseded case and the self-healing enqueue of `user.estimate`.
 */

let h: ClassifyHarness;

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

const logit = (p: number): number => Math.log(p / (1 - p));

function expectEstimated(
  row: StoredRow | undefined,
  word: Word,
  kind: EstimateKind,
  version: number,
): void {
  expect(row).toBeDefined();
  expect(row?.lane).toBe('new');
  expect(row?.source).toBe('estimate');
  expect(row?.p).toBeCloseTo(WORD_P[word], 5);
  expect(row?.tier).toBe(tierOf(WORD_P[word]));
  expect(row?.rules).toEqual(rulesOf(kind));
  expect(row?.explain?.estimate?.version).toBe(version);
  const top = row?.explain?.estimate?.top[0];
  expect(top?.feature).toBe(featureOf(word));
  expect(top?.contribution).toBeCloseTo(logit(WORD_P[word]), 6);
}

function expectUnscored(row: StoredRow | undefined, kind: EstimateKind): void {
  expect(row?.lane).toBe('new');
  expect(row?.source).toBe('none');
  expect(row?.p).toBeNull();
  expect(row?.tier).toBeNull();
  expect(row?.rules).toEqual(kind === 'pending' ? [] : ['inference_not_requested']);
  expect(row?.explain?.estimate).toBeUndefined();
}

const wordOf = (row: WorldRow): Word => row.word as Word;

describe('I1 the refresh gives unscored rows a word estimate', () => {
  it('an estimate run turns Off, Training, over-cap and pending-card rows into estimate rows with the exit rules and the model tier', async () => {
    const r = await RunReader.standard(h);
    const version = await storeModel(h, r.userId, buildModel());

    const run = await runRank(h, r.userId, { estimate: {} });

    expect(run).toMatchObject({ outcome: 'done', written: 24 });
    expect(run.log).toMatchObject({ mode: 'estimate', visited: 24, written: 24, up: 20, down: 0 });
    const stored = await storedRows(h, r.userId);
    for (const row of r.estimateRows()) {
      expectEstimated(stored.get(row.id), wordOf(row), row.kind as EstimateKind, version);
    }
    for (const row of r.of('overCap', 'off', 'training')) {
      expect(stored.get(row.id)?.explain?.cards).toEqual([]);
      expect(stored.get(row.id)?.labelSuggestions).toEqual([]);
    }
  });

  it('a plain run scores the arrivals that have no stored row with the model', async () => {
    const r = await RunReader.standard(h);
    const version = await storeModel(h, r.userId, buildModel());
    const arrivals: WorldRow[] = [];
    for (const kind of ESTIMATE_KINDS) {
      const id = await r.add(kind, 'delta');
      arrivals.push({ id, kind, word: 'delta' });
    }

    const run = await runRank(h, r.userId);

    expect(run.outcome).toBe('done');
    const stored = await storedRows(h, r.userId);
    for (const row of arrivals) {
      expectEstimated(stored.get(row.id), 'delta', row.kind as EstimateKind, version);
    }
  });

  it('a plain run leaves the 1b rows it ranked before the model existed to the refresh (pins existing behaviour)', async () => {
    const r = await RunReader.standard(h);
    await storeModel(h, r.userId, buildModel());
    const before = await storedRows(h, r.userId);

    await runRank(h, r.userId);

    const after = await storedRows(h, r.userId);
    for (const row of r.of('overCap', 'off', 'training')) {
      expectUnscored(after.get(row.id), row.kind as EstimateKind);
      expect(fingerprint(after.get(row.id) as StoredRow)).toBe(
        fingerprint(before.get(row.id) as StoredRow),
      );
    }
  });

  it('analysed rows (cards, degraded, hidden) are byte-equal after an estimate run and a plain run', async () => {
    const r = await RunReader.standard(h);
    await storeModel(h, r.userId, buildModel());
    const before = await storedRows(h, r.userId);
    const analysed = r.analysedRows();
    expect(analysed.map((row) => before.get(row.id)?.source).sort()).toEqual([
      'cards',
      'cards',
      'cards',
      'degraded',
      'none',
    ]);

    await runRank(h, r.userId, { estimate: {} });
    await runRank(h, r.userId);

    const after = await storedRows(h, r.userId);
    for (const row of analysed) {
      expect(fingerprint(after.get(row.id) as StoredRow)).toBe(
        fingerprint(before.get(row.id) as StoredRow),
      );
    }
  });

  it('a row whose result is now a card score is left to the plain run, which scores it from the cards', async () => {
    const r = await RunReader.create(h);
    const late = await r.add('pending', 'delta');
    const other = await r.add('overCap', 'delta');
    await runRank(h, r.userId);
    await storeModel(h, r.userId, buildModel());
    await h.enrichDirect(late, { state: 'matched' });
    await h.answerCard(late, r.cardId, { engine: 'typesafe', p: 0.95 });
    const before = await storedRow(h, r.userId, late);

    const run = await runRank(h, r.userId, { estimate: {} });

    expect(run.written).toBe(1);
    expect(run.log['deferred']).toBe(1);
    const left = await storedRow(h, r.userId, late);
    expect(fingerprint(left)).toBe(fingerprint(before));
    expect(left).toMatchObject({ lane: 'new', source: 'none' });
    expectEstimated(await storedRow(h, r.userId, other), 'delta', 'overCap', 1);

    await runRank(h, r.userId);
    expect((await storedRow(h, r.userId, late)).source).toBe('cards');
  });

  it('a row a rule now hides is left to the plain run, which hides it', async () => {
    const r = await RunReader.create(h);
    const doomed = await r.add('overCap', 'cobalt', { title: 'lateword cobalt dispatch' });
    const kept = await r.add('overCap', 'cobalt');
    await runRank(h, r.userId);
    await storeModel(h, r.userId, buildModel());
    await r.muteKeyword('lateword');
    const before = await storedRow(h, r.userId, doomed);

    const run = await runRank(h, r.userId, { estimate: {} });

    expect(run.written).toBe(1);
    expect(run.log['deferred']).toBe(1);
    expect(fingerprint(await storedRow(h, r.userId, doomed))).toBe(fingerprint(before));
    expectEstimated(await storedRow(h, r.userId, kept), 'cobalt', 'overCap', 1);

    await h.owner.query('UPDATE users SET rank_revision = rank_revision + 1 WHERE id = $1', [
      r.userId,
    ]);
    await runRank(h, r.userId);
    const hidden = await storedRow(h, r.userId, doomed);
    expect(hidden.lane).toBe('hidden');
    expect(hidden.rules).toEqual(['mute_keyword:lateword']);
    expect(hidden.explain?.estimate).toBeUndefined();
  });

  it('an estimate run with no model and the gate closed writes nothing', async () => {
    const r = await RunReader.standard(h);
    const before = await storedRows(h, r.userId);

    const run = await runRank(h, r.userId, { estimate: {} });

    expect(run.written).toBe(0);
    const after = await storedRows(h, r.userId);
    for (const [id, row] of before)
      expect(fingerprint(after.get(id) as StoredRow)).toBe(fingerprint(row));
  });
});

describe('I2 turning estimates off, or losing the model, restores the unscored rows', () => {
  async function estimated() {
    const r = await RunReader.standard(h);
    const version = await storeModel(h, r.userId, buildModel());
    await runRank(h, r.userId, { estimate: {} });
    const stored = await storedRows(h, r.userId);
    for (const row of r.estimateRows()) {
      expect(stored.get(row.id)?.source).toBe('estimate');
    }
    return { r, version };
  }

  function expectRestored(r: RunReader, stored: Map<string, StoredRow>): void {
    for (const row of r.estimateRows()) {
      expectUnscored(stored.get(row.id), row.kind as EstimateKind);
    }
  }

  it('prefs.estimates off plus a full rank restores {new, null, null, none}; on again and a refresh bring the estimates back', async () => {
    const { r, version } = await estimated();
    await setEstimates(h, r.userId, 'off');

    const full = await runRank(h, r.userId, { full: true });

    expect(full.outcome).toBe('done');
    expectRestored(r, await storedRows(h, r.userId));

    await setEstimates(h, r.userId, 'on');
    await runRank(h, r.userId, { estimate: {} });
    const stored = await storedRows(h, r.userId);
    for (const row of r.estimateRows()) {
      expectEstimated(stored.get(row.id), wordOf(row), row.kind as EstimateKind, version);
    }
  });

  it('an estimate run with prefs.estimates off restores them too, and records no lastRun', async () => {
    const { r, version } = await estimated();
    const recorded = await lastRunOf(h, r.userId, version);
    await setEstimates(h, r.userId, 'off');

    await runRank(h, r.userId, { estimate: {} });

    expectRestored(r, await storedRows(h, r.userId));
    expect(await lastRunOf(h, r.userId, version)).toEqual(recorded);
  });

  it('an estimate run after the model was deleted (below the gate) does the same', async () => {
    const { r } = await estimated();
    await dropModels(h, r.userId);

    const run = await runRank(h, r.userId, { estimate: {} });

    expect(run.written).toBe(24);
    expectRestored(r, await storedRows(h, r.userId));
  });

  it('a stale-spec model scores nothing: the refresh restores the rows', async () => {
    const { r } = await estimated();
    await dropModels(h, r.userId);
    await storeModel(h, r.userId, buildModel(), 'estimate-v0-obsolete');

    await runRank(h, r.userId, { estimate: {} });

    expectRestored(r, await storedRows(h, r.userId));
  });
});

describe('I3 the skip rule writes only rows whose tier or P moved by 0.01', () => {
  it('writes nothing for the same model, for a nudge below 0.01 within the tier, and exactly the rows that moved', async () => {
    const r = await RunReader.standard(h);
    const v1 = await storeModel(h, r.userId, buildModel());
    expect((await runRank(h, r.userId, { estimate: {} })).written).toBe(24);
    const analysedBefore = new Map(
      [...(await storedRows(h, r.userId))].filter(([id]) =>
        r.analysedRows().some((a) => a.id === id),
      ),
    );

    const same = await runRank(h, r.userId, { estimate: {} });
    expect(same.written).toBe(0);
    expect(same.log['visited']).toBe(24);

    const v2 = await storeModel(h, r.userId, buildModel(nudged(0.006)));
    const small = await runRank(h, r.userId, { estimate: {} });
    expect(small.written).toBe(0);
    for (const row of r.estimateRows()) {
      const stored = (await storedRows(h, r.userId)).get(row.id);
      expect(stored?.explain?.estimate?.version).toBe(v1);
      expect(stored?.p).toBeCloseTo(WORD_P[wordOf(row)], 5);
    }
    expect(await lastRunOf(h, r.userId, v2)).toMatchObject({ movedUp: 0, movedDown: 0 });

    const v3 = await storeModel(h, r.userId, buildModel(withP({ cobalt: 0.562 })));
    const moved = await runRank(h, r.userId, { estimate: {} });
    expect(moved.written).toBe(4);
    const afterV3 = await storedRows(h, r.userId);
    for (const row of r.estimateRows()) {
      const stored = afterV3.get(row.id);
      if (row.word === 'cobalt') {
        expect(stored?.explain?.estimate?.version).toBe(v3);
        expect(stored?.p).toBeCloseTo(0.562, 5);
        expect(stored?.tier).toBe(3);
      } else {
        expect(stored?.explain?.estimate?.version).toBe(v1);
      }
    }

    const v4 = await storeModel(h, r.userId, buildModel(withP({ cobalt: 0.562, foxtrot: 0.648 })));
    const flipped = await runRank(h, r.userId, { estimate: {} });
    expect(flipped.written).toBe(4);
    const afterV4 = await storedRows(h, r.userId);
    for (const row of r.estimateRows().filter((x) => x.word === 'foxtrot')) {
      const stored = afterV4.get(row.id);
      expect(stored?.explain?.estimate?.version).toBe(v4);
      expect(stored?.tier).toBe(3);
      expect(stored?.p).toBeCloseTo(0.648, 5);
    }
    for (const row of r.estimateRows().filter((x) => x.word !== 'foxtrot' && x.word !== 'cobalt')) {
      expect(afterV4.get(row.id)?.explain?.estimate?.version).toBe(v1);
    }

    for (const [id, row] of analysedBefore) {
      expect(fingerprint(afterV4.get(id) as StoredRow)).toBe(fingerprint(row));
    }
  });

  it('a row that is not new/none/estimate is never written by a refresh', async () => {
    const r = await RunReader.standard(h);
    await storeModel(h, r.userId, buildModel());
    const before = await storedRows(h, r.userId);

    await runRank(h, r.userId, { estimate: {} });

    const after = await storedRows(h, r.userId);
    for (const [id, row] of before) {
      if (row.lane !== 'new' || row.source === 'cards' || row.source === 'degraded') {
        expect(fingerprint(after.get(id) as StoredRow)).toBe(fingerprint(row));
      }
    }
  });
});

describe('I4 lastRun counts the unread rows whose tier moved', () => {
  async function counted() {
    const r = await RunReader.create(h);
    const cobaltCap = await r.add('overCap', 'cobalt');
    const alphaCap = await r.add('overCap', 'alpha');
    const deltaTraining = await r.add('training', 'delta');
    const epsilonPending = await r.add('pending', 'epsilon');
    const epsilonRead = await r.add('overCap', 'epsilon');
    const cobaltRead = await r.add('training', 'cobalt');
    await runRank(h, r.userId);
    await r.markRead(epsilonRead);
    await r.markRead(cobaltRead);
    return { r, cobaltCap, alphaCap, deltaTraining, epsilonPending, epsilonRead, cobaltRead };
  }

  it('counts none to a higher tier as up, none to tier 1 as nothing, and never a read row', async () => {
    const w = await counted();
    const v1 = await storeModel(h, w.r.userId, buildModel());
    const at = new Date(Date.now() + MINUTE);

    await runRank(h, w.r.userId, { estimate: {}, now: at });

    const stored = await storedRows(h, w.r.userId);
    expect(stored.get(w.alphaCap)).toMatchObject({ source: 'estimate', tier: 1 });
    expect(stored.get(w.epsilonRead)).toMatchObject({ source: 'estimate', tier: 5 });
    expect(await lastRunOf(h, w.r.userId, v1)).toEqual({
      at: at.toISOString(),
      movedUp: 3,
      movedDown: 0,
    });
  });

  it('counts a fall of the tier as down and a rise as up, from the estimate rows` stored tiers, and keeps the earlier version`s lastRun', async () => {
    const w = await counted();
    const v1 = await storeModel(h, w.r.userId, buildModel());
    const first = new Date(Date.now() + MINUTE);
    await runRank(h, w.r.userId, { estimate: {}, now: first });
    const v2 = await storeModel(
      h,
      w.r.userId,
      buildModel(withP({ cobalt: 0.9, delta: 0.3, epsilon: 0.2 })),
    );
    const second = new Date(Date.now() + 2 * MINUTE);

    const run = await runRank(h, w.r.userId, { estimate: {}, now: second });

    expect(run.log).toMatchObject({ up: 1, down: 2 });
    const stored = await storedRows(h, w.r.userId);
    expect(stored.get(w.cobaltCap)?.tier).toBe(5);
    expect(stored.get(w.deltaTraining)?.tier).toBe(2);
    expect(stored.get(w.epsilonPending)?.tier).toBe(1);
    expect(stored.get(w.epsilonRead)?.tier).toBe(1);
    expect(stored.get(w.cobaltRead)?.tier).toBe(5);
    expect(await lastRunOf(h, w.r.userId, v2)).toEqual({
      at: second.toISOString(),
      movedUp: 1,
      movedDown: 2,
    });
    expect(await lastRunOf(h, w.r.userId, v1)).toEqual({
      at: first.toISOString(),
      movedUp: 3,
      movedDown: 0,
    });
  });

  it('a refresh that moves nothing still records lastRun 0/0 with a later time', async () => {
    const w = await counted();
    const v1 = await storeModel(h, w.r.userId, buildModel());
    const first = new Date(Date.now() + MINUTE);
    await runRank(h, w.r.userId, { estimate: {}, now: first });
    const second = new Date(Date.now() + 5 * MINUTE);

    const run = await runRank(h, w.r.userId, { estimate: {}, now: second });

    expect(run.written).toBe(0);
    expect(await lastRunOf(h, w.r.userId, v1)).toEqual({
      at: second.toISOString(),
      movedUp: 0,
      movedDown: 0,
    });
  });
});

describe('I5 a refresh that runs out of budget continues on its own keys', () => {
  async function chainWorld() {
    const r = await RunReader.create(h);
    const picks: Array<[Parameters<RunReader['add']>[0], Word, boolean]> = [
      ['overCap', 'cobalt', false],
      ['overCap', 'epsilon', false],
      ['training', 'alpha', false],
      ['pending', 'delta', true],
      ['off', 'epsilon', false],
      ['overCap', 'bravo', false],
      ['training', 'foxtrot', false],
    ];
    const ids: string[] = [];
    for (const [kind, word] of picks) ids.push(await r.add(kind, word));
    await runRank(h, r.userId);
    await r.markRead(ids[3] as string);
    return { r, ids };
  }

  const tight = { estimatePageSize: 2, batchSize: 2, budgetMs: 0 };

  async function chain(userId: string, version: number) {
    const runs: Awaited<ReturnType<typeof runRank>>[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    let continuation: Record<string, unknown> | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const since = await h.mark();
      runs.push(
        await runRank(h, userId, {
          handler: tight,
          ...(continuation === undefined ? { estimate: {} } : { continuation }),
        }),
      );
      continuation = await continuationOf(h, userId, since);
      if (continuation === undefined) break;
      payloads.push(continuation);
      expect(await lastRunOf(h, userId, version)).toBeUndefined();
    }
    return { runs, payloads };
  }

  it('the chain visits every row once, carries the version and the running counters, and writes lastRun once with the same totals as one run', async () => {
    const a = await chainWorld();
    const b = await chainWorld();
    const va = await storeModel(h, a.r.userId, buildModel());
    const vb = await storeModel(h, b.r.userId, buildModel());
    expect(await runRank(h, b.r.userId, { estimate: {} })).toMatchObject({ written: 7 });

    const { runs, payloads } = await chain(a.r.userId, va);

    expect(runs.map((run) => run.outcome)).toEqual(['continued', 'continued', 'continued', 'done']);
    expect(runs.map((run) => run.written)).toEqual([2, 2, 2, 1]);
    expect(payloads).toHaveLength(3);
    let previous = { up: 0, down: 0 };
    for (const payload of payloads) {
      const estimate = payload['estimate'] as { version: number; up: number; down: number };
      expect(payload).toMatchObject({ userId: a.r.userId, reason: 'continuation' });
      expect(estimate.version).toBe(va);
      expect(estimate.up).toBeGreaterThanOrEqual(previous.up);
      expect(estimate.down).toBe(0);
      previous = estimate;
      const intent = buildJobIntent('user.rank', parseJobPayload('user.rank', payload));
      const cursor = payload['cursor'] as { arrival: string; articleId: string };
      expect(intent.send).toEqual({
        kind: 'send',
        singletonKey: `rank-est-cont:${a.r.userId}:${cursor.arrival}:${cursor.articleId}`,
      });
    }
    const single = await lastRunOf(h, b.r.userId, vb);
    expect(single).toMatchObject({ movedUp: 5, movedDown: 0 });
    expect(await lastRunOf(h, a.r.userId, va)).toMatchObject({
      movedUp: single?.movedUp,
      movedDown: single?.movedDown,
    });
    const storedA = await storedRows(h, a.r.userId);
    const storedB = await storedRows(h, b.r.userId);
    expect(a.ids.map((id) => storedA.get(id)?.tier)).toEqual(
      b.ids.map((id) => storedB.get(id)?.tier),
    );
    expect(a.ids.map((id) => storedA.get(id)?.source)).toEqual(a.ids.map(() => 'estimate'));
  });

  it('a model replaced between continuations ends the chain without a lastRun for either version', async () => {
    const w = await chainWorld();
    const v1 = await storeModel(h, w.r.userId, buildModel());
    const since = await h.mark();
    await runRank(h, w.r.userId, { estimate: {}, handler: tight });
    let continuation = await continuationOf(h, w.r.userId, since);
    expect(continuation?.['estimate']).toMatchObject({ version: v1 });
    const v2 = await storeModel(h, w.r.userId, buildModel(withP({ cobalt: 0.9 })));

    for (let guard = 0; guard < 10 && continuation !== undefined; guard += 1) {
      const next = await h.mark();
      await runRank(h, w.r.userId, { continuation, handler: tight });
      continuation = await continuationOf(h, w.r.userId, next);
    }

    expect(continuation).toBeUndefined();
    expect(await lastRunOf(h, w.r.userId, v1)).toBeUndefined();
    expect(await lastRunOf(h, w.r.userId, v2)).toBeUndefined();
  });

  it('a plain run`s continuation carries no estimate and keeps the rank-cont key (pins existing behaviour)', async () => {
    const w = await chainWorld();
    await storeModel(h, w.r.userId, buildModel());
    await h.owner.query('UPDATE users SET rank_revision = rank_revision + 1 WHERE id = $1', [
      w.r.userId,
    ]);
    const since = await h.mark();

    const run = await runRank(h, w.r.userId, {
      handler: { pageSize: 2, batchSize: 2, budgetMs: 0 },
    });

    expect(run.outcome).toBe('continued');
    const continuation = await continuationOf(h, w.r.userId, since);
    expect(continuation).toBeDefined();
    expect(continuation).not.toHaveProperty('estimate');
    const cursor = continuation?.['cursor'] as { arrival: string; articleId: string };
    expect(buildJobIntent('user.rank', parseJobPayload('user.rank', continuation)).send).toEqual({
      kind: 'send',
      singletonKey: `rank-cont:${w.r.userId}:${cursor.arrival}:${cursor.articleId}`,
    });
  });
});

describe('I6 a superseded refresh writes nothing and hands over to a plain run', () => {
  it('the fenced batch writes nothing, the follow-up is the plain superseded payload and no lastRun is recorded', async () => {
    const r = await RunReader.standard(h);
    const version = await storeModel(h, r.userId, buildModel());
    const before = await storedRows(h, r.userId);
    const since = await h.mark();

    const run = await runRank(h, r.userId, {
      estimate: {},
      handler: {
        beforeWrite: async () => {
          await h.owner.query('UPDATE users SET rank_revision = rank_revision + 1 WHERE id = $1', [
            r.userId,
          ]);
        },
      },
    });

    expect(run).toMatchObject({ outcome: 'superseded', written: 0 });
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: r.userId, reason: 'superseded' },
    ]);
    const after = await storedRows(h, r.userId);
    for (const [id, row] of before)
      expect(fingerprint(after.get(id) as StoredRow)).toBe(fingerprint(row));
    expect(await lastRunOf(h, r.userId, version)).toBeUndefined();
  });
});

describe('I7 an estimate row that waits on queued card work is rechecked', () => {
  async function pendingRow(source: 'none' | 'estimate') {
    const r = await RunReader.create(h);
    for (const [title, p] of [
      ['Harbor fees rise', 0.5],
      ['Crane makers merge', 0.9],
      ['Weather at sea', 0.2],
    ] as const) {
      await r.add('cards', null, { title, cardP: p });
    }
    const id = await r.add('pending', null, { title: 'Harbor crane automation spreads' });
    await runRank(h, r.userId);
    await storeModel(h, r.userId, buildModel());
    if (source === 'estimate') {
      await h.owner.query(
        `UPDATE user_article SET score_source = 'estimate', tier = 3, p_like = 0.55,
                                 rules_fired = ARRAY['estimate']
          WHERE user_id = $1 AND article_id = $2`,
        [r.userId, id],
      );
    }
    await h.owner.query(`UPDATE match_queue SET attempts = $2 WHERE article_id = $1`, [
      id,
      MATCH_MAX_ATTEMPTS,
    ]);
    return { r, id };
  }

  it('a plain run re-ranks an estimate row whose card work is exhausted into degraded', async () => {
    const { r, id } = await pendingRow('estimate');
    expect((await storedRow(h, r.userId, id)).source).toBe('estimate');

    await runRank(h, r.userId);

    expect((await storedRow(h, r.userId, id)).source).toBe('degraded');
  });

  it('control: the same exhausted work on a none row is rechecked into degraded (pins existing behaviour)', async () => {
    const { r, id } = await pendingRow('none');
    expect((await storedRow(h, r.userId, id)).source).toBe('none');

    await runRank(h, r.userId);

    expect((await storedRow(h, r.userId, id)).source).toBe('degraded');
  });

  it('a 1b estimate row with queue rows is not rechecked: a plain run leaves it', async () => {
    const r = await RunReader.create(h);
    const id = await r.add('overCap', 'cobalt');
    await h.queue(id, [r.cardId]);
    await runRank(h, r.userId);
    await storeModel(h, r.userId, buildModel());
    await runRank(h, r.userId, { estimate: {} });
    const before = await storedRow(h, r.userId, id);
    expect(before.source).toBe('estimate');
    expect(before.rules).toEqual(RULES_1B);

    const run = await runRank(h, r.userId);

    expect(run.ranked).toBe(0);
    expect(run.written).toBe(0);
    expect(fingerprint(await storedRow(h, r.userId, id))).toBe(fingerprint(before));
  });
});

describe('I9 a plain run heals a missing or stale estimate model', () => {
  async function reader(ratings: { pos: number; neg: number }) {
    const r = await RunReader.create(h);
    const total = ratings.pos + ratings.neg;
    for (let i = 0; i < total; i += 1) {
      const id = await r.add('overCap', 'alpha');
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
        [r.userId, id, i < ratings.pos ? 1 : -1, ago(2 * HOUR + i * MINUTE)],
      );
    }
    return r;
  }

  async function estimateIntents(userId: string, since: string) {
    return (await h.payloads('user.estimate', since)).filter((p) => p['userId'] === userId);
  }

  it('a reader past the gate with no model gets one user.estimate intent', async () => {
    const r = await reader({ pos: 6, neg: 4 });
    const since = await h.mark();

    await runRank(h, r.userId);

    expect(await estimateIntents(r.userId, since)).toEqual([{ userId: r.userId }]);
  });

  it('a stored model of another spec, or one that does not parse, gets one too', async () => {
    const stale = await reader({ pos: 3, neg: 3 });
    await storeModel(h, stale.userId, buildModel(), 'estimate-v0-obsolete');
    const broken = await reader({ pos: 3, neg: 3 });
    const model = buildModel();
    await h.db.transaction(async (tx) => {
      await lockEstimateUser(tx, broken.userId);
      await insertEstimateModel(tx, {
        userId: broken.userId,
        spec: model.spec,
        n: 6,
        nPos: 3,
        nNeg: 3,
        intercept: 0,
        weights: [1, 2, 3],
        platt: model.platt,
        metrics: model.metrics,
      });
    });
    const since = await h.mark();

    await runRank(h, stale.userId);
    await runRank(h, broken.userId);

    expect(await estimateIntents(stale.userId, since)).toEqual([{ userId: stale.userId }]);
    expect(await estimateIntents(broken.userId, since)).toEqual([{ userId: broken.userId }]);
  });

  it('prefs.estimates off enqueues neither, a reader below the gate none, a current model none', async () => {
    const off = await reader({ pos: 6, neg: 4 });
    await setEstimates(h, off.userId, 'off');
    const offStale = await reader({ pos: 3, neg: 3 });
    await storeModel(h, offStale.userId, buildModel(), 'estimate-v0-obsolete');
    await setEstimates(h, offStale.userId, 'off');
    const few = await reader({ pos: 5, neg: 4 });
    const lopsided = await reader({ pos: 8, neg: 2 });
    const current = await reader({ pos: 6, neg: 4 });
    await storeModel(h, current.userId, buildModel());
    const since = await h.mark();

    for (const u of [off, offStale, few, lopsided, current]) await runRank(h, u.userId);

    for (const u of [off, offStale, few, lopsided, current]) {
      expect(await estimateIntents(u.userId, since)).toEqual([]);
    }
  });
});

describe('the world itself', () => {
  it('every hand-written word is a single title feature and its P lands in the intended tier', () => {
    expect(WORDS.map((word) => tierOf(WORD_P[word]))).toEqual([1, 2, 3, 4, 5, 4]);
    expect(new Set(WORDS.map(featureOf)).size).toBe(WORDS.length);
  });
});
