import type { LibreTranslateClient } from '@bantoozi/translate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PR #28 review round 2: a language change is accepted on the capabilities of the LibreTranslate URL
 * that is current inside the write transaction. A URL changed between the preflight probe and the
 * transaction makes the probe stale: 409 settings_changed, nothing stored.
 */

const NEW_URL = 'http://changed-lt.test:5000';
const LANGUAGES = [
  { code: 'en', name: 'English', targets: ['en', 'sk'] },
  { code: 'sk', name: 'Slovak', targets: ['en'] },
];

let h: ApiHarness;
let admin: TestUser;
let onProbe: () => Promise<void>;

const client = {
  languages: async () => {
    await onProbe();
    return { ok: true as const, languages: LANGUAGES };
  },
  close: () => Promise.resolve(),
} as unknown as LibreTranslateClient;

beforeAll(async () => {
  h = await createApiHarness({ libreTranslate: client });
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  onProbe = () => Promise.resolve();
  await h.owner.query(
    "DELETE FROM settings WHERE key IN ('worker.heartbeat','language_modes','card_text_mode','translate.libretranslate_url')",
  );
});

const stored = async (key: string): Promise<unknown> =>
  (await h.owner.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]))
    .rows[0]?.value;
const slovak = { language_modes: { en: 'native', sk: 'translate', cs: 'native' } };
const patch = (body: unknown) => apiClient(h.server, admin).patch('/admin/settings', body);

describe('language change while the LibreTranslate URL changes under the probe', () => {
  it('refuses with 409 settings_changed and stores nothing', async () => {
    onProbe = async () => {
      await h.owner.query(
        `INSERT INTO settings (key, value) VALUES ('translate.libretranslate_url', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(NEW_URL)],
      );
    };
    const res = await patch(slovak);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details.reason).toBe('settings_changed');
    expect(await stored('language_modes')).toBeUndefined();
  });

  it('control: no concurrent change is accepted', async () => {
    const res = await patch(slovak);
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored('language_modes')).toEqual(slovak.language_modes);
  });
});
