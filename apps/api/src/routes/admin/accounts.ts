import {
  createInvites,
  listAdminInvites,
  lockWaitlistEntry,
  markWaitlistInvited,
  listAdminUsers,
  listAdminWaitlist,
  updateAdminUser,
  type AdminUserRow,
} from '@bantoozi/db';
import {
  AdminCreateInvitesBodySchema,
  AdminCreateInvitesResultSchema,
  AdminInvitePageSchema,
  AdminInvitesQuerySchema,
  AdminUserPageSchema,
  AdminUserParamsSchema,
  AdminUserPatchSchema,
  AdminUserResultSchema,
  AdminUsersQuerySchema,
  AdminWaitlistInviteResultSchema,
  AdminWaitlistPageSchema,
  AdminWaitlistParamsSchema,
  AdminWaitlistQuerySchema,
  AppError,
  type AdminCreateInvitesResult,
  type AdminUser,
  type AdminWaitlistInviteResult,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { sendInviteEmail, toInviteDto } from '../../services/invites.js';
import { auditLog, decodeAdminCursor, iso, isoOrNull, nextAdminCursor } from './shared.js';

/**
 * Users, invites and the waitlist (spec 08 §9). User edits change only role, plan and
 * `invites_left`; they refuse to remove the last active administrator, revoke the sessions of a
 * downgraded user and recompute feed intervals on a plan change. Admin invites and waitlist
 * invitations create invites in the mutation and send the invite email after it commits, without
 * an outbox intent (spec 08 §2.2); a replay never re-sends.
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
  app.post(
    '/invites',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Create invites (an email-bound one is emailed)',
        body: AdminCreateInvitesBodySchema,
        response: { 201: AdminCreateInvitesResultSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const { count, email, note, expiresDays } = request.body;
      const { config } = app.services;
      // The codes this request created; a replayed receipt carries other codes and never re-sends.
      let created: Awaited<ReturnType<typeof createInvites>> = [];
      const outcome = await request.mutate(async (tx) => {
        created = await createInvites(tx, {
          createdBy: auth.userId,
          count,
          email: email ?? null,
          note: note ?? null,
          ...(expiresDays === undefined ? {} : { expiresDays }),
        });
        return { status: 201, body: { items: created.map((row) => toInviteDto(config, row)) } };
      });
      let body: AdminCreateInvitesResult = outcome.body;
      const invite = created[0];
      if (email !== undefined && invite !== undefined && body.items[0]?.code === invite.code) {
        const emailSent = await sendInviteEmail(
          app.services,
          {
            to: email,
            code: invite.code,
            expiresAt: invite.expiresAt,
            locale: auth.locale,
            inviterName: null,
          },
          request.log,
        );
        body = { ...body, emailSent };
      }
      auditLog(request, { action: 'invites.create', target: `count:${count}` });
      await reply.code(201).send(body);
    },
  );

  app.post(
    '/waitlist/:id/invite',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Invite a waitlist entry and email the invite',
        params: AdminWaitlistParamsSchema,
        response: { 200: AdminWaitlistInviteResultSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params;
      const { config } = app.services;
      let sent: { code: string; expiresAt: Date; email: string; locale: 'en' | 'sk' } | undefined;
      const outcome = await request.mutate(async (tx) => {
        const entry = await lockWaitlistEntry(tx, id);
        if (entry === null) throw new AppError('NOT_FOUND', 'Waitlist entry not found');
        const [invite] = await createInvites(tx, { createdBy: auth.userId, email: entry.email });
        if (invite === undefined) throw new Error('invite insert returned no row');
        const row = await markWaitlistInvited(tx, { id, code: invite.code });
        sent = { code: invite.code, expiresAt: invite.expiresAt, ...entry };
        return {
          status: 200,
          body: {
            entry: {
              id: row.id,
              email: row.email,
              locale: row.locale,
              note: row.note,
              createdAt: iso(row.createdAt),
              invitedAt: isoOrNull(row.invitedAt),
              inviteCode: row.inviteCode,
            },
            invite: toInviteDto(config, invite),
          },
        };
      });
      let body: AdminWaitlistInviteResult = outcome.body;
      if (sent !== undefined && body.invite.code === sent.code) {
        const emailSent = await sendInviteEmail(
          app.services,
          {
            to: sent.email,
            code: sent.code,
            expiresAt: sent.expiresAt,
            locale: sent.locale,
            inviterName: null,
          },
          request.log,
        );
        body = { ...body, emailSent };
      }
      auditLog(request, { action: 'waitlist.invite', target: id, changed: ['invitedAt'] });
      await reply.code(200).send(body);
    },
  );
};
