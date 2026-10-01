import {
  promotionEligibility,
  readStoredSetting,
  type AdminCredentialRow,
  type Executor,
  type AdminPublicationRequestRow,
} from '@bantoozi/db';
import {
  LAYA_QUEUES,
  WorkerHeartbeatSchema,
  type CredentialStatus,
  type Provider,
  type PromotionRequest,
} from '@bantoozi/shared';
import type { FastifyRequest } from 'fastify';

import { queryHash } from '../../services/cursor.js';

/** Shared helpers of the admin routes (spec 08 §9). */

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();

/** A heartbeat entry is fresh while younger than 90 s (spec 08 §9.1, spec 11 §2). */
export const HEARTBEAT_FRESH_MS = 90_000;

export interface FreshWorker {
  queues: readonly string[];
  envCredentials: readonly Provider[];
}

/**
 * The fresh entries of `settings['worker.heartbeat']` (`{[processId]: {at, queues, evalIngestOnly,
 * envCredentials}}`, written by every worker every 30 s). Parsed defensively entry by entry: a
 * missing row, a malformed row or a malformed entry counts as no worker, never as an error.
 */
export async function freshWorkers(db: Executor, now: Date): Promise<FreshWorker[]> {
  let stored: unknown;
  try {
    stored = await readStoredSetting(db, 'worker.heartbeat');
  } catch {
    return [];
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return [];
  const workers: FreshWorker[] = [];
  for (const [processId, entry] of Object.entries(stored as Record<string, unknown>)) {
    const parsed = WorkerHeartbeatSchema.safeParse({ [processId]: entry });
    if (!parsed.success) continue;
    const value = parsed.data[processId];
    if (value === undefined) continue;
    const age = now.getTime() - Date.parse(value.at);
    if (!Number.isFinite(age) || age > HEARTBEAT_FRESH_MS || age < -HEARTBEAT_FRESH_MS) continue;
    workers.push({ queues: value.queues, envCredentials: value.envCredentials });
  }
  return workers;
}

/** Whether a fresh worker consumes both dedicated Laya queues (spec 08 §9 `engine.laya`). */
export function layaConsumerPresent(workers: readonly FreshWorker[]): boolean {
  return workers.some((worker) => LAYA_QUEUES.every((queue) => worker.queues.includes(queue)));
}

/**
 * `CredentialStatus` (spec 08 §9.1): `db` when a row exists (a disabled tombstone included), else
 * `env` when a fresh worker heartbeat lists the provider in `envCredentials`, else `none`. The API
 * never receives the env keys themselves. Only allowlisted metadata is returned.
 */
export function credentialStatus(
  provider: Provider,
  row: AdminCredentialRow | undefined,
  workers: readonly FreshWorker[],
): CredentialStatus {
  if (row === undefined) {
    const env = workers.some((worker) => worker.envCredentials.includes(provider));
    return {
      provider,
      source: env ? 'env' : 'none',
      enabled: env,
      revision: '0',
      activeVersion: null,
      candidateVersion: null,
      candidateStatus: null,
      validatedAt: null,
      capabilities: null,
      lastErrorCode: null,
    };
  }
  const validation = row.candidateValidation;
  const hasCapabilities =
    validation.model !== undefined ||
    validation.concurrencyLimit !== undefined ||
    validation.capabilities !== undefined;
  return {
    provider,
    source: 'db',
    enabled: row.enabled,
    revision: row.revision,
    activeVersion: row.activeVersion,
    candidateVersion: row.candidateVersion,
    candidateStatus: row.candidateStatus,
    validatedAt: isoOrNull(row.validatedAt),
    capabilities: hasCapabilities
      ? {
          model: validation.model ?? null,
          concurrencyLimit: validation.concurrencyLimit ?? null,
          flags: { ...validation.capabilities },
        }
      : null,
    lastErrorCode: row.lastErrorCode,
  };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The publication request DTO with its advisory eligibility (spec 08 §9.2). */
export function toPromotionRequest(row: AdminPublicationRequestRow, now: Date): PromotionRequest {
  const payload = row.payload;
  const i18n = payload['i18n'];
  const sk =
    i18n !== null && typeof i18n === 'object' && !Array.isArray(i18n)
      ? (i18n as Record<string, unknown>)['sk']
      : undefined;
  const topics = payload['topic_ids'];
  return {
    id: row.id,
    cardId: row.cardId,
    cardTitle: row.cardTitle,
    status: row.status,
    version: row.version,
    requestedAt: iso(row.requestedAt),
    expiresAt: isoOrNull(row.expiresAt),
    respondedAt: isoOrNull(row.respondedAt),
    payload: {
      slug: asString(payload['slug']),
      title: asString(payload['title']),
      titleSk:
        sk !== null && typeof sk === 'object'
          ? asString((sk as Record<string, unknown>)['title'])
          : null,
      topicIds: Array.isArray(topics)
        ? topics.filter((t): t is string => typeof t === 'string')
        : [],
    },
    publicationSha: row.publicationSha,
    holders: row.holders,
    creatorKnown: row.creatorKnown,
    vetoed: row.vetoed,
    promotionEligibility: promotionEligibility(row, now),
    authorizationKind: row.authorizationKind,
    promotedAt: isoOrNull(row.promotedAt),
  };
}

/** Lifetime of an admin list cursor. */
export const ADMIN_CURSOR_TTL_SECONDS = 3600;

/** Decode an admin list cursor bound to this admin and the normalized query. */
export function decodeAdminCursor<K>(
  request: FastifyRequest,
  route: string,
  query: Record<string, unknown>,
): K | undefined {
  const cursor = query['cursor'];
  if (typeof cursor !== 'string') return undefined;
  const { cursors } = request.server.services;
  return cursors.decode<K, never>(cursor, {
    userId: request.auth!.userId,
    query: queryHash({ route, ...query, limit: undefined }),
  }).key;
}

/** The next-page cursor for the last row of a full page, or null. */
export function nextAdminCursor<K>(
  request: FastifyRequest,
  route: string,
  query: Record<string, unknown>,
  hasMore: boolean,
  key: K | undefined,
): string | null {
  if (!hasMore || key === undefined) return null;
  return request.server.services.cursors.encode(
    { key, query: queryHash({ route, ...query, limit: undefined }) },
    { userId: request.auth!.userId, ttlSeconds: ADMIN_CURSOR_TTL_SECONDS },
  );
}

/**
 * The admin audit record (spec 08 §9): actor, action, target and changed keys as a structured log
 * line. Never values that may be secret (keys, codes, emails).
 */
export function auditLog(
  request: FastifyRequest,
  entry: { action: string; target?: string; changed?: readonly string[] },
): void {
  request.log.info(
    {
      audit: {
        actor: request.auth?.userId ?? null,
        action: entry.action,
        ...(entry.target === undefined ? {} : { target: entry.target }),
        ...(entry.changed === undefined ? {} : { changed: [...entry.changed] }),
      },
    },
    'admin action',
  );
}
