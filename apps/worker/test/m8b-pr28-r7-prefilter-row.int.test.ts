import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import { NO_BRANCH_TOPICS } from './support/classify.js';
import {
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  handlersFor,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * PR #28 Codex round 7, finding 3: an invalid stored `engine.prefilter_min_cards` row no longer makes
 * the classification configuration throw. Like the other runtime keys the job uses the environment
 * default and the heartbeat reports the problem.
 */
const KEY = 'engine.prefilter_min_cards';
let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await h?.close();
});
beforeEach(async () => {
  await resetWorld(h);
});

async function matchWith(value: unknown) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production'),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  await setSetting(h.owner, KEY, value);
  await h.owner.query('DELETE FROM job_outbox');
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const cardId = await h.heldCard(userId, { topicIds: ['technology.ai_ml'] });
  const articleId = await h.article({ feedIds: [feedId] });
  await h.enrichDirect(articleId, { topics: NO_BRANCH_TOPICS });
  await h.queue(articleId, [cardId]);
  const router = new ScriptedRouter(h.db, runtime.processModel);
  const error = await dispatch(
    handlersFor(h, runtime, router),
    'article.match',
    { articleId },
    { queue: 'article.match', jobId: 'r7-p' },
  ).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  await runtime.check();
  return { articleId, error, problems: runtime.heartbeatRuntime().problems };
}

describe('an invalid engine.prefilter_min_cards row (PR #28 round 7)', () => {
  for (const [label, value] of [
    ['zero', 0],
    ['a string', 'many'],
    ['a fraction', 2.5],
  ] as const) {
    it(`${label}: article.match still runs on the environment default and the heartbeat reports it`, async () => {
      const { articleId, error, problems } = await matchWith(value);
      expect(error).toBeUndefined();
      expect(await h.cardAnswers(articleId)).toHaveLength(1);
      expect(problems.map((p) => p.key)).toContain(KEY);
    });
  }

  it('control: a valid row is used and nothing is reported', async () => {
    const { articleId, error, problems } = await matchWith(3);
    expect(error).toBeUndefined();
    expect(await h.cardAnswers(articleId)).toHaveLength(1);
    expect(problems.map((p) => p.key)).not.toContain(KEY);
  });
});
