import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { makeSubscription } from '../feeds/support.js';
import { LEARNING, learningRoute, makeEstimates, makeLearning } from '../learning/fixtures.js';
import { holdExits } from './exit-hold.js';
import { createReaderHarness, item } from './support.js';
import { likeOf, writeRoutes } from './surfaces.js';

const LIGHT = 'GET /me/learning/estimates';
const { open } = createReaderHarness();
afterEach(() => vi.useRealTimers());

async function openFeed(mode: 'off' | 'training' = 'off') {
  const status = makeLearning({}, [], { estimates: makeEstimates({ n: 120 }) });
  return open({
    path: '/read/feed/7',
    subscriptions: [makeSubscription({ feed: { id: '7', title: 'Verge' }, inferenceMode: mode })],
    items: [item(1), item(2)],
    routes: {
      [LEARNING]: learningRoute(() => status),
      [LIGHT]: () => json(200, { estimates: status.estimates, estimateGate: status.estimateGate }),
      ...writeRoutes().routes,
    },
  });
}

it('an Off feed reads only the light endpoint, including after a rating', async () => {
  holdExits();
  const { app } = await openFeed();
  await screen.findByText(/from 120 ratings/);
  expect(app.calls(LEARNING)).toHaveLength(0);
  expect(app.calls(LIGHT)).toHaveLength(1);
  await app.user.click(likeOf('Article 1'));
  await waitFor(() => expect(app.calls(LIGHT).length).toBeGreaterThan(1));
  expect(app.calls(LEARNING)).toHaveLength(0);
});

it('an armed notice polls only the light endpoint', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  holdExits();
  const { app } = await openFeed();
  await screen.findByRole('article', { name: 'Article 1' });
  await app.user.click(likeOf('Article 1'));
  const before = app.calls(LIGHT).length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(app.calls(LIGHT).length).toBeGreaterThanOrEqual(before + 3);
  expect(app.calls(LEARNING)).toHaveLength(0);
});

it('polling the notice does not refetch the full Training status', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  holdExits();
  const { app } = await openFeed('training');
  await screen.findByText(/from 120 ratings/);
  expect(app.calls(LEARNING)).toHaveLength(1);
  expect(app.calls(LIGHT)).toHaveLength(0);
  await app.user.click(likeOf('Article 1'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  const full = app.calls(LEARNING).length;
  expect(full).toBeGreaterThan(1);
  const light = app.calls(LIGHT).length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(app.calls(LIGHT).length).toBeGreaterThanOrEqual(light + 3);
  expect(app.calls(LEARNING)).toHaveLength(full);
});
