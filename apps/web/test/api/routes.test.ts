import type { ArticleListItem, Me } from '@bantoozi/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type {
  AnyRoute,
  CallArgs,
  CallOptions,
  MultipartBody,
  RouteInput,
  RouteOutput,
} from '../../src/api/route.js';
import { routes } from '../../src/api/routes.js';
import { EXPECTED_OPERATIONS, needsIdempotencyKey } from './operations.js';

const entries = Object.entries(routes) as [string, AnyRoute][];
const operation = (route: AnyRoute) => `${route.method} ${route.path}`;

describe('route table', () => {
  it('lists the 101 operations of apps/api/test/expected-operations.txt', () => {
    expect(EXPECTED_OPERATIONS).toHaveLength(101);
    expect(entries.map(([, route]) => operation(route)).sort()).toEqual(
      [...EXPECTED_OPERATIONS].sort(),
    );
  });

  it('has no duplicate operation', () => {
    const operations = entries.map(([, route]) => operation(route));
    expect(new Set(operations).size).toBe(operations.length);
  });

  it.each(entries)('%s: path parameters match its params schema', (_name, route) => {
    const placeholders = [...route.path.matchAll(/:(\w+)/g)].map((match) => match[1]);
    const keys = route.params === undefined ? [] : Object.keys((route.params as z.ZodObject).shape);
    expect(keys.sort()).toEqual(placeholders.sort());
  });

  it.each(entries)('%s: GET and DELETE carry no body', (_name, route) => {
    if (route.method === 'GET' || route.method === 'DELETE') expect(route.body).toBeUndefined();
  });

  it('uses multipart only for the OPML upload', () => {
    const multipart = entries.filter(([, route]) => route.body === 'multipart');
    expect(multipart.map(([, route]) => operation(route))).toEqual([
      'POST /subscriptions/import-opml',
    ]);
  });

  it('marks exactly the authenticated mutations as idempotent', () => {
    for (const [name, route] of entries) {
      expect({ name, idempotent: route.idempotent }).toEqual({
        name,
        idempotent: needsIdempotencyKey(operation(route)),
      });
    }
  });

  it('puts the admin operations behind the admin role', () => {
    for (const [name, route] of entries) {
      if (route.path.startsWith('/admin/') && route.path !== '/admin/ops-event') {
        expect({ name, auth: route.auth }).toEqual({ name, auth: 'admin' });
      }
    }
    expect(routes.adminOpsEvent.auth).toBe('public');
  });

  it('keeps the public routes to the sign-in flow, the waitlist and the probes', () => {
    const publicOperations = entries
      .filter(([, route]) => route.auth === 'public')
      .map(([, route]) => operation(route))
      .sort();
    expect(publicOperations).toEqual(
      [
        'GET /dev/last-email',
        'GET /healthz',
        'GET /readyz',
        'POST /admin/ops-event',
        'POST /auth/request-code',
        'POST /auth/verify',
        'POST /waitlist',
      ].sort(),
    );
  });

  it('sends the fence of the two fenced DELETEs in the query string', () => {
    for (const route of [routes.articleUnbookmark, routes.articleLabelRemove]) {
      expect(Object.keys((route.query as z.ZodObject).shape).sort()).toEqual([
        'contentRevision',
        'snapshotId',
        'stateVersion',
      ]);
    }
  });
});

describe('route types', () => {
  it('infers requests from the schema inputs and responses from the outputs', () => {
    expectTypeOf<RouteOutput<typeof routes.meGet>>().toEqualTypeOf<Me>();
    expectTypeOf<RouteOutput<typeof routes.authLogout>>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteOutput<typeof routes.subscriptionsExportOpml>>().toEqualTypeOf<string>();
    expectTypeOf<RouteOutput<typeof routes.articleRate>['item']>().toEqualTypeOf<ArticleListItem>();

    expectTypeOf<RouteInput<typeof routes.articleRate>['params']>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<RouteInput<typeof routes.articleRate>['body']['rating']>().toEqualTypeOf<
      1 | -1 | null
    >();
    expectTypeOf<
      RouteInput<typeof routes.subscriptionsImportOpml>['body']
    >().toEqualTypeOf<MultipartBody>();
    expectTypeOf<RouteInput<typeof routes.articleUnbookmark>['query']>().toHaveProperty(
      'stateVersion',
    );
  });

  it('asks for an input only where the route needs one', () => {
    expectTypeOf<CallArgs<typeof routes.meGet>>().toEqualTypeOf<
      [input?: undefined, options?: CallOptions]
    >();
    expectTypeOf<CallArgs<typeof routes.articleList>[0]>().toEqualTypeOf<
      RouteInput<typeof routes.articleList> | undefined
    >();
    expectTypeOf<CallArgs<typeof routes.articleRead>[0]>().toEqualTypeOf<
      RouteInput<typeof routes.articleRead>
    >();
  });
});
