import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HOUR,
  MINUTE,
  RecordingMailer,
  hostHealth,
  opsEvent,
} from './support/alerts-world.js';

/**
 * M8-F1 (PLAN §14.1, spec 11 §6.1): a recovery mail names each cleared incident by its alert title
 * and the time the incident was first seen, not only by its alert key.
 *
 * Rules pinned here:
 * - the recovery mail text contains the title of the alert as the alert mail printed it (the first
 *   `* ` line of the alert digest), and the incident's `firstAt` as `YYYY-MM-DDTHH:MM` or
 *   `YYYY-MM-DD HH:MM` (UTC);
 * - the same holds when the stored incident predates the change (an `alerts.state` entry without
 *   any title field): the first-seen time is still printed and nothing throws.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const T0 = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12, 7));
const after = (ms: number, from: Date = T0): Date => new Date(from.getTime() + ms);

let h: ClassifyHarness;
let w: AlertsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

async function tick(at: Date, mailer: RecordingMailer): Promise<void> {
  await w.liveness(at);
  await w.events([
    opsEvent('backup_ok', new Date(at.getTime() - HOUR)),
    hostHealth(new Date(at.getTime() - MINUTE)),
  ]);
  await w.run(at, { mailer });
}

/** The title the alert digest printed for its first condition. */
function alertTitle(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('* '));
  if (line === undefined) throw new Error(`no bullet in the alert mail:\n${text}`);
  return line.slice(2).trim();
}

const minuteForms = (at: Date): string[] => {
  const iso = at.toISOString().slice(0, 16);
  return [iso, iso.replace('T', ' ')];
};

async function openAndHeal(mailer: RecordingMailer): Promise<{ alertText: string; text: string }> {
  await w.baseline(T0);
  await w.breaker('auth');
  await tick(T0, mailer);
  expect(mailer.to(ADMIN)).toHaveLength(1);
  const alertText = mailer.sent[0]!.text;
  return { alertText, text: '' };
}

describe('M8-F1 recovery mail content', () => {
  it('names the cleared incident by its alert title and first-seen time', async () => {
    const mailer = new RecordingMailer();
    const { alertText } = await openAndHeal(mailer);
    const title = alertTitle(alertText);
    expect(title.length).toBeGreaterThan(0);

    await w.breaker('closed');
    await tick(after(10 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(2);
    const recovery = mailer.sent[1]!;
    expect(recovery.subject).toContain('RECOVERED');
    expect(recovery.text, 'the alert title').toContain(title);
    expect(
      minuteForms(T0).some((form) => recovery.text.includes(form)),
      `the first-seen time ${T0.toISOString()} in:\n${recovery.text}`,
    ).toBe(true);
  });

  it('prints the first-seen time of an incident stored without any title', async () => {
    const mailer = new RecordingMailer();
    await openAndHeal(mailer);
    // An entry written before the change carries only these three fields.
    const state = await w.state();
    const legacy = Object.fromEntries(
      Object.entries(state).map(([key, e]) => [
        key,
        { firstAt: e.firstAt, lastSentAt: e.lastSentAt, active: e.active },
      ]),
    );
    await w.setting('alerts.state', legacy);

    await w.breaker('closed');
    await tick(after(10 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(2);
    const recovery = mailer.sent[1]!;
    expect(
      minuteForms(T0).some((form) => recovery.text.includes(form)),
      `the first-seen time in:\n${recovery.text}`,
    ).toBe(true);
    expect(await w.activeEntries(), 'incident closed').toHaveLength(0);
  });
});
