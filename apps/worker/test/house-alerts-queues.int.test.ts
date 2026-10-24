import { REQUIRED_PG_BOSS_QUEUES } from '@bantoozi/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALERT_RULES } from '../src/alerts/rules.js';
import { ClassifyHarness } from './support/classify.js';
import { ADMIN, AlertsWorld, DAY, RecordingMailer } from './support/alerts-world.js';

const NOW = new Date(Date.now() + 100 * DAY);
const MESSAGE = 'pg-boss queues missing: user.estimate, house.alerts — run the migrate job';
let h: ClassifyHarness;
let w: AlertsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
}, 240_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await w.baseline(NOW);
});

const heartbeat = (age: number, problems: unknown) => ({
  at: new Date(NOW.getTime() - age).toISOString(),
  queues: ['house.alerts'],
  evalIngestOnly: false,
  envCredentials: [],
  runtime: { problems },
});

describe('missing queue alerts', () => {
  it('names queues and the migrate fix, de-duplicates and recovers once all live workers clear', async () => {
    const mailer = new RecordingMailer();
    const problems = [{ key: 'queues.missing', message: MESSAGE }];
    await w.setting('worker.heartbeat', {
      healthy: heartbeat(0, []),
      missing: heartbeat(0, problems),
      alsoMissing: heartbeat(0, problems),
    });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(mailer.lastEmail()?.text).toContain('user.estimate');
    expect(mailer.lastEmail()?.text).toContain('house.alerts');
    expect(mailer.lastEmail()?.text).toContain('run the migrate job');
    expect((await w.state())['service.queues_missing']).toMatchObject({ active: true });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    await w.setting('worker.heartbeat', {
      healthy: heartbeat(0, []),
      missing: heartbeat(0, []),
      alsoMissing: heartbeat(0, problems),
    });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    await w.setting('worker.heartbeat', { healthy: heartbeat(0, []) });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    await w.run(new Date(NOW.getTime() + 599_000), { mailer });
    expect((await w.state())['service.queues_missing']).toMatchObject({ active: true });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    await w.run(new Date(NOW.getTime() + 10 * 60_000), { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(2);
    expect((await w.state())['service.queues_missing']?.active ?? false).toBe(false);
    expect(mailer.lastEmail()?.text).toContain('Missing pg-boss queues');
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(2);
  });

  it('keeps an incident open across heartbeat deletion and restart without another alert mail', async () => {
    const mailer = new RecordingMailer();
    const problems = [{ key: 'queues.missing', message: MESSAGE }];
    await w.setting('worker.heartbeat', { missing: heartbeat(0, problems) });
    await w.run(NOW, { mailer });
    await w.setting('worker.heartbeat', { healthy: heartbeat(0, []) });
    await w.run(NOW, { mailer });
    expect((await w.state())['service.queues_missing']).toMatchObject({ active: true });
    await w.setting('worker.heartbeat', { restarted: heartbeat(0, problems) });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
  });

  it('unions different missing sets without truncating names or repeating migrate advice', async () => {
    const mailer = new RecordingMailer();
    const first = REQUIRED_PG_BOSS_QUEUES.slice(0, 22);
    const second = REQUIRED_PG_BOSS_QUEUES.slice(18);
    const problem = (missingQueues: readonly string[]) => [
      {
        key: 'queues.missing',
        missingQueues,
        message: `pg-boss queues missing: ${missingQueues.slice(0, 10).join(', ')} and more — run the migrate job`,
      },
    ];
    await w.setting('worker.heartbeat', {
      first: heartbeat(0, problem(first)),
      second: heartbeat(0, problem(second)),
      legacy: heartbeat(0, [{ key: 'queues.missing', message: MESSAGE }]),
    });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailer.lastEmail()?.text ?? '';
    expect(text).toContain(
      `pg-boss queues missing: ${[...REQUIRED_PG_BOSS_QUEUES].sort().join(', ')}; run the migrate job (pnpm db:migrate or the deploy migration step).`,
    );
    expect(text.match(/run the migrate job/giu)).toHaveLength(1);
  });

  it('ignores expired, far-future, malformed and unrelated heartbeat problems', async () => {
    const mailer = new RecordingMailer();
    await w.setting('worker.heartbeat', {
      healthy: heartbeat(0, []),
      stale: heartbeat(90_001, [{ key: 'queues.missing', message: MESSAGE }]),
      future: heartbeat(-90_001, [{ key: 'queues.missing', message: MESSAGE }]),
      malformed: heartbeat(0, [null, 'queues.missing', { key: 'queues.missing' }]),
      unrelated: heartbeat(0, [{ key: 'fetch.limits', message: 'bad limit' }]),
    });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(0);
  });
});

it('resets recovery grace when the service rule throws', async () => {
  const mailer = new RecordingMailer();
  await w.setting('worker.heartbeat', {
    missing: heartbeat(0, [{ key: 'queues.missing', message: MESSAGE }]),
  });
  await w.run(NOW, { mailer });
  await w.setting('worker.heartbeat', { healthy: heartbeat(0, []) });
  await w.run(NOW, { mailer });
  expect((await w.state())['memo.queues_absent']).toBeDefined();
  const service = ALERT_RULES.find((rule) => rule.id === 'service')!;
  const evaluate = vi.spyOn(service, 'evaluate').mockRejectedValueOnce(new Error('service failed'));
  try {
    await w.run(new Date(NOW.getTime() + 5 * 60_000), { mailer });
  } finally {
    evaluate.mockRestore();
  }
  expect((await w.state())['memo.queues_absent']).toBeUndefined();
  expect((await w.state())['service.queues_missing']).toMatchObject({ active: true });
  await w.run(new Date(NOW.getTime() + 6 * 60_000), { mailer });
  expect((await w.state())['memo.queues_absent']?.firstAt).toBe(
    new Date(NOW.getTime() + 6 * 60_000).toISOString(),
  );
  await w.run(new Date(NOW.getTime() + 959_000), { mailer });
  expect((await w.state())['service.queues_missing']).toMatchObject({ active: true });
  await w.run(new Date(NOW.getTime() + 16 * 60_000), { mailer });
  expect((await w.state())['service.queues_missing']?.active ?? false).toBe(false);
});

it('cleans the absence memo on a re-fire and starts a new grace window', async () => {
  const mailer = new RecordingMailer();
  const problems = [{ key: 'queues.missing', message: MESSAGE }];
  await w.setting('worker.heartbeat', { missing: heartbeat(0, problems) });
  await w.run(NOW, { mailer });
  await w.setting('worker.heartbeat', { healthy: heartbeat(0, []) });
  await w.run(NOW, { mailer });
  expect((await w.state())['memo.queues_absent']).toBeDefined();
  await w.setting('worker.heartbeat', { missing: heartbeat(-60_000, problems) });
  await w.run(new Date(NOW.getTime() + 60_000), { mailer });
  expect((await w.state())['memo.queues_absent']).toBeUndefined();
  expect(mailer.to(ADMIN)).toHaveLength(1);
  await w.setting('worker.heartbeat', { healthy: heartbeat(-120_000, []) });
  await w.run(new Date(NOW.getTime() + 120_000), { mailer });
  expect((await w.state())['memo.queues_absent']?.firstAt).toBe(
    new Date(NOW.getTime() + 120_000).toISOString(),
  );
});
