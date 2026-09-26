import { z } from 'zod';

import { IdSchema, UuidSchema } from './ids.js';
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
const articleOnly = z.object({ articleId: IdSchema }).strict();
const userOnly = z.object({ userId: UuidSchema }).strict();
const analysisPayload = z.object({ analysisRequestId: UuidSchema }).strict();
const enrichPayload = z
  .object({ articleId: IdSchema, priority: z.enum(['interactive', 'bulk']).optional() })
  .strict();

export const TRANSLATE_SKIP_REASONS = ['no_key', 'cap', 'budget'] as const;

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

const houseSpecs = Object.fromEntries(
  HOUSE_CRON_QUEUES.map((name) => [
    name,
    spec({ payload: empty, concurrency: 1, options: { policy: 'singleton', retryLimit: 1 } }),
  ]),
) as Record<HouseCronQueue, QueueSpec<typeof empty>>;

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
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'analysis.process.laya': spec({
    payload: analysisPayload,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1 },
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
      })
      .strict(),
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'article.enrich': spec({
    payload: enrichPayload,
    concurrency: 8,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'article.enrich.laya': spec({
    payload: enrichPayload,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1 },
    layaOnly: true,
  }),
  'article.cluster': spec({
    payload: articleOnly,
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'article.match': spec({
    payload: articleOnly,
    concurrency: 8,
    options: { policy: 'stately', retryLimit: 1 },
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
    options: { policy: 'standard', retryLimit: 2 },
  }),
  'user.rank': spec({
    payload: z
      .object({ userId: UuidSchema, reason: reasonSchema, full: z.boolean().optional() })
      .strict(),
    concurrency: 4,
    options: { policy: 'stately', retryLimit: 2 },
  }),
  'user.learn': spec({
    payload: userOnly,
    concurrency: 2,
    options: { policy: 'standard', retryLimit: 1 },
  }),
  'user.suggest': spec({
    payload: userOnly,
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  ...houseSpecs,
  'provider.validate': spec({
    payload: z
      .object({ provider: z.enum(['typesafe', 'ollama']), candidateVersion: IdSchema })
      .strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 0 },
  }),
  'house.reenrich': spec({
    payload: z
      .object({
        since: iso.optional(),
        lang: z
          .string()
          .regex(/^[a-z]{2}$/)
          .optional(),
      })
      .strict(),
    concurrency: 1,
    options: { policy: 'singleton', retryLimit: 1 },
  }),
  'house.translate-cards': spec({
    payload: z.object({ userId: UuidSchema.optional() }).strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1 },
  }),
  'house.retranslate-skipped': spec({
    payload: z
      .object({ reasons: z.array(z.enum(TRANSLATE_SKIP_REASONS)).min(1).max(3).optional() })
      .strict(),
    concurrency: 1,
    options: { policy: 'singleton', retryLimit: 1 },
  }),
  'house.rematch': spec({
    payload: z.object({ since: iso.optional(), cardId: IdSchema.optional() }).strict(),
    concurrency: 1,
    options: { policy: 'stately', retryLimit: 1 },
  }),
} as const;

export type QueueName = keyof typeof QUEUES;
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
      return p['full'] === true
        ? { kind: 'send', singletonKey: `rank-full:${id('userId')}` }
        : { kind: 'debounced', key: `rank:${id('userId')}`, seconds: 3 };
    case 'user.learn':
      return { kind: 'debounced', key: `learn:${id('userId')}`, seconds: 60 };
    case 'user.suggest':
      return { kind: 'send', singletonKey: `suggest:${id('userId')}` };
    case 'provider.validate':
      return {
        kind: 'send',
        singletonKey: `provider-validate:${id('provider')}:${id('candidateVersion')}`,
      };
    case 'house.translate-cards':
      return {
        kind: 'send',
        singletonKey:
          p['userId'] === undefined ? 'translate-cards:all' : `translate-cards:${id('userId')}`,
      };
    case 'house.rematch':
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
 * `forceTier2` alone, `replaceSkipped` and `modeChange` each have their own key.
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
export const enqueueSuggest = (s: JobSender, p: JobPayloadInput<'user.suggest'>) =>
  enqueue(s, 'user.suggest', p);
export const enqueueHouse = (s: JobSender, queue: HouseCronQueue) => enqueue(s, queue, {});
export const enqueueProviderValidate = (s: JobSender, p: JobPayloadInput<'provider.validate'>) =>
  enqueue(s, 'provider.validate', p);
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

/** Cron schedules (UTC) of the housekeeping jobs are registered in M8; `feed.schedule` runs each minute. */
export const FEED_SCHEDULE_CRON = '* * * * *';

/**
 * Per-job cursor schemas for `settings['house.progress'][job].cursor` (spec 02 §2). M8 replaces
 * the generic JSON cursors with each job's concrete keyset shape.
 */
export const HOUSE_PROGRESS_JOBS = [
  ...HOUSE_CRON_QUEUES,
  'house.reenrich',
  'house.rematch',
] as const;
