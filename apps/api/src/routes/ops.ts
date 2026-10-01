import { DevLastEmailSchema } from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * Metrics and the test-only last email (spec 08 §10).
 *
 * - `GET /metrics`: Prometheus text of this API process (`plugins/metrics.ts`), for an admin
 *   session or the `METRICS_TOKEN` bearer.
 * - `GET /dev/last-email`: registered **only** when `NODE_ENV=test`; the last email the mailer
 *   captured with `MAIL_TRANSPORT=log`, for E2E tests.
 */
export const opsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/metrics',
    {
      config: { auth: 'admin_or_metrics' },
      schema: { tags: ['ops'], summary: 'Prometheus metrics (admin session or bearer)' },
    },
    async (_request, reply) => {
      const { registry } = app.metrics;
      const body = await registry.metrics();
      await reply.header('cache-control', 'no-store').type(registry.contentType).send(body);
    },
  );

  if (app.services.config.nodeEnv === 'test') {
    app.get(
      '/dev/last-email',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['ops'],
          summary: 'Last captured email (NODE_ENV=test only)',
          response: { 200: DevLastEmailSchema },
        },
      },
      async (_request, reply) => {
        const last = app.services.mailer.lastEmail?.();
        await reply.header('cache-control', 'no-store').send({
          email:
            last === undefined ? null : { to: last.to, subject: last.subject, text: last.text },
        });
      },
    );
  }
};
