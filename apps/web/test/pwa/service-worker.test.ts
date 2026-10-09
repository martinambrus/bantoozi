import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => vi.fn()),
}));
vi.mock('workbox-routing', () => ({
  NavigationRoute: class {},
  registerRoute: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Loads the worker script as a worker would: what it listens for is registered on `self`. */
async function startWorker() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  vi.spyOn(self, 'addEventListener').mockImplementation((type: string, listener: unknown) => {
    handlers.set(type, listener as (event: unknown) => unknown);
  });
  await import('../../src/sw/sw.js');
  return handlers;
}

describe('the service worker of the app', () => {
  it('takes control of the page that installed it as soon as it is active', async () => {
    const claimed = Promise.resolve();
    const claim = vi.fn(() => claimed);
    vi.stubGlobal('clients', { claim });
    const handlers = await startWorker();
    const waitUntil = vi.fn();

    expect(handlers.has('activate')).toBe(true);
    handlers.get('activate')?.({ waitUntil });

    expect(claim).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(claimed);
  });

  it('waits for the person before a new version takes over', async () => {
    const skipWaiting = vi.fn();
    vi.stubGlobal('skipWaiting', skipWaiting);
    const handlers = await startWorker();

    handlers.get('message')?.({ data: { type: 'SOMETHING_ELSE' } });
    expect(skipWaiting).not.toHaveBeenCalled();

    handlers.get('message')?.({ data: { type: 'SKIP_WAITING' } });
    expect(skipWaiting).toHaveBeenCalledOnce();
  });
});
