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
 * PR #28 review round 2: a temporary LibreTranslate client built to probe a URL that is not the live
 * one is closed after the probe; the shared live client never is.
 */

const OTHER_URL = 'http://other-lt.test:5000';
const ALL_LANGUAGES = [
  { code: 'en', name: 'English', targets: ['en', 'sk', 'cs'] },
  { code: 'sk', name: 'Slovak', targets: ['en'] },
  { code: 'cs', name: 'Czech', targets: ['en'] },
];

interface Spy {
  client: LibreTranslateClient;
  closes: number;
  probes: number;
}

function spyClient(ok = true): Spy {
  const spy = {
    closes: 0,
    probes: 0,
    client: {
      languages: () => {
        spy.probes += 1;
        return Promise.resolve(
          ok
            ? { ok: true as const, languages: ALL_LANGUAGES }
            : { ok: false as const, reason: 'unreachable' as const },
        );
      },
      close: () => {
        spy.closes += 1;
        return Promise.resolve();
      },
    } as unknown as LibreTranslateClient,
  };
  return spy;
}

let h: ApiHarness;
let admin: TestUser;
let live: Spy;
let made: { url: string; spy: Spy }[];
let nextTemporary: () => Spy;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});

afterAll(async () => {
  await h.close();
});

const slovak = { language_modes: { en: 'native', sk: 'translate', cs: 'native' } };

async function server() {
  return h.buildAnother({
    libreTranslate: live.client,
    createProbeLibreTranslate: (url) => {
      const spy = nextTemporary();
      made.push({ url, spy });
      return spy.client;
    },
  });
}

beforeEach(async () => {
  live = spyClient();
  made = [];
  nextTemporary = () => spyClient();
  await h.owner.query(
    "DELETE FROM settings WHERE key IN ('worker.heartbeat','language_modes','card_text_mode','translate.libretranslate_url')",
  );
});

describe('probe client lifetime', () => {
  it('closes the temporary client of a different URL once, and not the live one', async () => {
    const res = await apiClient(await server(), admin).patch('/admin/settings', {
      ...slovak,
      'translate.libretranslate_url': OTHER_URL,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(made.map((m) => m.url)).toEqual([OTHER_URL]);
    expect(made[0]?.spy.probes).toBe(1);
    expect(made[0]?.spy.closes).toBe(1);
    expect(live.closes).toBe(0);
    expect(live.probes).toBe(0);
  });

  it('closes it when the probe refuses the change too', async () => {
    nextTemporary = () => spyClient(false);
    const res = await apiClient(await server(), admin).patch('/admin/settings', {
      ...slovak,
      'translate.libretranslate_url': OTHER_URL,
    });
    expect(res.statusCode, res.body).toBe(503);
    expect(made[0]?.spy.closes).toBe(1);
    expect(live.closes).toBe(0);
  });

  it('control: probing the live URL uses the live client and closes nothing', async () => {
    const res = await apiClient(await server(), admin).patch('/admin/settings', slovak);
    expect(res.statusCode, res.body).toBe(200);
    expect(live.probes).toBe(1);
    expect(live.closes).toBe(0);
    expect(made).toEqual([]);
  });
});
