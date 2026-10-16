import {
  createAdminPlan,
  deleteAdminPlan,
  listAdminPlans,
  setDefaultAdminPlan,
  updateAdminPlan,
  type AdminPlanRow,
} from '@bantoozi/db';
import {
  AdminPlanCreateSchema,
  AdminPlanListSchema,
  AdminPlanParamsSchema,
  AdminPlanPatchSchema,
  AdminPlanResultSchema,
  AppError,
  type AdminPlan,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditLog, isoOrNull } from './shared.js';

/**
 * Plans (D-255, spec 08 §6): the tiers and their allowances, edited without a code change. A plan's
 * key never changes. An edit applies live: quota checks read the stored plan, and a new fetch
 * interval recomputes the feeds of the plan's subscribers. A plan in use cannot be deleted (it is
 * retired instead), and the default plan can neither be retired nor deleted.
 */

const toPlan = (row: AdminPlanRow): AdminPlan => ({
  key: row.key,
  label: row.label,
  labelSk: row.labelSk,
  maxFeeds: row.maxFeeds,
  maxCards: row.maxCards,
  maxLabels: row.maxLabels,
  maxForks: row.maxForks,
  maxRules: row.maxRules,
  opmlMaxFeeds: row.opmlMaxFeeds,
  minFetchIntervalS: row.minFetchIntervalS,
  releaseIntervalS: row.releaseIntervalS,
  backfillDays: row.backfillDays,
  invitesOnSignup: row.invitesOnSignup,
  sortOrder: row.sortOrder,
  isDefault: row.isDefault,
  retiredAt: isoOrNull(row.retiredAt),
  version: row.version,
  userCount: row.userCount,
});

const notFound = () => new AppError('NOT_FOUND', 'Plan not found');

export const planRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/plans',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Plans',
        response: { 200: AdminPlanListSchema },
      },
    },
    async (request) => {
      const rows = await request.withTx((tx) => listAdminPlans(tx));
      return { items: rows.map(toPlan) };
    },
  );

  app.post(
    '/plans',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Add a plan',
        body: AdminPlanCreateSchema,
        response: { 201: AdminPlanResultSchema },
      },
    },
    async (request, reply) => {
      const outcome = await request.mutate(async (tx) => {
        const row = await createAdminPlan(tx, request.body);
        if (row === null) {
          throw new AppError('CONFLICT', 'A plan with this key exists', {
            details: { reason: 'plan_exists' },
          });
        }
        return { status: 201, body: { plan: toPlan(row) } };
      });
      auditLog(request, { action: 'plans.create', target: request.body.key });
      await reply.code(201).send(outcome.body);
    },
  );

  app.patch(
    '/plans/:key',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: "Edit a plan's names, limits, order or retirement",
        params: AdminPlanParamsSchema,
        body: AdminPlanPatchSchema,
        response: { 200: AdminPlanResultSchema },
      },
    },
    async (request, reply) => {
      const { key } = request.params;
      let changed: string[] = [];
      const outcome = await request.mutate(async (tx) => {
        const result = await updateAdminPlan(tx, key, request.body);
        if (result.status === 'not_found') throw notFound();
        if (result.status === 'stale') {
          throw new AppError('STALE_STATE', 'The plan was changed by someone else', {
            details: { reason: 'plan_version' },
          });
        }
        if (result.status === 'default_plan') {
          throw new AppError('CONFLICT', 'The default plan cannot be retired', {
            details: { reason: 'default_plan' },
          });
        }
        changed = result.changed;
        return { status: 200, body: { plan: toPlan(result.plan) } };
      });
      auditLog(request, { action: 'plans.patch', target: key, changed });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/plans/:key/default',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Make a plan the default for new users',
        params: AdminPlanParamsSchema,
        response: { 200: AdminPlanResultSchema },
      },
    },
    async (request, reply) => {
      const { key } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const result = await setDefaultAdminPlan(tx, key);
        if (result.status === 'not_found') throw notFound();
        if (result.status === 'retired') {
          throw new AppError('CONFLICT', 'A retired plan cannot be the default', {
            details: { reason: 'plan_retired' },
          });
        }
        return { status: 200, body: { plan: toPlan(result.plan) } };
      });
      auditLog(request, { action: 'plans.default', target: key });
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/plans/:key',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Delete an unused plan',
        params: AdminPlanParamsSchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { key } = request.params;
      await request.mutate(async (tx) => {
        const result = await deleteAdminPlan(tx, key);
        if (result.status === 'not_found') throw notFound();
        if (result.status === 'default_plan') {
          throw new AppError('CONFLICT', 'The default plan cannot be deleted', {
            details: { reason: 'default_plan' },
          });
        }
        if (result.status === 'in_use') {
          throw new AppError('CONFLICT', 'The plan is in use; retire it instead', {
            details: { reason: 'plan_in_use' },
          });
        }
        return { status: 204, body: null };
      });
      auditLog(request, { action: 'plans.delete', target: key });
      await reply.code(204).send(null);
    },
  );
};
