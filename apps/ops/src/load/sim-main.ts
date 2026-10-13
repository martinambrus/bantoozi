import { createServer } from 'node:http';

import { createLoadClock, startFakeTypeSafe, startLoadFeedServer } from '@bantoozi/testing';

/**
 * The `load-sim` container of the load stack (infra/load/compose.override.yml): the generated feed
 * server on many ports, the fake TypeSafe server and a small control API the load runner uses to
 * switch the provider between normal, failing and timing-out and to read counters.
 *
 *   GET  /state                          counters of the feeds and of the provider, the clock
 *   POST /provider  {"mode": "normal" | "failing" | "timeouts"}
 *   POST /clock/advance {"ms": n}        publish items on demand
 */

type ProviderMode = 'normal' | 'failing' | 'timeouts';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const num = (name: string, fallback: number): number => Number(env(name, String(fallback)));

/** Longer than the engine client's timeout, so a request in this mode ends as a timeout. */
const TIMEOUT_LATENCY_MS = 120_000;

async function main(): Promise<void> {
  const host = env('SIM_HOST', '0.0.0.0');
  const clock = createLoadClock();
  const portBase = num('SIM_FEED_PORT_BASE', 8100);
  const feeds = await startLoadFeedServer({
    host,
    publicHost: env('SIM_PUBLIC_HOST', 'load-sim'),
    feedCount: num('SIM_FEED_COUNT', 1000),
    itemsPerFeedPerHour: num('SIM_ITEMS_PER_FEED_PER_HOUR', 5),
    window: num('SIM_FEED_WINDOW', 4),
    ports: Array.from({ length: num('SIM_FEED_PORT_COUNT', 50) }, (_, i) => portBase + i),
    clock,
  });
  const normalLatency = num('SIM_PROVIDER_LATENCY_MS', 300);
  const provider = await startFakeTypeSafe({
    host,
    port: num('SIM_PROVIDER_PORT', 8082),
    latencyMs: normalLatency,
    recordRequests: false,
  });
  let mode: ProviderMode = 'normal';
  const setMode = (next: ProviderMode): void => {
    mode = next;
    provider.setOptions(
      next === 'normal'
        ? { latencyMs: normalLatency, failRate: 0 }
        : next === 'failing'
          ? { latencyMs: normalLatency, failRate: 1, failStatus: 503 }
          : { latencyMs: TIMEOUT_LATENCY_MS, failRate: 0 },
    );
  };

  const control = createServer((req, res) => {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://sim.local').pathname;
      let body: Record<string, unknown> = {};
      try {
        if (chunks.length > 0)
          body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      } catch {
        json(400, { error: 'invalid JSON' });
        return;
      }
      if (req.method === 'GET' && path === '/state') {
        json(200, {
          now: new Date(clock.now()).toISOString(),
          feeds: feeds.stats(),
          provider: { mode, requests: provider.requestCount() },
        });
      } else if (req.method === 'POST' && path === '/provider') {
        const wanted = body['mode'];
        if (wanted !== 'normal' && wanted !== 'failing' && wanted !== 'timeouts') {
          json(400, { error: 'mode must be normal, failing or timeouts' });
          return;
        }
        setMode(wanted);
        json(200, { mode });
      } else if (req.method === 'POST' && path === '/clock/advance') {
        const ms = body['ms'];
        if (typeof ms !== 'number' || !(ms >= 0)) {
          json(400, { error: 'ms must be a nonnegative number' });
          return;
        }
        clock.advance(ms);
        json(200, { now: new Date(clock.now()).toISOString() });
      } else {
        json(404, { error: 'not found' });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(num('SIM_CONTROL_PORT', 8083), host, () => resolve());
  });
  process.stdout.write(
    `[load-sim] ready: ${feeds.feedCount} feeds on ${feeds.origins.length} ports, provider ${provider.url}\n`,
  );

  const stop = (): void => {
    control.closeAllConnections();
    void Promise.all([feeds.close(), provider.close()]).finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[load-sim] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
