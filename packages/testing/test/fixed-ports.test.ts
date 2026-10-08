import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { closeServer, listenLoopback } from '../src/fake-http.js';
import { startFakeTypeSafe } from '../src/fake-typesafe.js';
import { startFixtureServer } from '../src/fixture-server.js';

async function freePort(): Promise<number> {
  const server = createServer();
  const url = await listenLoopback(server);
  await closeServer(server);
  return Number(new URL(url).port);
}

describe('listening on a given port', () => {
  it('listenLoopback keeps picking a random port by default', async () => {
    const server = createServer();
    const url = await listenLoopback(server);
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(Number((server.address() as AddressInfo).port)).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });

  it('listenLoopback listens on the wanted port and fails when it is taken', async () => {
    const port = await freePort();
    const server = createServer();
    expect(await listenLoopback(server, port)).toBe(`http://127.0.0.1:${port}`);
    try {
      await expect(listenLoopback(createServer(), port)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await closeServer(server);
    }
  });

  it('the fixture server listens on the port option', async () => {
    const port = await freePort();
    const server = await startFixtureServer({ port });
    try {
      expect(server.port).toBe(port);
      expect(server.origin).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await server.close();
    }
  });

  it('the fake TypeSafe server listens on the port option and still checks its other options', async () => {
    const port = await freePort();
    await expect(startFakeTypeSafe({ port, failRate: 2 })).rejects.toThrow(/failRate/);
    const fake = await startFakeTypeSafe({ port, latencyMs: 1 });
    try {
      expect(fake.url).toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`${fake.url}/anything`)).status).toBe(404);
      expect(fake.requestCount()).toBe(1);
    } finally {
      await fake.close();
    }
  });
});
