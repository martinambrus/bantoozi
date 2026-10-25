import {
  AdminOverviewSchema,
  ArticleListResponseSchema,
  ErrorResponseSchema,
  MePatchSchema,
  MeSchema,
} from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApiClient } from '../../src/api/client.js';
import { ApiError } from '../../src/api/errors.js';
import { defineRoute, type AnyRoute } from '../../src/api/route.js';
import { routes } from '../../src/api/routes.js';
import { makeModelStatus, makeOverview, modelProbe } from '../admin/support.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import { makeMe } from '../session/fixtures.js';
import { fakeFetch, json } from './fake-fetch.js';

function clientFor(body: unknown, status = 200) {
  return createApiClient({ fetch: fakeFetch(() => json(status, body)).fetch });
}

const articlePage = () => ({
  items: [makeItem()],
  nextCursor: null,
  asOf: '2026-10-08T12:00:00.000Z',
  datasetVersion: 'ds-1',
  rankingPending: false,
});

describe('response compatibility across server releases', () => {
  it('ignores new /me fields recursively while leaving shared DTO and request schemas strict', async () => {
    const me = makeMe();
    const wire = {
      ...me,
      future: true,
      preferences: { ...me.preferences, future: { nested: true } },
      quotas: { ...me.quotas, used: { ...me.quotas.used, future: 123 } },
    };
    expect(MeSchema.safeParse(wire).success).toBe(false);
    expect(MePatchSchema.safeParse({ displayName: 'A', future: true }).success).toBe(false);
    await expect(clientFor(wire).call(routes.meGet)).resolves.toEqual(me);
    // Deriving a reader must not mutate the strict schema or its nested objects.
    expect(MeSchema.safeParse(wire).success).toBe(false);
    expect(MeSchema.shape.quotas.safeParse(wire.quotas).success).toBe(false);
  });

  it('ignores new fields in article arrays and their nested DTOs', async () => {
    const page = articlePage();
    const item = page.items[0]!;
    const wire = {
      ...page,
      future: true,
      items: [
        {
          ...item,
          future: true,
          feed: { ...item.feed, future: 'new' },
          topReason: { ...item.topReason, future: true },
        },
      ],
    };
    expect(ArticleListResponseSchema.safeParse(wire).success).toBe(false);
    await expect(clientFor(wire).call(routes.articleList)).resolves.toEqual(page);
  });

  it('ignores new fields in admin objects and arrays', async () => {
    const overview = makeOverview();
    const wire = {
      ...overview,
      future: true,
      users: { ...overview.users, future: 10 },
      queues: overview.queues.map((queue) => ({ ...queue, future: true })),
      engine: {
        ...overview.engine,
        breakers: {
          ...overview.engine.breakers,
          llm: { ...overview.engine.breakers.llm, future: true },
        },
      },
    };
    expect(AdminOverviewSchema.safeParse(wire).success).toBe(false);
    await expect(clientFor(wire).call(routes.adminOverview)).resolves.toEqual(overview);
  });

  it('keeps dynamic record entries while stripping extras from their structured values', async () => {
    const model = makeModelStatus({ probes: { 'a-new-model': modelProbe('a-new-model') } });
    const wire = {
      ...model,
      probes: { 'a-new-model': { ...model.probes['a-new-model'], future: true } },
    };
    await expect(clientFor(wire).call(routes.adminEngineModelGet)).resolves.toEqual(model);
  });

  it.each([
    ['known field type', { ...makeMe(), invitesLeft: '3', future: true }],
    ['required field', { ...makeMe(), email: undefined, future: true }],
    ['value range', { ...makeMe(), invitesLeft: -1, future: true }],
    ['known enum', { ...makeMe(), role: 'future-role', future: true }],
  ])('rejects an invalid %s even with new fields', async (_label, wire) => {
    await expect(clientFor(wire).call(routes.meGet)).rejects.toMatchObject({
      kind: 'invalid_response',
      status: 200,
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects unknown discriminators in an article reason', async () => {
    const page = articlePage();
    page.items = [makeItem({ topReason: { kind: 'future-kind' } as never })];
    await expect(
      clientFor({ ...page, future: true }).call(routes.articleList),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
      code: 'INVALID_RESPONSE',
    });
  });

  it('retains object refinements and explicit catchall data', async () => {
    const schema = z
      .strictObject({
        lower: z.number(),
        upper: z.number(),
        metadata: z.object({ name: z.string() }).catchall(z.unknown()),
      })
      .refine((value) => value.lower < value.upper);
    const route = defineRoute({
      method: 'GET',
      path: '/refined',
      auth: 'user',
      idempotent: false,
      response: schema,
    });
    const value = { lower: 1, upper: 3, metadata: { name: 'known', added: { x: true } } };
    await expect(clientFor({ ...value, future: true }).call(route)).resolves.toEqual(value);
    await expect(clientFor({ ...value, lower: 5, future: true }).call(route)).rejects.toMatchObject(
      { kind: 'invalid_response' },
    );
  });

  it('keeps useful error fields and open details when envelope fields are added', async () => {
    const details = { reason: 'stale_version', arbitrary: { future: true }, item: { future: 1 } };
    const wire = {
      future: 'request metadata',
      error: { code: 'STALE_STATE', message: 'Article changed', details, future: true },
    };
    expect(ErrorResponseSchema.safeParse(wire).success).toBe(false);
    await expect(clientFor(wire, 409).call(routes.meGet)).rejects.toMatchObject({
      kind: 'http',
      status: 409,
      code: 'STALE_STATE',
      message: 'Article changed',
      details,
    });
  });

  it.each([
    { error: { code: 123, message: 'bad' } },
    { error: { code: 'BAD' } },
    { error: { code: 'BAD', message: 'bad', details: [] } },
  ])('still falls back for an invalid error envelope: %j', async (wire) => {
    await expect(
      clientFor({ ...wire, future: true }, 409).call(routes.meGet),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 409,
      code: 'HTTP_409',
      details: undefined,
    });
  });

  it.each(Object.entries(routes))(
    'can derive and execute the registered %s response reader',
    async (_name, route) => {
      if (route.response === null || route.response === 'text') return;
      // Invalid input still runs schema derivation across the entire graph. Unsupported constructs
      // must not escape as raw exceptions instead of a schema validation ApiError.
      const input = {
        params: Object.fromEntries(
          [...route.path.matchAll(/:(\w+)/g)].map(([, key]) => [key, '1']),
        ),
        ...(route.body === 'multipart' ? { body: { file: new Blob() } } : {}),
      };
      const call = clientFor({}).call as (route: AnyRoute, input: unknown) => Promise<unknown>;
      const result = await call(route, input).catch((error: unknown) => error);
      const expected = route.response.safeParse({});
      if (expected.success) expect(result).toEqual(expected.data);
      else {
        expect(result).toBeInstanceOf(ApiError);
        expect(result).toMatchObject({ kind: 'invalid_response' });
      }
    },
  );
});
