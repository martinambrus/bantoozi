import type { CredentialStatus } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESOURCES } from '../../src/i18n/resources.js';
import { json } from '../api/fake-fetch.js';
import { renderApp } from '../support/app.js';
import { T1, adminMe, adminRoutes, makeCredential, unhandledGuard } from './support.js';

/**
 * M8b-T9 (scope A4, spec 09 §8): the Providers keyring banner.
 *
 * Rules chosen here:
 *  - The credentials answer carries `keyring: {api: {status, activeKeyId?}, workers: [{workerId,
 *    status, activeKeyId?}], mismatch}` (see apps/api/test/m8b-t9-keyring.int.test.ts).
 *  - The banner is the element with `data-testid="keyring-banner"`, rendered only when the API or
 *    any worker is not ok, or `mismatch` is true; with a healthy keyring there is no banner.
 *  - missing -> shows the command `pnpm setup:env`; malformed and active_key_missing -> name the
 *    variable to fix (PROVIDER_MASTER_KEYS / PROVIDER_MASTER_KEY_ID) and say to restart; mismatch ->
 *    says to restart and names both key ids. A worker problem names the worker id.
 *  - No banner text ever contains key material.
 *  - Every "Stage key" button is disabled while the banner shows a status problem, even with a key
 *    typed; a mismatch alone does not disable it.
 *  - i18n: `admin` namespace keys under `providers.keyring` in en and sk, same paths, all non-empty,
 *    including `missing`, `malformed`, `active_key_missing` and `mismatch`.
 */

const guard = unhandledGuard();
const NOW = Date.parse(T1) + 3_600_000;
const JEV = 'Jev (typesafe)';
const SECRET = 'sk-test-SECRET-9f3a7c41';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

interface Keyring {
  api: { status: string; activeKeyId?: string };
  workers: { workerId: string; status: string; activeKeyId?: string }[];
  mismatch: boolean;
}

const OK: Keyring = { api: { status: 'ok', activeKeyId: 'k1' }, workers: [], mismatch: false };

const credentials = (): CredentialStatus[] => [
  makeCredential('typesafe', { source: 'db', enabled: true, revision: '5', activeVersion: '3' }),
  makeCredential('ollama'),
];

async function open(keyring: Keyring, language?: 'en' | 'sk') {
  const app = guard(
    await renderApp({
      path: '/admin/providers',
      ...(language === undefined ? {} : { language }),
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/engine/credentials': () => json(200, { items: credentials(), keyring }),
        }),
      },
    }),
  );
  await screen.findByRole('region', { name: JEV });
  return app;
}

const banner = () => screen.queryByTestId('keyring-banner');

async function expectStageDisabled(app: Awaited<ReturnType<typeof open>>, disabled: boolean) {
  const panel = within(screen.getByRole('region', { name: JEV }));
  const input = panel.getByLabelText(/New API key for|Nový API kľúč/);
  if (!(input as HTMLInputElement).disabled) await app.user.type(input, SECRET);
  const button = panel.getByRole('button', { name: /Stage key|Uložiť kľúč|Zapísať/ });
  if (disabled) expect(button).toBeDisabled();
  else expect(button).toBeEnabled();
}

describe('Providers keyring banner (spec 09 §8)', () => {
  it('shows no banner and leaves Stage enabled when everything is ok (negative control)', async () => {
    const app = await open({
      ...OK,
      workers: [{ workerId: 'w:1', status: 'ok', activeKeyId: 'k1' }],
    });
    expect(banner()).toBeNull();
    await expectStageDisabled(app, false);
  });

  it('missing: shows the exact command `pnpm setup:env` and disables Stage', async () => {
    const app = await open({ ...OK, api: { status: 'missing' } });
    const el = banner();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('pnpm setup:env');
    await expectStageDisabled(app, true);
  });

  it('malformed: names PROVIDER_MASTER_KEYS and asks for a restart, and disables Stage', async () => {
    const app = await open({ ...OK, api: { status: 'malformed' } });
    const text = banner()?.textContent ?? '';
    expect(text).toContain('PROVIDER_MASTER_KEYS');
    expect(text).toMatch(/restart/i);
    await expectStageDisabled(app, true);
  });

  it('active_key_missing: names PROVIDER_MASTER_KEY_ID and asks for a restart, and disables Stage', async () => {
    const app = await open({ ...OK, api: { status: 'active_key_missing' } });
    const text = banner()?.textContent ?? '';
    expect(text).toContain('PROVIDER_MASTER_KEY_ID');
    expect(text).toMatch(/restart/i);
    await expectStageDisabled(app, true);
  });

  it('a worker that is not ok shows the banner naming the worker, and disables Stage', async () => {
    const app = await open({
      ...OK,
      workers: [{ workerId: 'host-7:4242', status: 'missing' }],
    });
    const text = banner()?.textContent ?? '';
    expect(text).toContain('host-7:4242');
    expect(text).toContain('pnpm setup:env');
    await expectStageDisabled(app, true);
  });

  it('a mismatch shows both key ids and a restart instruction; Stage stays enabled', async () => {
    const app = await open({
      api: { status: 'ok', activeKeyId: 'key-api-1' },
      workers: [{ workerId: 'w:1', status: 'ok', activeKeyId: 'key-worker-2' }],
      mismatch: true,
    });
    const text = banner()?.textContent ?? '';
    expect(text).toContain('key-api-1');
    expect(text).toContain('key-worker-2');
    expect(text).toMatch(/restart/i);
    await expectStageDisabled(app, false);
  });

  it('renders the banner in Slovak too, with the command unchanged', async () => {
    await open({ ...OK, api: { status: 'missing' } }, 'sk');
    const sk = banner()?.textContent ?? '';
    expect(sk).toContain('pnpm setup:env');
  });
});

describe('keyring messages (en + sk)', () => {
  function section(lang: 'en' | 'sk'): Record<string, unknown> {
    const admin = (RESOURCES as unknown as Record<string, Record<string, Record<string, unknown>>>)[
      lang
    ]!.admin!;
    return (admin.providers as Record<string, Record<string, unknown>>).keyring ?? {};
  }

  it('has the same non-empty keys in both languages', () => {
    const en = section('en');
    const sk = section('sk');
    for (const key of ['missing', 'malformed', 'active_key_missing', 'mismatch']) {
      expect(typeof en[key], `en ${key}`).toBe('string');
      expect(typeof sk[key], `sk ${key}`).toBe('string');
      expect((en[key] as string).length).toBeGreaterThan(0);
      expect((sk[key] as string).length).toBeGreaterThan(0);
    }
    expect(Object.keys(sk).sort()).toEqual(Object.keys(en).sort());
  });
});
