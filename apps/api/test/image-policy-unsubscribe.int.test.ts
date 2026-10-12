import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureWeb, rssDocument } from './support/fixture-web.js';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * Launch checklist item 15 (spec 11 §7 "remembered choice after unsubscribe", spec 08 §4.2, spec 11
 * §5.2 `feeds` retention): "always allow images from this feed" is remembered per user and feed. It
 * survives the user's unsubscribe and re-subscribe (the same URL finds the same choice), and another
 * user's policy for the same feed never changes.
 */

let h: ApiHarness;
const web = new FixtureWeb();

beforeAll(async () => {
  h = await createApiHarness({ discoverDeps: web.deps() });
});

afterAll(async () => {
  await h.close();
});

async function subscribe(user: TestUser, url: string) {
  const res = await apiClient(h.server, user).post('/subscriptions', { url });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().subscription as {
    feed: { id: string };
    imagePolicy: string;
    effectiveImagesAllowed: boolean;
  };
}

async function policyOf(user: TestUser, feedId: string) {
  const list = await apiClient(h.server, user).get('/subscriptions');
  expect(list.statusCode, list.body).toBe(200);
  const row = (
    list.json() as Array<{
      feed: { id: string };
      imagePolicy: string;
      effectiveImagesAllowed: boolean;
    }>
  ).find((s) => s.feed.id === feedId);
  return row === undefined
    ? null
    : { imagePolicy: row.imagePolicy, effectiveImagesAllowed: row.effectiveImagesAllowed };
}

describe('image policy across unsubscribe (spec 11 §9 item 15)', () => {
  it('keeps the remembered choice after unsubscribe and re-subscribe, and never touches another user', async () => {
    const url = 'https://images-policy.example.com/feed.xml';
    web.route(url, { body: rssDocument('Image policy'), contentType: 'application/rss+xml' });
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const b = apiClient(h.server, bob);

    const subA = await subscribe(alice, url);
    const feedId = subA.feed.id;
    const subB = await subscribe(bob, url);
    expect(subB.feed.id).toBe(feedId);
    const inherit = { imagePolicy: 'inherit', effectiveImagesAllowed: false };

    // Bob sets his own policy first; Alice then allows images for the feed.
    expect((await b.patch(`/subscriptions/${feedId}`, { imagePolicy: 'block' })).statusCode).toBe(
      200,
    );
    const bobPolicy = { imagePolicy: 'block', effectiveImagesAllowed: false };
    expect(await policyOf(bob, feedId)).toEqual(bobPolicy);
    expect(subA).toMatchObject(inherit);
    expect((await a.patch(`/subscriptions/${feedId}`, { imagePolicy: 'allow' })).statusCode).toBe(
      200,
    );
    const allowed = { imagePolicy: 'allow', effectiveImagesAllowed: true };
    expect(await policyOf(alice, feedId)).toEqual(allowed);
    expect(await policyOf(bob, feedId)).toEqual(bobPolicy);

    // Alice unsubscribes: the subscription is gone, the remembered choice stays and is hers alone.
    expect((await a.delete(`/subscriptions/${feedId}`)).statusCode).toBe(204);
    expect(await policyOf(alice, feedId)).toBeNull();
    expect((await a.get('/feed-preferences')).json()).toEqual([
      { feedId, imagePolicy: 'allow', effectiveImagesAllowed: true },
    ]);
    expect((await b.get('/feed-preferences')).json()).toEqual([
      { feedId, imagePolicy: 'block', effectiveImagesAllowed: false },
    ]);
    expect(await policyOf(bob, feedId)).toEqual(bobPolicy);

    // Re-subscribing to the same URL finds the same choice, with no new action.
    const again = await subscribe(alice, url);
    expect(again.feed.id).toBe(feedId);
    expect(again).toMatchObject(allowed);
    expect(await policyOf(alice, feedId)).toEqual(allowed);
    expect(await policyOf(bob, feedId)).toEqual(bobPolicy);

    // Resetting to inherit is the only way the choice goes away; Bob is still unaffected.
    expect((await a.patch(`/subscriptions/${feedId}`, { imagePolicy: 'inherit' })).statusCode).toBe(
      200,
    );
    expect(await policyOf(alice, feedId)).toEqual(inherit);
    expect(await policyOf(bob, feedId)).toEqual(bobPolicy);
  });
});
