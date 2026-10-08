import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../../src/router.js';
import { makeMe } from '../session/fixtures.js';

async function visit(url: string, me: Me | null) {
  const router = createAppRouter(
    { queryClient: new QueryClient(), loadMe: () => Promise.resolve(me) },
    createMemoryHistory({ initialEntries: [url] }),
  );
  await router.load();
  const { location, matches } = router.state;
  return {
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    routeId: matches.at(-1)?.routeId,
    params: matches.at(-1)?.params,
    notFoundAt: matches.find((match) => match.status === 'notFound')?.routeId,
  };
}

const user = makeMe();
const admin = makeMe({ role: 'admin' });
const newcomer = makeMe({ preferences: { onboardingCompletedAt: null } });

describe('route guards (spec 09 §2)', () => {
  it('sends / to the For you lane', async () => {
    const result = await visit('/', user);
    expect(result.href).toBe('/read/for_you');
    expect(result.routeId).toBe('/_authed/_app/read/$lane');
    expect(result.params).toEqual({ lane: 'for_you' });
    expect(result.notFoundAt).toBeUndefined();
  });

  it('sends a signed-out visitor to /login with the wanted path', async () => {
    const result = await visit('/read/maybe', null);
    expect(result.href).toBe('/login?redirect=%2Fread%2Fmaybe');
    expect(result.pathname).toBe('/login');
    expect(result.search).toEqual({ redirect: '/read/maybe' });
  });

  it('keeps the query string of the wanted path', async () => {
    const result = await visit('/read/feed/42?x=1', null);
    expect(result.search).toEqual({ redirect: '/read/feed/42?x=1' });
  });

  it('holds a new account in the onboarding wizard until it is completed', async () => {
    const elsewhere = await visit('/read/for_you', newcomer);
    expect(elsewhere.href).toBe('/onboarding');
    expect(elsewhere.routeId).toBe('/_authed/onboarding');

    const onboarding = await visit('/onboarding', newcomer);
    expect(onboarding.href).toBe('/onboarding');
    expect(onboarding.routeId).toBe('/_authed/onboarding');
    expect(onboarding.notFoundAt).toBeUndefined();
  });

  it('lets an onboarded account open /onboarding too', async () => {
    const result = await visit('/onboarding', user);
    expect(result.href).toBe('/onboarding');
    expect(result.routeId).toBe('/_authed/onboarding');
  });

  it('matches /read/feed/:feedId before the lane route', async () => {
    const result = await visit('/read/feed/42', user);
    expect(result.routeId).toBe('/_authed/_app/read/feed/$feedId');
    expect(result.params).toEqual({ feedId: '42' });
    expect(result.notFoundAt).toBeUndefined();
  });

  it('decodes folder names with spaces and slashes', async () => {
    const result = await visit('/read/folder/Spr%C3%A1vy%20%2F%20SK', user);
    expect(result.routeId).toBe('/_authed/_app/read/folder/$name');
    expect(result.params).toEqual({ name: 'Správy / SK' });
  });

  it('answers an unknown lane with not found', async () => {
    const result = await visit('/read/nope', user);
    expect(result.notFoundAt).toBe('/_authed/_app/read/$lane');
  });

  it('answers /admin with not found for a non-admin', async () => {
    const result = await visit('/admin', user);
    expect(result.notFoundAt).toBe('/_authed/_app/admin');
  });

  it('lets an admin reach /admin', async () => {
    const result = await visit('/admin', admin);
    expect(result.notFoundAt).toBeUndefined();
    expect(result.href).toBe('/admin');
    expect(result.routeId).toBe('/_authed/_app/admin/');
  });

  it('parses the invite code of /join', async () => {
    const result = await visit('/join?code=ABC123', null);
    expect(result.routeId).toBe('/join');
    expect(result.search).toEqual({ code: 'ABC123' });
  });
});
