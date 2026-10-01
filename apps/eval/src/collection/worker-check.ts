import { parseSetting, type QueueName } from '@bantoozi/shared';

/**
 * The worker precondition of `eval ingest-sample` (spec 10 §2.1, D-96): a worker heartbeat younger
 * than 90 s with `evalIngestOnly = true` must exist, and **no** live heartbeat may come from an
 * ordinary worker, which would enrich the collected articles and spend on Jev. The heartbeat is not
 * the isolation itself (an ordinary worker also refuses a golden database, D-96); this check makes
 * the command refuse to collect while the database is shared.
 */

/** Spec 10 §2.1: a heartbeat counts as live for 90 s. */
export const HEARTBEAT_FRESH_MS = 90_000;

/** The queues collection needs an ingest-only worker to consume. */
export const COLLECTION_QUEUES: readonly QueueName[] = ['feed.fetch', 'article.extract'];

export interface LiveWorker {
  processId: string;
  at: Date;
  queues: string[];
  evalIngestOnly: boolean;
}

export type WorkerCheck =
  | { ok: true; ingestOnly: LiveWorker[] }
  | {
      ok: false;
      reason: 'no_ingest_only_worker' | 'ordinary_worker_live' | 'queues_not_consumed';
      message: string;
      live: LiveWorker[];
    };

/** The live entries of `settings['worker.heartbeat']` (validated; a malformed value is an error). */
export function liveWorkers(value: unknown, now: Date): LiveWorker[] {
  const parsed = parseSetting('worker.heartbeat', value ?? {});
  const live: LiveWorker[] = [];
  for (const [processId, entry] of Object.entries(parsed)) {
    const at = new Date(entry.at);
    const age = now.getTime() - at.getTime();
    // A heartbeat slightly in the future (clock skew between hosts) still counts as live.
    if (age > HEARTBEAT_FRESH_MS) continue;
    live.push({ processId, at, queues: [...entry.queues], evalIngestOnly: entry.evalIngestOnly });
  }
  return live.sort((a, b) => (a.processId < b.processId ? -1 : a.processId > b.processId ? 1 : 0));
}

export const WORKER_INSTRUCTIONS = [
  'Start a dedicated ingest-only worker on this (golden) database, and stop every other worker on it:',
  '  EVAL_INGEST_ONLY=true DATABASE_URL_WORKER=<this database> pnpm --filter @bantoozi/worker dev',
  'It consumes only feed.schedule, feed.fetch and article.extract and stops after extraction, so',
  'collection never enriches or spends on Jev (spec 10 §2.1). Do not point API/E2E development',
  'workers at the golden database. Then run this command again.',
].join('\n');

export function checkWorkers(value: unknown, now: Date): WorkerCheck {
  const live = liveWorkers(value, now);
  const ordinary = live.filter((w) => !w.evalIngestOnly);
  if (ordinary.length > 0) {
    return {
      ok: false,
      reason: 'ordinary_worker_live',
      live,
      message:
        `refusing to collect: ${ordinary.length} live worker(s) without EVAL_INGEST_ONLY=true ` +
        `(${ordinary.map((w) => w.processId).join(', ')}) serve this database; they would enrich ` +
        `the collected articles.\n${WORKER_INSTRUCTIONS}`,
    };
  }
  const ingestOnly = live.filter((w) => w.evalIngestOnly);
  if (ingestOnly.length === 0) {
    return {
      ok: false,
      reason: 'no_ingest_only_worker',
      live,
      message: `no worker with EVAL_INGEST_ONLY=true sent a heartbeat in the last 90 s.\n${WORKER_INSTRUCTIONS}`,
    };
  }
  const consumed = new Set(ingestOnly.flatMap((w) => w.queues));
  const missing = COLLECTION_QUEUES.filter((q) => !consumed.has(q));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'queues_not_consumed',
      live,
      message:
        `the live ingest-only worker(s) do not consume ${missing.join(', ')} (check WORKER_QUEUES).\n` +
        WORKER_INSTRUCTIONS,
    };
  }
  return { ok: true, ingestOnly };
}
