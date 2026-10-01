import {
  listAdminInvites,
  listAdminUsers,
  listAdminWaitlist,
  updateAdminUser,
  type AdminUserRow,
} from '@bantoozi/db';
import {
  AdminInvitePageSchema,
  AdminInvitesQuerySchema,
  AdminUserPageSchema,
  AdminUserParamsSchema,
  AdminUserPatchSchema,
  AdminUserResultSchema,
  AdminUsersQuerySchema,
  AdminWaitlistPageSchema,
  AdminWaitlistQuerySchema,
  AppError,
  type AdminUser,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { auditLog, decodeAdminCursor, iso, isoOrNull, nextAdminCursor } from './shared.js';

/**
 * Users, invites and the waitlist (spec 08 §9). User edits change only role, plan and
 * `invites_left`; they refuse to remove the last active administrator, revoke the sessions of a
 * downgraded user and recompute feed intervals on a plan change. Invite creation and waitlist
 * invitations are separate (M4-T2); these routes only list.
 */

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  const adminEmails = new Set(app.services.config.adminEmails.map((email) => email.toLowerCase()));
  const toUser = (row: AdminUserRow): AdminUser => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    plan: row.plan,
    invitesLeft: row.invitesLeft,
    createdAt: iso(row.createdAt),
    lastActiveAt: isoOrNull(row.lastActiveAt),
    deletedAt: isoOrNull(row.deletedAt),
    adminBootstrap: adminEmails.has(row.email.toLowerCase()),
  });

  app.get(
    '/users',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Users',
        querystring: AdminUsersQuerySchema,
        response: { 200: AdminUserPageSchema },
      },
    },
    async (request) => {
      const { q, limit } = request.query;
      const route = 'admin.users';
      const afterId = decodeAdminCursor<string>(request, route, request.query);
      const rows = await request.withTx((tx) =>
        listAdminUsers(tx, {
          ...(q === undefined ? {} : { q }),
          ...(afterId === undefined ? {} : { afterId }),
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map(toUser),
        nextCursor: nextAdminCursor(
          request,
          route,
          request.query,
          rows.length > limit,
          page.at(-1)?.id,
        ),
      };
    },
  );

  app.patch(
    '/users/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: "Edit a user's role, plan or invites",
        params: AdminUserParamsSchema,
        body: AdminUserPatchSchema,
        response: { 200: AdminUserResultSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      let changed: string[] = [];
      const outcome = await request.mutate(async (tx) => {
        const result = await updateAdminUser(tx, id, request.body);
        if (result.status === 'not_found') throw new AppError('NOT_FOUND', 'User not found');
        if (result.status === 'last_admin') {
          throw new AppError('CONFLICT', 'The last active administrator cannot be demoted', {
            details: { reason: 'last_admin' },
          });
        }
        changed = result.changed;
        return {
          status: 200,
          body: { user: toUser(result.user), sessionsRevoked: result.sessionsRevoked },
        };
      });
      auditLog(request, { action: 'users.patch', target: id, changed });
      await reply.code(200).send(outcome.body);
    },
  );

  app.get(
    '/invites',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'All invites',
        querystring: AdminInvitesQuerySchema,
        response: { 200: AdminInvitePageSchema },
      },
    },
    async (request) => {
      const { status, limit } = request.query;
      const route = 'admin.invites';
      const after = decodeAdminCursor<{ createdAt: string; code: string }>(
        request,
        route,
        request.query,
      );
      const rows = await request.withTx((tx) =>
        listAdminInvites(tx, {
          ...(status === undefined ? {} : { status }),
          ...(after === undefined ? {} : { after }),
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          code: row.code,
          email: row.email,
          note: row.note,
          createdBy: row.createdBy,
          createdAt: iso(row.createdAt),
          expiresAt: iso(row.expiresAt),
          usedBy: row.usedBy,
          usedAt: isoOrNull(row.usedAt),
          status: row.status,
        })),
        nextCursor: nextAdminCursor(
          request,
          route,
          request.query,
          rows.length > limit,
          last === undefined ? undefined : { createdAt: last.createdKey, code: last.code },
        ),
      };
    },
  );

  app.get(
    '/waitlist',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Waitlist',
        querystring: AdminWaitlistQuerySchema,
        response: { 200: AdminWaitlistPageSchema },
      },
    },
    async (request) => {
      const { limit } = request.query;
      const route = 'admin.waitlist';
      const beforeId = decodeAdminCursor<string>(request, route, request.query);
      const rows = await request.withTx((tx) =>
        listAdminWaitlist(tx, {
          ...(beforeId === undefined ? {} : { beforeId }),
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => ({
          id: row.id,
          email: row.email,
          locale: row.locale,
          note: row.note,
          createdAt: iso(row.createdAt),
          invitedAt: isoOrNull(row.invitedAt),
          inviteCode: row.inviteCode,
        })),
        nextCursor: nextAdminCursor(
          request,
          route,
          request.query,
          rows.length > limit,
          page.at(-1)?.id,
        ),
      };
    },
  );
};
