import type { Control, FeedRequest } from '../support/control.js';
import type { FeedKey } from '../support/env.js';
import { expect } from '../support/test.js';

import { staysTrueFor } from './wait.js';

/**
 * What a fixture feed's own server saw. It is the ground truth for "the publisher was (not) asked":
 * a browser request log would miss a service worker's fetches and could not tell a reader's browser
 * from the worker.
 */

/** The worker identifies itself in its requests (spec 03 §8). */
export const WORKER_AGENT = /BantooziBot/;

/** Requests for the images of the feed's items (`/img/<slug>.png`), whoever made them. */
export async function imageRequests(control: Control, key: FeedKey): Promise<FeedRequest[]> {
  return (await control.feedRequests(key)).filter((request) => request.path.startsWith('/img/'));
}

/** Requests for one path of the feed's origin. */
export async function requestsFor(
  control: Control,
  key: FeedKey,
  path: string,
): Promise<FeedRequest[]> {
  return (await control.feedRequests(key)).filter((request) => request.path === path);
}

/**
 * The publisher is asked for no image while `holdMs` pass: nothing, not even a placeholder, fetches
 * one behind the reader's back. Call it once the screen shows the images are blocked, so that a
 * request still on its way from before is not counted.
 */
export async function expectNoNewImageRequests(
  control: Control,
  key: FeedKey,
  holdMs = 2_500,
): Promise<void> {
  const before = (await imageRequests(control, key)).length;
  await staysTrueFor(holdMs, async () => {
    expect((await imageRequests(control, key)).length, 'image requests of the publisher').toBe(
      before,
    );
  });
}
