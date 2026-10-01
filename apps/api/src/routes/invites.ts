import { listOwnInvites, upsertWaitlistEntry } from '@bantoozi/db';
import {
  CreateInviteBodySchema,
  CreateInviteResponseSchema,
  InviteListSchema,
  WaitlistBodySchema,
  WaitlistResponseSchema,
  type CreateInviteResponse,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { preferredLocale } from '../services/auth.js';
import { createUserInvite, inviteUrl, sendInviteEmail, toInviteDto } from '../services/invites.js';
import type { RateLimitRule } from '../types.js';

/** `POST /waitlist`: 5 per hour per IP (spec 08 §11). */
export const WAITLIST_IP_LIMIT: RateLimitRule = {
  group: 'waitlist',
  max: 5,
  windowSeconds: 3600,
  per: 'ip',
};

/** Invites and the waitlist (spec 08 §2.2). */
export const inviteRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/invites',
    {
      config: { auth: 'user' },
      schema: {
        tags: ['invites'],
        summary: 'My invites and how many I have left',
        response: { 200: InviteListSchema },
      },
    },
    async (request) => {
      const { items, invitesLeft } = await request.withTx(listOwnInvites);
      return {
        items: items.map((row) => toInviteDto(app.services.config, row)),
        invitesLeft,
      };
    },
  );

  app.post(
    '/invites',
    {
      config: { auth: 'user' },
      schema: {
        tags: ['invites'],
        summary: 'Create an invite (uses one invite slot); optionally email it',
        body: CreateInviteBodySchema,
        response: { 201: CreateInviteResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const { email, note } = request.body;
      const { config } = app.services;
      // The invite this request created (the last attempt wins when a deadlock retried it). A
      // replayed receipt carries another code, so it never re-sends the email.
      let created: Awaited<ReturnType<typeof createUserInvite>> | undefined;
      const outcome = await request.mutate(async (tx) => {
        created = await createUserInvite(tx, { userId: auth.userId, email, note });
        const body: CreateInviteResponse = {
          code: created.invite.code,
          url: inviteUrl(config, created.invite.code),
        };
        return { status: 201, body };
      });
      let body = outcome.body;
      if (email !== undefined && created !== undefined && created.invite.code === body.code) {
        const emailSent = await sendInviteEmail(
          app.services,
          {
            to: email,
            code: created.invite.code,
            expiresAt: created.invite.expiresAt,
            locale: auth.locale,
            inviterName: created.inviterName,
          },
          request.log,
        );
        body = { ...body, emailSent };
      }
      await reply.code(201).send(body);
    },
  );

  app.post(
    '/waitlist',
    {
      config: { auth: 'public', rateLimits: [WAITLIST_IP_LIMIT] },
      schema: {
        tags: ['invites'],
        summary: 'Join the waitlist (never reveals whether the address is known)',
        body: WaitlistBodySchema,
        response: { 202: WaitlistResponseSchema },
      },
    },
    async (request, reply) => {
      const { email, locale, note } = request.body;
      const acceptLanguage = request.headers['accept-language'];
      await upsertWaitlistEntry(app.services.db, {
        email,
        locale:
          locale ??
          preferredLocale(typeof acceptLanguage === 'string' ? acceptLanguage : undefined),
        note: note === undefined || note.length === 0 ? null : note,
      });
      await reply.code(202).header('cache-control', 'no-store').send({ next: 'waitlisted' });
    },
  );
};
