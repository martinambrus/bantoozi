import type { Mailer } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import { deliver } from '../src/alerts/mail.js';

type Entry = { obj: { job?: string }; msg: string };

const refusing = {
  transport: 'log',
  send: () => Promise.reject(new Error('smtp unavailable')),
} as unknown as Mailer;

function logged() {
  const entries: Entry[] = [];
  const logger = {
    info: () => {},
    error: () => {},
    warn: (obj: object, msg: string) => void entries.push({ obj, msg }),
  };
  return { entries, logger };
}

describe('alert mail log label', () => {
  it('labels a failed delivery with the calling job, house.alerts by default', async () => {
    const content = { subject: 's', text: 't' };
    const a = logged();
    await expect(deliver(a, refusing, ['a@example.test'], content)).resolves.toBe(false);
    expect(a.entries.map((e) => e.obj.job)).toEqual(['house.alerts']);
    const w = logged();
    await expect(
      deliver(w, refusing, ['a@example.test'], content, 'house.model-watch'),
    ).resolves.toBe(false);
    expect(w.entries.map((e) => e.obj.job)).toEqual(['house.model-watch']);
    expect(w.entries[0]?.msg).toBe('alert email not delivered');
  });
});
