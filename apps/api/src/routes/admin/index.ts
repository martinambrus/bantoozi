import { updateSettingLocked } from '@bantoozi/db';
import {
  AppError,
  OPS_EVENTS_MAX,
  OpsEventBodySchema,
  OpsEventResultSchema,
  SETTINGS,
  canonicalJson,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { accountRoutes } from './accounts.js';
import { engineRoutes } from './engine.js';
import { feedRoutes } from './feeds.js';
import { libraryAdminRoutes } from './library.js';
import { settingsRoutes } from './settings.js';

/** Host scripts may send at most this many ops events per minute and IP (spec 11 §4). */
const OPS_EVENT_LIMIT = { group: 'ops-event', max: 30, windowSeconds: 60, per: 'ip' } as const;

/**
 * Admin endpoints under `/admin` (spec 08 §9). Every route is `auth: 'admin'` (the role is read
 * from the current DB row on each request, and the admin SQL functions check it again), except
 * `POST /admin/ops-event`, which only the `METRICS_TOKEN` bearer may call (CSRF-exempt, no cookie).
 */
export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(engineRoutes);
  await app.register(settingsRoutes);
  await app.register(feedRoutes);
  await app.register(accountRoutes);
  await app.register(libraryAdminRoutes);

  app.post(
    '/ops-event',
    {
      config: { auth: 'metrics', rateLimits: [OPS_EVENT_LIMIT] },
      schema: {
        tags: ['admin'],
        summary: 'Record a host-script ops event (METRICS_TOKEN bearer)',
        body: OpsEventBodySchema,
        response: { 201: OpsEventResultSchema },
      },
    },
    async (request, reply) => {
      const { db, clock } = app.services;
      const event = request.body;
      const at = clock.now().toISOString();
      const detail =
        event.kind === 'host_health' ? canonicalJson(event.detail) : (event.detail ?? '');
      if (detail.length > 2000) {
        throw new AppError('VALIDATION_FAILED', 'Event detail is too large', {
          details: { field: 'detail' },
        });
      }
      // Bearer ops events use their own flow (no session, no idempotency receipt, spec 08 §1.1);
      // the last 50 are kept for `house.alerts`.
      const stored = await db.transaction((tx) =>
        updateSettingLocked(tx, 'ops.events', [], (current) => {
          const parsed = SETTINGS['ops.events'].schema.safeParse(current);
          const events = parsed.success ? parsed.data : [];
          return [...events, { kind: event.kind, detail, at }].slice(-OPS_EVENTS_MAX);
        }),
      );
      request.log.info({ opsEvent: { kind: event.kind } }, 'ops event recorded');
      await reply.code(201).send({ kind: event.kind, at, stored: stored.length });
    },
  );
};
