import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { AlertsWorld, DAY, RecordingMailer } from './support/alerts-world.js';

/**
 * M8b-T7 (owner 2026-10-13): `house.alerts` mails every ACTIVE admin in the database, not the
 * `ADMIN_EMAILS` list. The list is the fallback recipient list only while no active admin exists; with
 * neither, nothing is sent and the handler does not throw.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12));
const EMAILS = {
  a: 'alert-admin-a@example.test',
  b: 'alert-admin-b@example.test',
  gone: 'alert-admin-gone@example.test',
  plain: 'alert-plain@example.test',
  stale: 'stale-env@example.test',
  fallback: 'fallback-env@example.test',
};

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
  await h.owner.query(`DELETE FROM users WHERE email = ANY($1)`, [
    [EMAILS.a, EMAILS.b, EMAILS.gone, EMAILS.plain],
  ]);
  // Any admin another test file left behind would change the recipients.
  await h.owner.query(`UPDATE users SET role = 'user' WHERE role = 'admin'`);
});

/** A firing world (one open breaker), one run at NOW. */
async function fire(adminEmails: string[]): Promise<RecordingMailer> {
  await w.baseline(NOW);
  await w.breaker('auth');
  const mailer = new RecordingMailer();
  await w.run(NOW, { mailer, adminEmails });
  return mailer;
}

describe('house.alerts recipients (spec 11 §6.1, M8b-T7)', () => {
  it('mails the active DB admins and not a stale ADMIN_EMAILS address, a deleted admin or a plain user', async () => {
    await createUser(h.owner, { email: EMAILS.a, role: 'admin' });
    await createUser(h.owner, { email: EMAILS.b, role: 'admin' });
    await createUser(h.owner, { email: EMAILS.gone, role: 'admin', deletedAt: new Date() });
    await createUser(h.owner, { email: EMAILS.plain, role: 'user' });
    const mailer = await fire([EMAILS.stale]);
    expect(mailer.to(EMAILS.a)).toHaveLength(1);
    expect(mailer.to(EMAILS.b)).toHaveLength(1);
    expect(mailer.to(EMAILS.stale)).toHaveLength(0);
    expect(mailer.to(EMAILS.gone)).toHaveLength(0);
    expect(mailer.to(EMAILS.plain)).toHaveLength(0);
  });

  it('falls back to ADMIN_EMAILS when no active admin exists (a soft-deleted admin does not count)', async () => {
    await createUser(h.owner, { email: EMAILS.gone, role: 'admin', deletedAt: new Date() });
    const mailer = await fire([EMAILS.fallback]);
    expect(mailer.to(EMAILS.fallback)).toHaveLength(1);
    expect(mailer.to(EMAILS.gone)).toHaveLength(0);
  });

  it('sends nothing and does not throw when there is no admin and ADMIN_EMAILS is empty', async () => {
    const mailer = await fire([]);
    expect(mailer.sent).toHaveLength(0);
    expect(mailer.attempts).toBe(0);
  });

  it('negative control: a quiet world mails nobody even with admins present', async () => {
    await createUser(h.owner, { email: EMAILS.a, role: 'admin' });
    await w.baseline(NOW);
    const mailer = new RecordingMailer();
    await w.run(NOW, { mailer, adminEmails: [EMAILS.stale] });
    expect(mailer.sent).toHaveLength(0);
  });
});
