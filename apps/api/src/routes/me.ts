import { PassThrough } from 'node:stream';

import { withTenant } from '@bantoozi/db';
import { MeExportSchema, MePatchSchema, MeSchema, type MeExport } from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { applyMePatch, loadMe, softDeleteAccount, writeExport } from '../services/me.js';

/** `GET /me/export`: 2 per hour per user (spec 08 §11). */
const EXPORT_LIMIT = { group: 'me-export', max: 2, windowSeconds: 3600, per: 'user' } as const;

/** M4-T3: me, preferences, export and deletion (spec 08 §3). */
export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '',
    {
      schema: { tags: ['me'], summary: 'The signed-in user', response: { 200: MeSchema } },
    },
    async (request) => request.withTx(loadMe),
  );

  app.patch(
    '',
    {
      schema: {
        tags: ['me'],
        summary: 'Update profile and preferences (preferences are deep-merged)',
        body: MePatchSchema,
        response: { 200: MeSchema },
      },
    },
    async (request, reply) => {
      const outcome = await request.mutate(async (tx, { outbox }) => ({
        status: 200,
        body: await applyMePatch(tx, outbox, request.body),
      }));
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '',
    {
      schema: {
        tags: ['me'],
        summary: 'Delete the account (restorable by signing in within 7 days)',
        response: { 204: z.null().describe('Deleted') },
      },
    },
    async (request, reply) => {
      await request.mutate(async (tx) => {
        await softDeleteAccount(tx);
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );

  app.get(
    '/export',
    {
      config: { rateLimits: [EXPORT_LIMIT] },
      schema: {
        tags: ['me'],
        summary: 'Download all of your data as a JSON attachment',
        response: { 200: MeExportSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === null) throw new Error('the auth plugin did not authenticate this request');
      const { db, clock } = app.services;
      const exportedAt = clock.now();
      const sink = new PassThrough();
      // Stop reading, and roll the snapshot back, as soon as the client goes away.
      const cancel = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) cancel.abort();
      });
      sink.on('close', () => {
        if (!sink.writableFinished) cancel.abort();
      });
      // One consistent read-only snapshot (spec 08 §3), streamed while it is read. Fastify sends a
      // stream as is; the response schema documents the document's shape.
      withTenant(
        db,
        auth.userId,
        (tx) => writeExport(tx, sink, { exportedAt, signal: cancel.signal }),
        { isolation: 'repeatable read', readOnly: true },
      ).then(
        () => sink.end(),
        (error: unknown) => {
          if (!cancel.signal.aborted) request.log.error({ err: error }, 'export failed');
          sink.destroy(error instanceof Error ? error : new Error('export failed'));
        },
      );
      const day = exportedAt.toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="bantoozi-export-${day}.json"`)
        .send(sink as unknown as MeExport);
    },
  );
};
