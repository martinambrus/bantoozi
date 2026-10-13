import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ClassifyHarness,
  NO_BRANCH_TOPICS,
  forArticles,
  waitFor,
  type SettingWrite,
} from './support/classify.js';

/**
 * M8b-T4 (scope B2, PREFILTER_MIN_CARDS): `engine.prefilter_min_cards` replaces the hard-coded 60 of
 * `article.match`, is part of the fenced `ClassificationConfig` (read once per job snapshot,
 * share-locked, compared at completion) and a completion asked under another value is discarded.
 * Rows are written explicitly so the tests do not depend on how the env default is injected.
 */
const KEY = 'engine.prefilter_min_cards';
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

const sorted = (ids: readonly string[]): string[] => [...ids].sort((a, b) => Number(a) - Number(b));

/** A reader holding 2 on-topic and 2 off-topic cards; an article about technology.ai_ml. */
async function fourCards() {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const on: string[] = [];
  const off: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    on.push(await h.heldCard(userId, { topicIds: ['technology.ai_ml'] }));
    off.push(await h.heldCard(userId, { topicIds: ['sports.football'] }));
  }
  const articleId = await h.article({ feedIds: [feedId] });
  return { feedId, userId, on, off, articleId };
}

describe('engine.prefilter_min_cards in article.match', () => {
  it('a stored value of 3 with 4 cards runs the prefilter path: off-topic cards get provisional markers', async () => {
    await h.setSetting('engine.prefilter_enabled', true);
    await h.setSetting(KEY, 3);
    try {
      const s = await fourCards();
      await h.dispatch('article.enrich', { articleId: s.articleId });
      await h.run('article.match', forArticles(s.articleId));
      const answers = await h.cardAnswers(s.articleId);
      const markers = answers.filter((a) => a.engine === 'prefilter');
      expect(markers.map((a) => a.cardId)).toEqual(sorted(s.off));
      const asked = h.router.asksFor(s.articleId, 'match').flatMap((ask) => ask.cards);
      expect(sorted(asked)).toEqual(sorted(s.on));
    } finally {
      await h.setSetting('engine.prefilter_enabled', false);
      await h.deleteSetting(KEY);
    }
  });

  it('negative control: a stored value of 60 with the same 4 cards asks all of them, no markers', async () => {
    await h.setSetting('engine.prefilter_enabled', true);
    await h.setSetting(KEY, 60);
    try {
      const s = await fourCards();
      await h.dispatch('article.enrich', { articleId: s.articleId });
      await h.run('article.match', forArticles(s.articleId));
      const answers = await h.cardAnswers(s.articleId);
      expect(answers.filter((a) => a.engine === 'prefilter')).toEqual([]);
      const asked = h.router.asksFor(s.articleId, 'match').flatMap((ask) => ask.cards);
      expect(sorted(asked)).toEqual(sorted([...s.on, ...s.off]));
    } finally {
      await h.setSetting('engine.prefilter_enabled', false);
      await h.deleteSetting(KEY);
    }
  });

  it('a value of 3 does not prefilter while engine.prefilter_enabled is off', async () => {
    await h.setSetting('engine.prefilter_enabled', false);
    await h.setSetting(KEY, 3);
    try {
      const s = await fourCards();
      await h.dispatch('article.enrich', { articleId: s.articleId });
      await h.run('article.match', forArticles(s.articleId));
      expect((await h.cardAnswers(s.articleId)).filter((a) => a.engine === 'prefilter')).toEqual(
        [],
      );
    } finally {
      await h.deleteSetting(KEY);
    }
  });
});

describe('a match completion and a change of engine.prefilter_min_cards after its snapshot', () => {
  async function completeWhileWriting(value: number) {
    await h.setSetting(KEY, 60);
    const s = await fourCards();
    await h.enrichDirect(s.articleId, { topics: NO_BRANCH_TOPICS });
    await h.queue(s.articleId, [...s.on, ...s.off]);
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async () => {
      write ??= h.openSettingWrite(KEY, value);
      await write;
      return undefined;
    };
    try {
      const since = await h.mark();
      const run = h.dispatch('article.match', { articleId: s.articleId });
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      return { s, since };
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
    }
  }

  it('changed (60 -> 3): the answers are discarded, the rows are released and the job is re-enqueued', async () => {
    try {
      const { s, since } = await completeWhileWriting(3);
      expect(await h.cardAnswers(s.articleId)).toEqual([]);
      const rows = await h.queueRows(s.articleId);
      expect(rows.map((r) => [r.leased, r.attempts, r.due])).toEqual(
        Array.from({ length: 4 }, () => [false, 0, true]),
      );
      expect(await h.payloads('article.match', since)).toEqual([{ articleId: s.articleId }]);
    } finally {
      await h.deleteSetting(KEY);
    }
  });

  it('negative control, unchanged (60 -> 60): the answers are kept and the queue is empty', async () => {
    try {
      const { s, since } = await completeWhileWriting(60);
      expect((await h.cardAnswers(s.articleId)).map((a) => a.cardId)).toEqual(
        sorted([...s.on, ...s.off]),
      );
      expect(await h.queueRows(s.articleId)).toEqual([]);
      expect(await h.payloads('article.match', since)).toEqual([]);
    } finally {
      await h.deleteSetting(KEY);
    }
  });
});
