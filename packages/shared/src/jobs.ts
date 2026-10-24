import { z } from 'zod';

import { IdSchema, UuidSchema } from './ids.js';
import { MODEL_ID_PATTERN } from './model-id.js';
import { canonicalJson } from './text/canonical-json.js';

/**
 * Single source of every pg-boss queue (spec 03 §2): name, zod payload schema, `createQueue`
 * options, send semantics and consumer concurrency, plus typed enqueue helpers over `JobSender`.
 *
 * Producers never talk to pg-boss directly. An enqueue helper builds a validated `JobIntent`; the
 * API and workers persist it in `job_outbox` in the same transaction as the state change, and the
 * worker's relay later delivers it to pg-boss (specs 02 §3.2, 03 §2.1).
 */

export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately';

/** Mirrors pg-boss 10 `createQueue` options (retry/expiration/retention/policy). */
export interface QueueCreateOptions {
  policy: QueuePolicy;
  retryLimit: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

const iso = z.iso.datetime({ offset: true });
/** Short machine-readable trigger label, e.g. `match`, `cards`, `ingest`. */
const reasonSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/, 'invalid reason');

const empty = z.object({}).strict();
/** A keyset position `(latest eligible arrival, article id)` of a reprocessing continuation. */
const reprocessCursor = z.object({ key: iso, articleId: IdSchema }).strict();
const articleOnly = z.object({ articleId: IdSchema }).strict();
const userOnly = z.object({ userId: UuidSchema }).strict();
const analysisPayload = z.object({ analysisRequestId: UuidSchema }).strict();
const enrichPayload = z
  .object({ articleId: IdSchema, priority: z.enum(['interactive', 'bulk']).optional() })
  .strict();

const reenrichPayload = z
  .object({
    since: iso.optional(),
    lang: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    // Set only on a continuation (spec 11 §6): the pass resumes strictly below this position,
    // with `since` frozen at the first run.
    cursor: reprocessCursor.optional(),
  })
  .strict();
const rematchPayload = z
  .object({
    since: iso.optional(),
    cardId: IdSchema.optional(),
    // Set only on a continuation (spec 11 §6), as for `house.reenrich`.
    cursor: reprocessCursor.optional(),
  })
  .strict();

export const TRANSLATE_SKIP_REASONS = ['no_key', 'cap', 'budget'] as const;

/**
 * `user.estimate` is debounced per user by this many seconds: pg-boss starts the first job of a slot
 * at once and one trailing job at the slot's end, and the handler trains only when its inputs changed.
 */
export const ESTIMATE_DEBOUNCE_SECONDS = 20;

/** Housekeeping cron queues (spec 11 §6): empty payload, `singleton` policy. */
export const HOUSE_CRON_QUEUES = [
  'house.rescore-degraded',
  'house.expire-rules',
  'house.purge-auth',
  'house.reconcile',
  'house.archive',
  'house.purge-articles',
  'house.purge-bodies',
  'house.purge-engine-calls',
  'house.retire-cards',
  'house.purge-users',
  'house.nightly-learn',
  'house.metrics',
  'house.alerts',
  'house.model-watch',
] as const;
export type HouseCronQueue = (typeof HOUSE_CRON_QUEUES)[number];

interface QueueSpec<S extends z.ZodType> {
  payload: S;
  /** Consumers per worker process (batchSize 1 each). */
  concurrency: number;
  options: QueueCreateOptions;
  /** Consumed only by the dedicated Laya worker; `WORKER_QUEUES=*` excludes it. */
  layaOnly?: true;
}

const spec = <S extends z.ZodType>(s: QueueSpec<S>): QueueSpec<S> => s;

/**
 * Expiration of the multi-call model stages (spec 03 §2.1): a job starts no call after the
 * worker's 10-minute job budget and one call ends within its 10-minute lease, so 30 minutes covers
 * the wall time plus the shutdown margin. Single-call stages keep pg-boss's 15-minute default.
 */
export const MODEL_JOB_EXPIRE_SECONDS = 30 * 60;

const houseSpecs = Object.fromEntries(
  HOUSE_CRON_QUEUES.map((name) => [
    name,
    spec({ payload: empty, concurrency: 1, options: { policy: 'singleton', retryLimit: 1 } }),
  ]),
) as Record<HouseCronQueue, QueueSpec<typeof empty>>;

/**
 * How long a job that failed because its worker was stale (the model pin or a restart-class setting
 * moved) waits before its retry, by when a drained worker has restarted. Flat, never backed off.
 */
export const STALE_WORKER_RETRY_DELAY_SECONDS = 30;

export const QUEUES = {
  'feed.schedule': spec({
    payload: empty,
    concurrency: 1,
    options: { policy: 'standard', retryLimit: 0 },
  }),
  'feed.fetch': spec({
    payload: z.object({ feedId: IdSchema, force: z.boolean().optional() }).strict(),
    concurrency: 16,
    options: { policy: 'stately', retryLimit: 0, expireInSeconds: 120 },
  }),
  'article.extract': spec({
    payload: articleOnly,
    concurrency: 8,
    options: {
      policy: 'stately',
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 180,
    },
  }),
  'analysis.process': spec({
    payload: analysisPayload,
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 1, expireInSeconds: MODEL_JOB_EXPIRE_SECONDS },
  }),
  'analysis.process.laya': spec({
    payload: analysisPayload,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1, expireInSeconds: MODEL_JOB_EXPIRE_SECONDS },
    layaOnly: true,
  }),
  'article.capture-bookmark': spec({
    payload: articleOnly,
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 2, retryDelay: 30, retryBackoff: true },
  }),
  'article.translate': spec({
    payload: z
      .object({
        articleId: IdSchema,
        forceTier2: z.boolean().optional(),
        replaceSkipped: z.boolean().optional(),
        modeChange: z.boolean().optional(),
        // Set by a rebuild (`house.reenrich`): the enrichment that follows runs in bulk priority.
        priority: z.enum(['interactive', 'bulk']).optional(),
        // Set only on the delayed retry of a transient failure at the provider's retry time
        // (spec 07 §3): that job is the last attempt.
        retried: z.boolean().optional(),
      })
      .strict(),
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'article.enrich': spec({
    payload: enrichPayload,
    concurrency: 8,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'article.enrich.laya': spec({
    payload: enrichPayload,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
    layaOnly: true,
  }),
  'article.cluster': spec({
    payload: articleOnly,
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'article.match': spec({
    payload: z
      .object({
        articleId: IdSchema,
        // Set only on a level-2-only retry (spec 05 §4): its failed attempts so far; the fifth
        // failure gives up, as for a `match_queue` row.
        l2Attempts: z.number().int().min(0).max(4).optional(),
      })
      .strict(),
    concurrency: 8,
    options: {
      policy: 'stately',
      retryLimit: 1,
      retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS,
      expireInSeconds: MODEL_JOB_EXPIRE_SECONDS,
    },
  }),
  'card.backfill': spec({
    payload: z
      .object({
        userId: UuidSchema,
        cardIds: z.array(IdSchema).min(1).max(500),
        feedIds: z.array(IdSchema).max(2000).optional(),
        snapshotAt: iso.optional(),
        cursor: z.object({ firstSeenAt: iso, articleId: IdSchema }).strict().optional(),
        processedCount: z.number().int().min(0).optional(),
      })
      .strict(),
    concurrency: 2,
    options: { policy: 'standard', retryLimit: 2, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'user.rank': spec({
    payload: z
      .object({
        userId: UuidSchema,
        reason: reasonSchema,
        full: z.boolean().optional(),
        // Set only on the continuation of a full run (spec 06 §7 step 5): the run's snapshot time;
        // rows scored at or after it are not forced again.
        snapshotAt: iso.optional(),
        // Set only on a continuation: the last window position the previous run visited; the run
        // resumes strictly below it.
        cursor: z.object({ arrival: iso, articleId: IdSchema }).strict().optional(),
        // Present only on the refresh of a reader's word estimates (visible-learning §4.4, spec 06
        // §8.6): the run re-ranks the rows whose source is none or estimate and writes only those
        // whose tier or P moved. `{}` starts it; a continuation carries the estimate model version it
        // scored with and the unread rows whose tier rose (`up`) or fell (`down`) so far.
        estimate: z
          .object({
            version: z.number().int().min(1).optional(),
            up: z.number().int().min(0).optional(),
            down: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((p) => !(p.full === true && p.estimate !== undefined), {
        message: 'a full rank and an estimate refresh are exclusive',
      }),
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 2 },
  }),
  'user.learn': spec({
    payload: userOnly,
    concurrency: 2,
    options: { policy: 'standard', retryLimit: 1 },
  }),
  // The per-user word estimate (visible-learning §4.4): trains and stores the model, then records the
  // refresh rank. `stately`: one created job per user, later sends fold into it.
  'user.estimate': spec({
    payload: userOnly,
    concurrency: 2,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'user.suggest': spec({
    payload: userOnly,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  // A card draft the person is waiting for in the editor (D-240): quick, one retry.
  'card.draft': spec({
    payload: z.object({ draftId: UuidSchema }).strict(),
    concurrency: 2,
    options: { policy: 'standard', retryLimit: 1 },
  }),
  ...houseSpecs,
  'provider.validate': spec({
    payload: z
      .object({ provider: z.enum(['typesafe', 'ollama']), candidateVersion: IdSchema })
      .strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 0 },
  }),
  // One synthetic request asking Jev which model an id maps to (visible-learning §4.1). The result
  // lands in settings['engine.model_probe']; a failed probe is a result, never a retry.
  'engine.model-probe': spec({
    payload: z.object({ model: z.string().regex(MODEL_ID_PATTERN) }).strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 0 },
  }),
  'house.reenrich': spec({
    payload: reenrichPayload,
    concurrency: 1,
    options: { policy: 'singleton', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'house.translate-cards': spec({
    payload: z.object({ userId: UuidSchema.optional() }).strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
  'house.retranslate-skipped': spec({
    payload: z
      .object({ reasons: z.array(z.enum(TRANSLATE_SKIP_REASONS)).min(1).max(3).optional() })
      .strict(),
    concurrency: 1,
    options: { policy: 'singleton', retryLimit: 1 },
  }),
  'house.rematch': spec({
    payload: rematchPayload,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1, retryDelay: STALE_WORKER_RETRY_DELAY_SECONDS },
  }),
} as const;

export type QueueName = keyof typeof QUEUES;

/**
 * Queues whose handlers fail a job on a stale worker (`StaleWorkerError`) and so rely on the queue's
 * {@link STALE_WORKER_RETRY_DELAY_SECONDS}. `analysis.process` reschedules itself; interactive
 * `card.draft` keeps immediate queue retries and relies on its delayed recovery intent when stale.
 */
export const STALE_GUARDED_QUEUES = [
  'user.suggest',
  'article.translate',
  'article.enrich',
  'article.cluster',
  'article.match',
  'card.backfill',
  'house.reenrich',
  'house.rematch',
  'house.translate-cards',
  'article.enrich.laya',
] as const satisfies readonly QueueName[];

export type JobPayload<Q extends QueueName> = z.output<(typeof QUEUES)[Q]['payload']>;
export type JobPayloadInput<Q extends QueueName> = z.input<(typeof QUEUES)[Q]['payload']>;

export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];

/** Queues consumed only by the dedicated Laya worker (spec 03 §2). */
export const LAYA_QUEUES = QUEUE_NAMES.filter((q) => QUEUES[q].layaOnly === true);

export function isQueueName(value: string): value is QueueName {
  return Object.hasOwn(QUEUES, value);
}

/**
 * Queues a worker consumes for a `WORKER_QUEUES` value: `*` means every queue except the dedicated
 * Laya queues; otherwise an explicit comma list (unknown names are rejected).
 */
export function resolveWorkerQueues(setting: string): QueueName[] {
  const trimmed = setting.trim();
  if (trimmed === '*') return QUEUE_NAMES.filter((q) => !LAYA_QUEUES.includes(q));
  const names = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) throw new Error('WORKER_QUEUES lists no queue');
  const unknown = names.filter((n) => !isQueueName(n));
  if (unknown.length > 0)
    throw new Error(`WORKER_QUEUES lists unknown queues: ${unknown.join(', ')}`);
  return [...new Set(names)] as QueueName[];
}

/** Validate a payload for a queue (handlers drop invalid jobs with an error log, never retry). */
export function parseJobPayload<Q extends QueueName>(queue: Q, data: unknown): JobPayload<Q> {
  return QUEUES[queue].payload.parse(data) as JobPayload<Q>;
}

export function safeParseJobPayload<Q extends QueueName>(
  queue: Q,
  data: unknown,
): { success: true; data: JobPayload<Q> } | { success: false; error: z.ZodError } {
  const r = QUEUES[queue].payload.safeParse(data);
  return r.success
    ? { success: true, data: r.data as JobPayload<Q> }
    : { success: false, error: r.error };
}

/** How the relay hands an intent to pg-boss. */
export type SendSpec =
  { kind: 'send'; singletonKey?: string } | { kind: 'debounced'; key: string; seconds: number };

/** A validated, durable job request (stored in `job_outbox`, spec 02 §3.2). */
export interface JobIntent<Q extends QueueName = QueueName> {
  queue: Q;
  payload: JobPayload<Q>;
  send: SendSpec;
  /**
   * Coalesces identical pending work only: canonical JSON of the complete validated payload and the
   * producer's revision (spec 02 §3.2). `null` when coalescing is unnecessary.
   */
  dedupeKey: string | null;
}

/** Durable sink for job intents: the outbox writer (db) or, in the relay, pg-boss. */
export interface JobSender {
  enqueue(intent: JobIntent): Promise<void>;
  /** Persist a fan-out in one statement when the sink supports it. */
  enqueueMany?(intents: readonly JobIntent[]): Promise<void>;
}

export interface EnqueueOptions {
  /** Content/input revision the producer observed; part of the dedupe fingerprint. */
  revision?: string;
}

/** Build a validated intent. Every enqueue helper goes through here. */
export function buildJobIntent<Q extends QueueName>(
  queue: Q,
  payload: JobPayloadInput<Q>,
  opts: EnqueueOptions = {},
): JobIntent<Q> {
  const data = parseJobPayload(queue, payload);
  return {
    queue,
    payload: data,
    send: sendSpecFor(queue, data),
    dedupeKey: canonicalJson({ payload: data, revision: opts.revision ?? null }),
  };
}

/** Singleton/debounce keys of spec 03 §2. */
export function sendSpecFor<Q extends QueueName>(queue: Q, payload: JobPayload<Q>): SendSpec {
  const p = payload as Record<string, unknown>;
  const id = (key: string): string => String(p[key]);
  switch (queue) {
    case 'feed.fetch':
      return { kind: 'send', singletonKey: `feed:${id('feedId')}` };
    case 'article.extract':
      return { kind: 'send', singletonKey: `extract:${id('articleId')}` };
    case 'analysis.process':
      return { kind: 'send', singletonKey: `analysis:${id('analysisRequestId')}` };
    case 'analysis.process.laya':
      return { kind: 'send', singletonKey: `analysis-laya:${id('analysisRequestId')}` };
    case 'article.capture-bookmark':
      return { kind: 'send', singletonKey: `capture-bookmark:${id('articleId')}` };
    case 'article.translate':
      return { kind: 'send', singletonKey: translateKey(p) };
    case 'article.enrich':
      return { kind: 'send', singletonKey: `enrich:${id('articleId')}` };
    case 'article.enrich.laya':
      return { kind: 'send', singletonKey: `enrich-laya:${id('articleId')}` };
    case 'article.cluster':
      return { kind: 'send', singletonKey: `cluster:${id('articleId')}` };
    case 'article.match':
      return { kind: 'send', singletonKey: `match:${id('articleId')}` };
    case 'user.rank':
      if (p['cursor'] !== undefined) {
        // A continuation has a key of its own per position: it never swallows, and is never
        // swallowed by, an event's incremental or full rank. The estimate refresh walks the same
        // positions, so its continuations have a prefix of their own.
        const cursor = p['cursor'] as { arrival: string; articleId: string };
        const prefix = p['estimate'] === undefined ? 'rank-cont' : 'rank-est-cont';
        return {
          kind: 'send',
          singletonKey: `${prefix}:${id('userId')}:${cursor.arrival}:${cursor.articleId}`,
        };
      }
      if (p['estimate'] !== undefined) {
        return { kind: 'send', singletonKey: `rank-est:${id('userId')}` };
      }
      return p['full'] === true
        ? { kind: 'send', singletonKey: `rank-full:${id('userId')}` }
        : { kind: 'debounced', key: `rank:${id('userId')}`, seconds: 3 };
    case 'user.learn':
      return { kind: 'debounced', key: `learn:${id('userId')}`, seconds: 60 };
    case 'user.estimate':
      return {
        kind: 'debounced',
        key: `estimate:${id('userId')}`,
        seconds: ESTIMATE_DEBOUNCE_SECONDS,
      };
    case 'user.suggest':
      return { kind: 'send', singletonKey: `suggest:${id('userId')}` };
    case 'card.draft':
      return { kind: 'send', singletonKey: `card-draft:${id('draftId')}` };
    case 'provider.validate':
      return {
        kind: 'send',
        singletonKey: `provider-validate:${id('provider')}:${id('candidateVersion')}`,
      };
    case 'engine.model-probe':
      return { kind: 'send', singletonKey: `model-probe:${id('model')}` };
    case 'house.translate-cards':
      return {
        kind: 'send',
        singletonKey:
          p['userId'] === undefined ? 'translate-cards:all' : `translate-cards:${id('userId')}`,
      };
    case 'house.reenrich':
      if (p['cursor'] !== undefined) {
        // A continuation has a key of its own per position, so a fresh trigger is never absorbed.
        const cursor = p['cursor'] as { key: string; articleId: string };
        return {
          kind: 'send',
          singletonKey: `reenrich-cont:${String(p['lang'] ?? 'all')}:${cursor.key}:${cursor.articleId}`,
        };
      }
      return { kind: 'send' };
    case 'house.rematch':
      if (p['cursor'] !== undefined) {
        const cursor = p['cursor'] as { key: string; articleId: string };
        return {
          kind: 'send',
          singletonKey: `rematch-cont:${String(p['cardId'] ?? 'all')}:${cursor.key}:${cursor.articleId}`,
        };
      }
      return {
        kind: 'send',
        singletonKey: p['cardId'] === undefined ? 'rematch:all' : `rematch:${id('cardId')}`,
      };
    default:
      return { kind: 'send' };
  }
}

/**
 * One key per handler behaviour, so coalescing never drops a flag (spec 03 §2): plain jobs,
 * `forceTier2` alone, `replaceSkipped` and `modeChange` each have their own key. A `retried` job
 * keeps the key of the job it retries.
 */
function translateKey(p: Record<string, unknown>): string {
  const articleId = String(p['articleId']);
  if (p['modeChange'] === true) return `translate-mode:${articleId}`;
  if (p['replaceSkipped'] === true) return `retranslate:${articleId}`;
  if (p['forceTier2'] === true) return `translate-t2:${articleId}`;
  return `translate:${articleId}`;
}

// ── Typed enqueue helpers ────────────────────────────────────────────────────────────────────

const enqueue = async <Q extends QueueName>(
  sender: JobSender,
  queue: Q,
  payload: JobPayloadInput<Q>,
  opts?: EnqueueOptions,
): Promise<void> => {
  await sender.enqueue(buildJobIntent(queue, payload, opts));
};

export const enqueueSchedule = (s: JobSender) => enqueue(s, 'feed.schedule', {});
export const enqueueFetch = (s: JobSender, p: JobPayloadInput<'feed.fetch'>) =>
  enqueue(s, 'feed.fetch', p);
export const enqueueExtract = (
  s: JobSender,
  p: JobPayloadInput<'article.extract'>,
  o?: EnqueueOptions,
) => enqueue(s, 'article.extract', p, o);
export const enqueueAnalysis = (
  s: JobSender,
  p: JobPayloadInput<'analysis.process'>,
  o: { laya?: boolean } = {},
) => enqueue(s, o.laya === true ? 'analysis.process.laya' : 'analysis.process', p);
export const enqueueCaptureBookmark = (
  s: JobSender,
  p: JobPayloadInput<'article.capture-bookmark'>,
  o?: EnqueueOptions,
) => enqueue(s, 'article.capture-bookmark', p, o);
export const enqueueTranslate = (
  s: JobSender,
  p: JobPayloadInput<'article.translate'>,
  o?: EnqueueOptions,
) => enqueue(s, 'article.translate', p, o);
export const enqueueEnrich = (
  s: JobSender,
  p: JobPayloadInput<'article.enrich'>,
  o: EnqueueOptions & { laya?: boolean } = {},
) => enqueue(s, o.laya === true ? 'article.enrich.laya' : 'article.enrich', p, o);
export const enqueueCluster = (
  s: JobSender,
  p: JobPayloadInput<'article.cluster'>,
  o?: EnqueueOptions,
) => enqueue(s, 'article.cluster', p, o);
export const enqueueMatch = (
  s: JobSender,
  p: JobPayloadInput<'article.match'>,
  o?: EnqueueOptions,
) => enqueue(s, 'article.match', p, o);
export const enqueueBackfill = (s: JobSender, p: JobPayloadInput<'card.backfill'>) =>
  enqueue(s, 'card.backfill', p);
export const enqueueRank = (s: JobSender, p: JobPayloadInput<'user.rank'>, o?: EnqueueOptions) =>
  enqueue(s, 'user.rank', p, o);
export const enqueueLearn = (s: JobSender, p: JobPayloadInput<'user.learn'>) =>
  enqueue(s, 'user.learn', p);
export const enqueueEstimate = (s: JobSender, p: JobPayloadInput<'user.estimate'>) =>
  enqueue(s, 'user.estimate', p);

async function enqueueMany(sender: JobSender, intents: readonly JobIntent[]): Promise<void> {
  if (intents.length === 0) return;
  if (sender.enqueueMany !== undefined) await sender.enqueueMany(intents);
  else for (const intent of intents) await sender.enqueue(intent);
}

/** The same validated intents as the single-user helpers, with an optional batch sink. */
export const enqueueRankMany = async (
  sender: JobSender,
  payloads: readonly JobPayloadInput<'user.rank'>[],
  opts?: EnqueueOptions,
) =>
  enqueueMany(
    sender,
    payloads.map((payload) => buildJobIntent('user.rank', payload, opts)),
  );
export const enqueueLearnMany = async (sender: JobSender, userIds: readonly string[]) =>
  enqueueMany(
    sender,
    userIds.map((userId) => buildJobIntent('user.learn', { userId })),
  );
export const enqueueEstimateMany = async (sender: JobSender, userIds: readonly string[]) =>
  enqueueMany(
    sender,
    userIds.map((userId) => buildJobIntent('user.estimate', { userId })),
  );

export const enqueueSuggest = (s: JobSender, p: JobPayloadInput<'user.suggest'>) =>
  enqueue(s, 'user.suggest', p);
export const enqueueCardDraft = (s: JobSender, p: JobPayloadInput<'card.draft'>) =>
  enqueue(s, 'card.draft', p);
export const enqueueHouse = (s: JobSender, queue: HouseCronQueue) => enqueue(s, queue, {});
export const enqueueProviderValidate = (s: JobSender, p: JobPayloadInput<'provider.validate'>) =>
  enqueue(s, 'provider.validate', p);
export const enqueueModelProbe = (s: JobSender, p: JobPayloadInput<'engine.model-probe'>) =>
  enqueue(s, 'engine.model-probe', p);
/** Asks the worker to probe `jev-latest` now (Admin "Check now", worker start, the retired-model trigger). */
export const enqueueModelWatch = (s: JobSender, o?: EnqueueOptions) =>
  enqueue(s, 'house.model-watch', {}, o);
export const enqueueReenrich = (s: JobSender, p: JobPayloadInput<'house.reenrich'>) =>
  enqueue(s, 'house.reenrich', p);
export const enqueueTranslateCards = (s: JobSender, p: JobPayloadInput<'house.translate-cards'>) =>
  enqueue(s, 'house.translate-cards', p);
export const enqueueRetranslateSkipped = (
  s: JobSender,
  p: JobPayloadInput<'house.retranslate-skipped'>,
) => enqueue(s, 'house.retranslate-skipped', p);
export const enqueueRematch = (s: JobSender, p: JobPayloadInput<'house.rematch'>) =>
  enqueue(s, 'house.rematch', p);

/** `feed.schedule` runs each minute (spec 03 §3). */
export const FEED_SCHEDULE_CRON = '* * * * *';

/** A housekeeping job's cron (UTC) and its period. */
export interface HouseCronSchedule {
  cron: string;
  /** A last recorded run older than this is overdue at worker startup (spec 11 §6). */
  everyMs: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Cron schedules (spec 11 §6) of every housekeeping job. A
 * worker registers the schedule of each such queue it consumes, and enqueues an overdue one once
 * at startup.
 */
export const HOUSE_CRON_SCHEDULES: Readonly<Partial<Record<HouseCronQueue, HouseCronSchedule>>> =
  Object.freeze({
    'house.rescore-degraded': { cron: '*/10 * * * *', everyMs: 10 * 60_000 },
    'house.expire-rules': { cron: '5 * * * *', everyMs: 60 * 60_000 },
    'house.purge-auth': { cron: '20 * * * *', everyMs: 60 * 60_000 },
    'house.reconcile': { cron: '*/10 * * * *', everyMs: 10 * 60_000 },
    'house.archive': { cron: '15 3 * * *', everyMs: DAY_MS },
    'house.purge-articles': { cron: '30 3 * * *', everyMs: DAY_MS },
    'house.purge-bodies': { cron: '45 3 * * *', everyMs: DAY_MS },
    'house.purge-engine-calls': { cron: '0 4 * * *', everyMs: DAY_MS },
    'house.retire-cards': { cron: '30 4 * * *', everyMs: DAY_MS },
    'house.purge-users': { cron: '0 5 * * *', everyMs: DAY_MS },
    'house.nightly-learn': { cron: '0 1 * * *', everyMs: DAY_MS },
    'house.metrics': { cron: '10 0 * * *', everyMs: DAY_MS },
    'house.alerts': { cron: '*/5 * * * *', everyMs: 5 * 60_000 },
    'house.model-watch': { cron: '35 */6 * * *', everyMs: 6 * 60 * 60_000 },
  });

/** Jobs that persist progress in `settings['house.progress']` (spec 02 §2, spec 11 §6). */
export const HOUSE_PROGRESS_JOBS = [
  ...HOUSE_CRON_QUEUES,
  'house.reenrich',
  'house.rematch',
  'house.translate-cards',
  'house.retranslate-skipped',
] as const;
export type HouseProgressJob = (typeof HOUSE_PROGRESS_JOBS)[number];

/** A keyset position `(latest eligible arrival, article id)`, descending. */
const recoveryCursor = z.object({ key: iso, articleId: IdSchema }).strict();

/** The cursor of a rebuild job: its runs waiting for the primary engine (at most 20). */
const pendingRuns = <S extends z.ZodType>(run: S) =>
  z.object({ pending: z.array(run).max(20) }).strict();

/**
 * The cursor of a housekeeping job that sweeps in keyset pages under a time budget: the position
 * (last examined id) of the one sweep a run left unfinished, by sweep name. A run that reaches
 * the end of a sweep removes its entry; the next run resumes after the saved id.
 */
const sweepCursor = z
  .object({ sweeps: z.record(z.string().min(1).max(40), z.string().min(1).max(40)) })
  .strict();
export type SweepCursor = z.output<typeof sweepCursor>;

/**
 * Per-job cursor schemas of `settings['house.progress'][job].cursor` (spec 02 §2) for the jobs
 * implemented so far; M8 registers the rest. A stored cursor that does not parse restarts that
 * job's pass instead of failing it.
 */
export const HOUSE_PROGRESS_CURSORS = {
  /** The two recovery pages' positions; an absent page starts a fresh pass (spec 04 §5). */
  'house.rescore-degraded': z
    .object({ enrich: recoveryCursor.optional(), answers: recoveryCursor.optional() })
    .strict(),
  /**
   * Runs that found Jev unavailable and wait for `house.reconcile` to enqueue them again, with
   * their frozen `since` and cursor (spec 11 §6).
   */
  'house.reenrich': pendingRuns(reenrichPayload),
  'house.rematch': pendingRuns(rematchPayload),
  /** Keyset positions of the sweeps a budget cut short (spec 11 §6). */
  'house.purge-articles': sweepCursor,
  'house.purge-bodies': sweepCursor,
  'house.retire-cards': sweepCursor,
  /** The last user id of the due-user rank sweep a budget cut short, under `rank` (spec 11 §6). */
  'house.reconcile': sweepCursor,
  /** The last card id of the unrestricted `house.translate-cards` pass a budget cut short. */
  'house.translate-cards': z.object({ after: IdSchema }).strict(),
  /**
   * Set while users erased 7 days ago wait because the deletion ledger or its HMAC key is not
   * configured (outside production): `house.alerts` raises `erasure.disabled` from it (spec 11 §5.1).
   * `failed` is set by a run in which a ledger append, a deletion or a card reference failed or
   * blocked users: the run is not complete and `house.alerts` raises `erasure.failed` until a later
   * run completes cleanly.
   */
  'house.purge-users': z.union([
    z.object({ disabled: z.literal('ledger_unconfigured') }).strict(),
    z
      .object({
        failed: z
          .object({
            ledger: z.number().int().nonnegative(),
            db: z.number().int().nonnegative(),
            blocked: z.number().int().nonnegative(),
          })
          .strict(),
        at: z.string(),
      })
      .strict(),
  ]),
} as const satisfies Partial<Record<HouseProgressJob, z.ZodType>>;
export type HouseProgressCursor<J extends keyof typeof HOUSE_PROGRESS_CURSORS> = z.output<
  (typeof HOUSE_PROGRESS_CURSORS)[J]
>;
