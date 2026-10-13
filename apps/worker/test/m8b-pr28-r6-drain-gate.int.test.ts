import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  NEW_MODEL,
  ClassifyHarness,
  baseConfig,
  recorder,
  resetWorld,
  setSetting,
  type Recorder,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * PR #28 review round 6: a self-restart requested before `main.ts` has wired the real shutdown must
 * not exit without draining. `main.ts` hands the runtime a drain gate that waits for the wiring, and
 * starts the 10 s check timer only after the wiring.
 */
let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  for (const r of runtimes) await r.close().catch(() => undefined);
  await h?.close();
});
beforeEach(async () => {
  await resetWorld(h);
});

async function bootWith(rec: Recorder, drain: () => Promise<void>) {
  const { createWorkerRuntime } = (await import('../src/runtime.js')) as unknown as {
    createWorkerRuntime: (o: Record<string, unknown>) => Promise<WorkerRuntimeLike>;
  };
  const runtime = await createWorkerRuntime({
    db: h.db,
    config: baseConfig('production'),
    logger: rec.logger,
    exit: (code: number) => rec.exit(code),
    drain,
    selfRestart: true,
  });
  runtimes.push(runtime);
  return runtime;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('the shutdown gate', () => {
  it('documents the bug: an unwired no-op drain lets the first check exit without draining', async () => {
    const rec = recorder();
    const runtime = await bootWith(rec, () => Promise.resolve());
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    await runtime.check();
    expect(rec.exits).toEqual([0]);
    expect(rec.drains).toBe(0);
  });

  it('a check before the wiring waits; wiring runs the real shutdown, then the exit', async () => {
    const { createShutdownGate } = await import('../src/shutdown-gate.js');
    const rec = recorder();
    const gate = createShutdownGate();
    const runtime = await bootWith(rec, () => gate.drain('settings-restart'));
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);

    let settled = false;
    const early = runtime.check().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(rec.exits).toEqual([]);

    const signals: string[] = [];
    gate.wire(async (signal) => {
      signals.push(signal);
      await rec.drain();
    });
    await early;
    expect(signals).toEqual(['settings-restart']);
    expect(rec.calls).toEqual(['drain', 'exit']);
  });

  it('negative control: after the wiring a check drains, then exits once', async () => {
    const { createShutdownGate } = await import('../src/shutdown-gate.js');
    const rec = recorder();
    const gate = createShutdownGate();
    gate.wire(() => rec.drain());
    const runtime = await bootWith(rec, () => gate.drain('settings-restart'));
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    await runtime.check();
    await runtime.check();
    expect(rec.calls).toEqual(['drain', 'exit']);
  });
});
