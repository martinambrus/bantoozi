import { createUserRule, deleteUserRule, listUserRules, type UserRule } from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import {
  AppError,
  CreateRuleBodySchema,
  isBigIntString,
  RULE_KEYWORD_MAX,
  RULE_KEYWORD_MIN,
  RULE_VALUE_MAX,
  RuleIdParamsSchema,
  RuleListSchema,
  RuleSchema,
  type RuleDto,
  type RuleKind,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Rules (spec 08 §8, semantics in spec 06 §3). Values are validated and normalized per kind here;
 * the repository then rechecks references (a subscribed feed, a story the user can see), the
 * `maxRules` quota under the user-row lock, and records `user.rank {full: true}` with the change.
 */

const invalidValue = (reason: string) =>
  new AppError('VALIDATION_FAILED', 'Invalid rule value', {
    details: { field: 'value', reason },
  });

const codePoints = (value: string) => [...value].length;
const collapse = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

/**
 * A domain rule's value: the registrable domain (as `tldts` computes it for article URLs, so it can
 * match `item.domain`) of a bare host name, case-folded and IDNA-encoded like a URL host.
 */
function normalizeDomain(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/u, '');
  if (host === '' || !/^[\p{L}\p{N}.-]+$/u.test(host) || host.includes('..')) {
    throw invalidValue('domain');
  }
  const domain = registrableDomain(`https://${host}/`);
  if (domain === null) throw invalidValue('domain');
  return domain;
}

/** Validate and normalize `value` for `kind` (spec 08 §8); a bad value is `400 VALIDATION_FAILED`. */
export function normalizeRuleValue(kind: RuleKind, value: string): string {
  switch (kind) {
    case 'mute_keyword': {
      const keyword = collapse(value);
      const length = codePoints(keyword);
      if (length < RULE_KEYWORD_MIN || length > RULE_KEYWORD_MAX) throw invalidValue('keyword');
      return keyword;
    }
    case 'mute_story':
    case 'block_feed':
    case 'boost_feed': {
      const id = value.trim();
      if (!isBigIntString(id) || BigInt(id) <= 0n) throw invalidValue('id');
      return id;
    }
    case 'block_domain':
    case 'boost_domain':
      return normalizeDomain(value);
    case 'block_author': {
      const author = collapse(value);
      if (author === '' || codePoints(author) > RULE_VALUE_MAX) throw invalidValue('author');
      return author;
    }
  }
}

export function ruleDto(rule: UserRule): RuleDto {
  return {
    id: rule.id,
    kind: rule.kind,
    value: rule.value,
    displayValue: rule.displayValue,
    createdAt: rule.createdAt.toISOString(),
    expiresAt: rule.expiresAt?.toISOString() ?? null,
  };
}

const tags = ['rules'];

export const ruleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '',
    { schema: { tags, summary: 'The user’s live rules', response: { 200: RuleListSchema } } },
    async (request) => {
      const rules = await request.withTx((tx) => listUserRules(tx));
      return rules.map(ruleDto);
    },
  );

  app.post(
    '',
    {
      schema: {
        tags,
        summary: 'Create a rule (mute_story requires expiresInDays)',
        body: CreateRuleBodySchema,
        response: { 201: RuleSchema },
      },
    },
    async (request, reply) => {
      const { kind, expiresInDays } = request.body;
      if (kind === 'mute_story' && expiresInDays === undefined) {
        throw new AppError('VALIDATION_FAILED', 'A muted story needs an expiry', {
          details: { field: 'expiresInDays', reason: 'required' },
        });
      }
      const value = normalizeRuleValue(kind, request.body.value);
      const outcome = await request.mutate(async (tx) => {
        const { rule } = await createUserRule(tx, {
          kind,
          value,
          expiresInDays: expiresInDays ?? null,
        });
        return { status: 201, body: ruleDto(rule) };
      });
      await reply.code(201).send(outcome.body);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Delete a rule',
        params: RuleIdParamsSchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      await request.mutate(async (tx) => {
        await deleteUserRule(tx, id);
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );
};
