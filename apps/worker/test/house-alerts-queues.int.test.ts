import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    expect(mailer.to(ADMIN)).toHaveLength(2);
    expect((await w.state())['service.queues_missing']?.active ?? false).toBe(false);
    expect(mailer.lastEmail()?.text).toContain('Missing pg-boss queues');
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(2);
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
