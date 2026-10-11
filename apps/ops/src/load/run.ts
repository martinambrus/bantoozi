import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BacklogProbe, LoadStack, dockerStats } from './docker.js';
import {
  ACTION_RATE_PER_USER,
  LIST_PAGE_LIMIT,
  LIST_RATE_PER_USER,
  LOAD_API_PORT,
  LOAD_CONTROL_PORT,
} from './config.js';
import {
  buildReport,
  planPhases,
  raiseMax,
  renderMarkdown,
  type LoadReport,
  type PhaseMeasure,
  type PhaseName,
} from './plan.js';
import { mapLimit, seedUsers, type SeededUser } from './seed.js';
import { fetchArticleRefs, runActionTraffic, runListTraffic, type ArticleRef } from './traffic.js';

/** `load:run`: the whole load sanity test (spec 11 §9, M8-T8). */

export interface LoadRunOptions {
  durationMin: number;
  outDir: string;
  keep: boolean;
  repoRoot: string;
  log?: (message: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SAMPLE_PAUSE_MS = 4_000;
const TRAINING_SELECTIONS_PER_FEED = 3;

/**
 * Feeds a user puts to training / active: the first and the last block of the 50, so that a neighbour
 * (who shares 20 feeds with this user, see `userFeedIndexes`) works on the same articles and the
 * shared cache has something to reuse.
 */
const trainingFeeds = (feedIds: readonly string[]): string[] => [
  ...feedIds.slice(0, 4),
  ...feedIds.slice(30, 34),
];
const activeFeeds = (feedIds: readonly string[]): string[] => [
  ...feedIds.slice(4, 10),
  ...feedIds.slice(34, 40),
];
const READY_ARTICLES_PER_USER = 20;
const READY_TIMEOUT_MS = 420_000;
const QUIET_DEPTH = 30;
const QUIET_TIMEOUT_MS = 900_000;

class Sim {
  private readonly base = `http://127.0.0.1:${LOAD_CONTROL_PORT}`;

  async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`load-sim ${path} answered ${response.status}`);
  }

  async providerRequests(): Promise<number> {
    const response = await fetch(`${this.base}/state`);
    const state = (await response.json()) as { provider: { requests: number } };
    return state.provider.requests;
  }

  setProvider(mode: 'normal' | 'failing' | 'timeouts'): Promise<void> {
    return this.post('/provider', { mode });
  }

  advanceClock(ms: number): Promise<void> {
    return this.post('/clock/advance', { ms });
  }
}

interface Counters {
  engineCalls: number;
  cardAnswers: number;
  served: number;
  providerRequests: number;
  articles: number;
}

class Database {
  constructor(
    private readonly stack: LoadStack,
    private readonly container: string,
  ) {}

  private async one(statement: string): Promise<number> {
    const rows = await this.stack.sql(this.container, statement);
    return Number(rows[0]?.[0] ?? 0);
  }

  async counters(sim: Sim): Promise<Counters> {
    return {
      engineCalls: await this.one(
        "select count(*) from engine_calls where engine in ('typesafe','llm','laya')",
      ),
      cardAnswers: await this.one('select count(*) from card_answers'),
      served: await this.one(
        `select count(*) from (select distinct s.user_id, fi.article_id, uc.card_id
           from subscriptions s
           join feed_items fi on fi.feed_id = s.feed_id
           join user_cards uc on uc.user_id = s.user_id
           join card_answers ca on ca.article_id = fi.article_id and ca.card_id = uc.card_id
          where s.inference_mode <> 'off') t`,
      ),
      providerRequests: await sim.providerRequests(),
      articles: await this.articleCount(),
    };
  }

  async queueDepths(): Promise<Record<string, number>> {
    const rows = await this.stack.sql(
      this.container,
      `select name, count(*) from pgboss.job
        where state in ('created','retry') and start_after <= now() group by name`,
    );
    return Object.fromEntries(rows.map(([name, count]) => [name ?? '', Number(count)]));
  }

  async articleCount(): Promise<number> {
    return this.one('select count(*) from articles');
  }

  /** Queues a forced fetch of every subscribed feed, as a due schedule would. */
  async forceFetchAll(): Promise<void> {
    await this.stack.sql(
      this.container,
      `insert into job_outbox (queue, payload)
         select 'feed.fetch', jsonb_build_object('feedId', f.id::text, 'force', true)
           from feeds f
          where f.merged_into_id is null
            and exists (select 1 from subscriptions s where s.feed_id = f.id)`,
    );
  }

  async queueLearning(): Promise<void> {
    await this.stack.sql(
      this.container,
      `insert into job_outbox (queue, payload, user_id)
         select 'user.learn', jsonb_build_object('userId', u.id::text), u.id
           from users u where u.email like 'load-user-%@example.com'`,
    );
  }
}

class Sampler {
  readonly cpuSamples: Record<string, number[]> = {};
  readonly memMaxBytes: Record<string, number> = {};
  readonly queueDepthMax: Record<string, number> = {};
  backlogAlert = false;
  readonly backlogConditions = new Set<string>();
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly containers: Record<string, string>,
    private readonly db: Database,
    private readonly probe: BacklogProbe,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.sampleOnce().catch((error: unknown) => {
          this.log(`sampler: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (this.running) await sleep(SAMPLE_PAUSE_MS);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await this.sampleOnce().catch(() => undefined);
  }

  private async sampleOnce(): Promise<void> {
    const stats = await dockerStats(this.containers);
    for (const [service, sample] of Object.entries(stats)) {
      (this.cpuSamples[service] ??= []).push(sample.cpuPct);
      raiseMax(this.memMaxBytes, service, sample.memBytes);
    }
    for (const [queue, depth] of Object.entries(await this.db.queueDepths())) {
      raiseMax(this.queueDepthMax, queue, depth);
    }
    const conditions = await this.probe.evaluate();
    if (conditions.length > 0) {
      this.backlogAlert = true;
      for (const condition of conditions)
        this.backlogConditions.add(`${condition.key}: ${condition.detail}`);
    }
  }
}

interface SubscriptionRow {
  feed: { id: string };
  inferenceVersion: string;
  inferenceMode: string;
}

async function subscriptionsOf(user: SeededUser): Promise<SubscriptionRow[]> {
  return user.client.expect<SubscriptionRow[]>('GET', '/api/v1/subscriptions');
}

/** Phase 2: a few feeds per user go to training, with selected articles and a training run queued. */
async function setupSelectedTraining(
  users: readonly SeededUser[],
  db: Database,
  log: (m: string) => void,
): Promise<void> {
  let selected = 0;
  await mapLimit(users, 5, async (user) => {
    const subscriptions = await subscriptionsOf(user);
    const versions = new Map(subscriptions.map((row) => [row.feed.id, row.inferenceVersion]));
    for (const feedId of trainingFeeds(user.feedIds)) {
      const page = await user.client.expect<{ items: { id: string; contentRevision: string }[] }>(
        'GET',
        `/api/v1/articles?lane=all&feedId=${feedId}&limit=${TRAINING_SELECTIONS_PER_FEED}`,
      );
      if (page.items.length === 0) continue;
      const result = await user.client.call('POST', `/api/v1/subscriptions/${feedId}/analyze`, {
        articles: page.items.map((item) => ({
          id: item.id,
          contentRevision: item.contentRevision,
        })),
        expectedInferenceVersion: versions.get(feedId) ?? '0',
        startTraining: true,
      });
      if (result.status === 202) selected += page.items.length;
      else log(`analyze for ${user.email} feed ${feedId} answered ${result.status}`);
    }
  });
  await db.queueLearning();
  log(`selected-training-slow: ${selected} articles selected, training runs queued`);
}

/** Phase 3: automatic inference on a few feeds per user. */
async function setupActive(users: readonly SeededUser[], log: (m: string) => void): Promise<void> {
  let switched = 0;
  await mapLimit(users, 5, async (user) => {
    const subscriptions = await subscriptionsOf(user);
    const versions = new Map(subscriptions.map((row) => [row.feed.id, row.inferenceVersion]));
    for (const feedId of activeFeeds(user.feedIds)) {
      const result = await user.client.call('POST', `/api/v1/subscriptions/${feedId}/inference`, {
        mode: 'active',
        expectedVersion: versions.get(feedId) ?? '0',
      });
      if (result.status === 200) switched += 1;
      else log(`inference change for ${user.email} feed ${feedId} answered ${result.status}`);
    }
  });
  log(`active-feeds: ${switched} subscriptions switched to active`);
}

async function waitForArticles(
  users: readonly SeededUser[],
  log: (m: string) => void,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const totals = await mapLimit(users, 5, async (user) => {
      const counts = await user.client.expect<{ total: number }>('GET', '/api/v1/articles/counts');
      return counts.total;
    });
    const fewest = Math.min(...totals);
    if (fewest >= READY_ARTICLES_PER_USER) {
      log(`ingestion ready: every user sees at least ${fewest} articles`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `after ${READY_TIMEOUT_MS / 1000} s the poorest user sees only ${fewest} articles`,
      );
    }
    await sleep(5_000);
  }
}

/** Lets the initial ingestion of the subscribed feeds drain before any phase is measured. */
async function waitForQuiet(db: Database, log: (m: string) => void): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let calm = 0;
  for (;;) {
    const depths = await db.queueDepths();
    const total = Object.values(depths).reduce((sum, value) => sum + value, 0);
    calm = total <= QUIET_DEPTH ? calm + 1 : 0;
    if (calm >= 2) {
      log(`warm-up done: ${total} jobs due`);
      return;
    }
    if (Date.now() > deadline) {
      log(
        `warm-up gave up after ${QUIET_TIMEOUT_MS / 1000} s with ${total} jobs due; measuring anyway`,
      );
      return;
    }
    await sleep(5_000);
  }
}

export async function runLoad(options: LoadRunOptions): Promise<LoadReport> {
  const log = options.log ?? ((message: string) => console.log(`[load] ${message}`));
  const plan = planPhases(options.durationMin);
  await mkdir(options.outDir, { recursive: true });
  const stack = new LoadStack(options.repoRoot);
  const probe = new BacklogProbe();
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let failed = false;
  try {
    await stack.up(log);
    const containers = (await stack.containers()).byService;
    for (const service of ['postgres', 'api', 'worker', 'load-sim']) {
      if (containers[service] === undefined)
        throw new Error(`the ${service} container is not running`);
    }
    const sim = new Sim();
    const db = new Database(stack, containers['postgres'] as string);
    await probe.start(containers['worker'] as string);
    const base = `http://127.0.0.1:${LOAD_API_PORT}`;

    log('seeding users, subscriptions and cards through the API');
    const users = await seedUsers(base, log);
    await waitForArticles(users, log);
    await waitForQuiet(db, log);

    const measures: PhaseMeasure[] = [];
    for (const phase of plan) {
      if (interrupted) throw new Error('interrupted');
      log(`phase ${phase.name}: ${phase.durationSec} s`);
      switch (phase.name as PhaseName) {
        case 'all-off':
          await sim.setProvider('normal');
          break;
        case 'selected-training-slow':
          await sim.setProvider('normal');
          await setupSelectedTraining(users, db, log);
          break;
        case 'active-feeds':
          await sim.setProvider('normal');
          await setupActive(users, log);
          break;
        case 'provider-failing':
          await sim.setProvider('failing');
          break;
      }
      const refs = new Map<string, ArticleRef[]>();
      await mapLimit(users, 5, async (user) => {
        refs.set(user.email, await fetchArticleRefs(user));
      });

      const before = await db.counters(sim);
      const startedAt = new Date();
      const sampler = new Sampler(containers, db, probe, log);
      sampler.start();
      let flipTimer: NodeJS.Timeout | undefined;
      if (phase.name === 'provider-failing') {
        // First half: the provider answers 503; second half: it hangs until the client gives up.
        flipTimer = setTimeout(
          () => void sim.setProvider('timeouts').catch(() => undefined),
          (phase.durationSec * 1000) / 2,
        );
      }
      const [list, actions] = await Promise.all([
        runListTraffic(base, users, phase.durationSec),
        runActionTraffic(base, users, refs, phase.durationSec),
      ]);
      if (flipTimer !== undefined) clearTimeout(flipTimer);
      await sampler.stop();
      const endedAt = new Date();
      const after = await db.counters(sim);

      measures.push({
        name: phase.name,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSec: phase.durationSec,
        articleLatenciesMs: list.latenciesMs,
        actionRequests: actions.requests,
        errors5xx: list.errors5xx + actions.errors5xx,
        non2xx: list.non2xx + actions.non2xx,
        cpuSamples: sampler.cpuSamples,
        memMaxBytes: sampler.memMaxBytes,
        queueDepthMax: sampler.queueDepthMax,
        backlogAlert: sampler.backlogAlert,
        backlogConditions: [...sampler.backlogConditions],
        inferenceCalls: after.engineCalls - before.engineCalls,
        providerRequests: after.providerRequests - before.providerRequests,
        distinctQuestionsAdmitted: after.cardAnswers - before.cardAnswers,
        servedCombinations: Math.max(0, after.served - before.served),
        newArticles: after.articles - before.articles,
      });
      log(
        `phase ${phase.name} done: ${list.latenciesMs.length} list requests, 5xx ${list.errors5xx + actions.errors5xx}, inference calls ${after.engineCalls - before.engineCalls}`,
      );
    }
    await sim.setProvider('normal').catch(() => undefined);

    const report = buildReport({
      host: { cpus: os.cpus().length, memTotal: os.totalmem() },
      durationMin: options.durationMin,
      articles: await db.articleCount(),
      traffic: {
        listRatePerUser: LIST_RATE_PER_USER,
        actionRatePerUser: ACTION_RATE_PER_USER,
        listPageLimit: LIST_PAGE_LIMIT,
      },
      measures,
      generatedAt: new Date().toISOString(),
    });
    await writeFile(
      path.join(options.outDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(path.join(options.outDir, 'report.md'), renderMarkdown(report));
    log(`report written to ${options.outDir}`);
    return report;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    probe.stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (options.keep) {
      log(
        `--keep: the ${failed ? 'failed ' : ''}stack bantoozi-load stays up; remove it with: ${stack.teardownCommand()}`,
      );
    } else {
      log('tearing down bantoozi-load');
      await stack.down();
    }
  }
}
