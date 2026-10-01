import { createHmac } from 'node:crypto';

import {
  lockMutationKey,
  readMutation,
  saveMutation,
  sqlState,
  tenantOutbox,
  withTenant,
  type TenantTx,
} from '@bantoozi/db';
import { AppError, canonicalJson, isUuid } from '@bantoozi/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { MutationContext, MutationOutcome } from '../types.js';

/**
 * Tenancy and idempotent mutations (spec 08 §1 "Tenancy", §1.1).
 *
 * `req.withTx(fn)` opens nothing until it is called, then runs `fn` in a READ COMMITTED transaction
 * whose first statement sets `app.user_id` to the verified session's user, so RLS applies to every
 * per-user table. A request that never touches per-user data opens no transaction.
 *
 * `req.mutate(fn)` wraps an authenticated data mutation: inside the state transaction it locks the
 * `(user, Idempotency-Key)` pair, replays a saved receipt for the same request (or fails with
 * `IDEMPOTENCY_CONFLICT` for a different one), otherwise runs `fn` and saves the outcome before
 * commit. A deadlock or serialization failure retries the whole transaction with the same key.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Bounded retries for deadlock/serialization failures (spec 08 §1.1). */
const MUTATION_ATTEMPTS = 3;
const RETRYABLE = new Set(['40001', '40P01']);

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Sign in required');

/** The canonical route of a request: method and route pattern, e.g. `POST /api/v1/cards/:id`. */
export function canonicalRoute(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? request.url}`;
}

/**
 * Keyed digest of the request a receipt is bound to: method, route pattern, path parameters, query
 * and validated body (spec 08 §1.1). Keyed with `SESSION_PEPPER`, so a receipt never holds a
 * reversible fingerprint of a secret-bearing body (spec 08 §9.1, provider key PUT).
 */
export function requestDigest(request: FastifyRequest, pepper: string): string {
  // A JSON round trip turns Fastify's null-prototype params/query objects (and any Date a schema
  // produced) into the plain values canonicalJson accepts.
  const plain = (value: unknown): unknown =>
    value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
  const material = canonicalJson({
    v: 1,
    route: canonicalRoute(request),
    params: plain(request.params),
    query: plain(request.query),
    body: plain(request.body),
  });
  return createHmac('sha256', pepper).update('bantoozi:mutation:v1').update(material).digest('hex');
}

/** The `Idempotency-Key` header, required on every authenticated data mutation. */
export function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers[IDEMPOTENCY_HEADER];
  if (typeof header !== 'string' || !isUuid(header)) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be a UUID', {
      details: { header: 'Idempotency-Key' },
    });
  }
  return header.toLowerCase();
}

export function registerTenant(app: FastifyInstance): void {
  app.decorateRequest('withTx', function withTx<
    T,
  >(this: FastifyRequest, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const auth = this.auth;
    if (auth === null) return Promise.reject(unauthenticated());
    return withTenant(app.services.db, auth.userId, fn);
  });

  app.decorateRequest('mutate', async function mutate<
    T,
  >(this: FastifyRequest, fn: (tx: TenantTx, ctx: MutationContext) => Promise<MutationOutcome<T>>): Promise<
    MutationOutcome<T>
  > {
    const auth = this.auth;
    if (auth === null) throw unauthenticated();
    const key = idempotencyKey(this);
    const { config, clock } = app.services;
    const digest = requestDigest(this, config.sessionPepper);
    const route = canonicalRoute(this);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.withTx(async (tx) => {
          await lockMutationKey(tx, key);
          const saved = await readMutation(tx, key);
          if (saved !== null) {
            if (saved.requestHash !== digest) {
              throw new AppError(
                'IDEMPOTENCY_CONFLICT',
                'Idempotency-Key was used for a different request',
              );
            }
            return { status: saved.status, body: saved.response as T };
          }
          const outcome = await fn(tx, {
            mutationId: key,
            outbox: tenantOutbox(tx),
            now: clock.now(),
          });
          await saveMutation(tx, {
            key,
            requestHash: digest,
            route,
            status: outcome.status,
            response: outcome.body ?? null,
            ...(outcome.undo === undefined ? {} : { undo: outcome.undo }),
          });
          if (outcome.afterSave !== undefined) await outcome.afterSave(tx);
          return outcome;
        });
      } catch (error) {
        const state = sqlState(error);
        if (attempt >= MUTATION_ATTEMPTS || state === undefined || !RETRYABLE.has(state)) {
          throw error;
        }
      }
    }
  });
}
