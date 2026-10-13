import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESOURCES } from '../../src/i18n/resources.js';
import { renderApp } from '../support/app.js';
import { runtimeRoutes, worker, type RuntimeFixture } from './m8b-t10-support.js';
import { adminMe, unhandledGuard } from './support.js';

/**
 * M8b-T10 ruler: applied-by-workers status from a heartbeat fixture, and en/sk strings.
 * Convention: `role=status` named 'Applied by workers' holds 'N live workers' (or 'No live workers')
 * and, when any fresh worker reports pendingRestart, 'Pending restart: K of N workers'. A worker's
 * problems show inside the group of their key as 'Rejected by worker: <message>'.
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

async function open(fixture: RuntimeFixture, language?: 'en' | 'sk') {
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      ...(language ? { language } : {}),
      server: { me: adminMe(), routes: runtimeRoutes(fixture) },
    }),
  );
  await screen.findByRole('status', {
    name: language === 'sk' ? /.+/ : 'Applied by workers',
  });
  return app;
}

const status = () => screen.getByRole('status', { name: 'Applied by workers' });

describe('M8b-T10 applied-by-workers status', () => {
  it('says pending restart when any fresh worker has pendingRestart', async () => {
    await open({
      workers: [
        worker({ processId: 'worker-1', pendingRestart: true }),
        worker({ processId: 'worker-2' }),
      ],
    });

    expect(within(status()).getByText('2 live workers')).toBeVisible();
    expect(within(status()).getByText('Pending restart: 1 of 2 workers')).toBeVisible();
  });

  it('does not say pending restart when no worker has it (negative control)', async () => {
    await open({ workers: [worker(), worker({ processId: 'worker-2' })] });

    expect(within(status()).getByText('2 live workers')).toBeVisible();
    expect(within(status()).queryByText(/Pending restart/)).toBeNull();
    expect(screen.queryByText(/Pending restart/)).toBeNull();
  });

  it('says there are no live workers when none beat recently', async () => {
    await open({ workers: [] });

    expect(within(status()).getByText('No live workers')).toBeVisible();
    expect(within(status()).queryByText(/Pending restart/)).toBeNull();
  });

  it('lists a worker problem inside the group of its key only', async () => {
    await open({
      workers: [
        worker({
          problems: [
            { key: 'engine.typesafe_model', message: 'model jev-9 has no price entry' },
            { key: 'fetch.limits', message: 'maxBytes above the limit' },
          ],
        }),
      ],
    });

    const model = screen.getByRole('group', { name: 'engine.typesafe_model' });
    expect(
      within(model).getByText('Rejected by worker: model jev-9 has no price entry'),
    ).toBeVisible();
    const fetch = screen.getByRole('group', { name: 'fetch.limits' });
    expect(within(fetch).getByText('Rejected by worker: maxBytes above the limit')).toBeVisible();
    expect(within(fetch).queryByText(/jev-9/)).toBeNull();
    const concurrency = screen.getByRole('group', { name: 'engine.concurrency' });
    expect(within(concurrency).queryByText(/Rejected by worker/)).toBeNull();
  });

  it('shows no problem text when the workers report none (negative control)', async () => {
    await open({ workers: [worker()] });

    expect(screen.queryByText(/Rejected by worker/)).toBeNull();
  });
});

/** The strings every new surface needs in both languages (admin namespace). */
const REQUIRED = [
  'settings.groups.engine',
  'settings.groups.ollama',
  'settings.groups.ingestion',
  'settings.groups.api',
  'settings.groups.translation',
  'settings.source.stored',
  'settings.source.env',
  'settings.source.lastGood',
  'settings.defaultValue',
  'settings.reset',
  'settings.ack.title',
  'settings.ack.checkbox',
  'settings.ack.confirm',
  'settings.ack.cancel',
  'settings.workers.title',
  'settings.workers.live',
  'settings.workers.none',
  'settings.workers.pendingRestart',
  'settings.workers.problem',
];

function lookup(messages: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null ? (node as never)[part] : undefined,
      messages,
    );
}

describe('M8b-T10 strings', () => {
  it.each(REQUIRED)('has %s in en and sk, translated', (path) => {
    const en = lookup(RESOURCES.en['admin'] ?? {}, path);
    const sk = lookup(RESOURCES.sk['admin'] ?? {}, path);
    // Plural forms (workers.live) live under `_one`/`_other` etc.; accept a key or its forms.
    const present = (value: unknown, lang: 'en' | 'sk') => {
      if (typeof value === 'string' && value !== '') return true;
      const parent = lookup(RESOURCES[lang]['admin'] ?? {}, path.split('.').slice(0, -1).join('.'));
      const leaf = path.split('.').at(-1)!;
      return (
        typeof parent === 'object' &&
        parent !== null &&
        Object.keys(parent).some((k) => k.startsWith(`${leaf}_`))
      );
    };
    expect(present(en, 'en')).toBe(true);
    expect(present(sk, 'sk')).toBe(true);
    if (typeof en === 'string' && typeof sk === 'string' && !/^[^a-zA-Z]*$/.test(en)) {
      expect(sk).not.toBe(en);
    }
  });

  it('shows no English group heading or button name on the Slovak screen', async () => {
    await open({ stored: { 'engine.concurrency': 12 } }, 'sk');

    expect(screen.queryByRole('group', { name: 'Decision engine (Jev)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset engine.concurrency' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save engine.concurrency' })).toBeNull();
    expect(screen.getByRole('group', { name: 'engine.concurrency' })).toBeVisible();
  });
});
