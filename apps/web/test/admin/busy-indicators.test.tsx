import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { gate } from '../interests/support.js';
import { bodyOf, renderApp, type ApiRouteHandler } from '../support/app.js';
import { patchAnswer, runtimeRoutes, worker, type RuntimeFixture } from './m8b-t10-support.js';
import {
  SETTINGS_VALUES,
  T1,
  T2,
  adminMe,
  adminRoutes,
  breaker,
  makeFeed,
  makeOverview,
  makeSettings,
  page,
  unhandledGuard,
} from './support.js';

/**
 * Buttons that start work the server only queues stay busy (`aria-busy`, disabled, label kept)
 * until the work is done, not until the request is answered.
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

type Queue = { queue: string; created: number; retry: number; active: number; failed: number };
const queue = (name: string, created: number, active = 0, retry = 0): Queue => ({
  queue: name,
  created,
  retry,
  active,
  failed: 0,
});
const overviewOf = (queues: Queue[]) => json(200, makeOverview({ queues }));

async function open(
  path: string,
  routes: Record<string, ApiRouteHandler>,
  runtime: RuntimeFixture | null = null,
) {
  return guard(
    await renderApp({
      path,
      server: {
        me: adminMe(),
        routes: runtime === null ? adminRoutes(routes) : runtimeRoutes(runtime, routes),
      },
    }),
  );
}

const busy = (button: HTMLElement) => {
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
};
const idle = (button: HTMLElement) => {
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute('aria-busy');
};

describe('settings save that queues re-processing', () => {
  it('keeps Save busy and says so until the house queues drain', async () => {
    let queues: Queue[] = [];
    const app = await open('/admin/settings', {
      'PATCH /admin/settings': () =>
        json(200, {
          ...makeSettings({ values: { ...SETTINGS_VALUES, card_text_mode: 'english' } }),
          changed: ['card_text_mode'],
        }),
      'GET /admin/overview': () => overviewOf(queues),
    });
    const group = await screen.findByRole('group', { name: 'card_text_mode' });
    const field = within(group).getByLabelText('card_text_mode');
    await app.user.clear(field);
    await app.user.type(field, '"english"');
    const save = () => within(group).getByRole('button', { name: 'Save card_text_mode' });

    await app.user.click(save());
    await wait(1_000);
    busy(save());
    expect(within(group).getByRole('status')).toHaveTextContent(/Re-processing/);

    // The intents are relayed after the answer: the queue first holds the work.
    queues = [queue('house.rematch', 3, 1), queue('house.translate-cards', 0, 1)];
    await wait(4_000);
    busy(save());

    queues = [queue('house.rematch', 0, 1)];
    await wait(4_000);
    busy(save());

    // A job that failed transiently waits for its retry: still not done.
    queues = [queue('house.rematch', 0, 0, 1)];
    await wait(4_000);
    busy(save());

    queues = [queue('feed.fetch', 9, 9)];
    await wait(4_000);
    expect(within(group).queryByRole('status')).toBeNull();
    // Unchanged text again after the save: nothing to save, but no longer busy.
    expect(save()).not.toHaveAttribute('aria-busy');
  });

  it('gives up waiting after ten minutes', async () => {
    const app = await open('/admin/settings', {
      'PATCH /admin/settings': () =>
        json(200, {
          ...makeSettings({ values: { ...SETTINGS_VALUES, card_text_mode: 'english' } }),
          changed: ['card_text_mode'],
        }),
      'GET /admin/overview': () => overviewOf([queue('house.rematch', 5, 1)]),
    });
    const group = await screen.findByRole('group', { name: 'card_text_mode' });
    const field = within(group).getByLabelText('card_text_mode');
    await app.user.clear(field);
    await app.user.type(field, '"english"');
    await app.user.click(within(group).getByRole('button', { name: 'Save card_text_mode' }));
    await wait(30_000);
    expect(within(group).getByRole('status')).toBeVisible();

    await wait(600_000);
    expect(within(group).queryByRole('status')).toBeNull();
  });

  it('shows no progress for a setting that queues nothing', async () => {
    const app = await open('/admin/settings', {
      'PATCH /admin/settings': () =>
        json(200, {
          ...makeSettings({ values: { ...SETTINGS_VALUES, signup_mode: 'open' } }),
          changed: ['signup_mode'],
        }),
    });
    const group = await screen.findByRole('group', { name: 'signup_mode' });
    const field = within(group).getByLabelText('signup_mode');
    await app.user.clear(field);
    await app.user.type(field, '"open"');
    await app.user.click(within(group).getByRole('button', { name: 'Save signup_mode' }));
    await wait(1_000);
    expect(within(group).queryByRole('status')).toBeNull();
    expect(app.calls('GET /admin/overview')).toHaveLength(0);
  });
});

describe('question set changes', () => {
  const before = { enrich: '1', match: '2', suggest: '4' };
  it.each([
    ['a new suggest set queues nothing', { ...before, suggest: '9' }, false],
    ['a new enrich set re-processes (control)', { ...before, enrich: '7' }, true],
  ])('%s', async (_name, after, shown) => {
    const app = await open('/admin/settings', {
      'GET /admin/settings': () =>
        json(200, makeSettings({ values: { ...SETTINGS_VALUES, 'question_sets.active': before } })),
      'PATCH /admin/settings': () =>
        json(200, {
          ...makeSettings({ values: { ...SETTINGS_VALUES, 'question_sets.active': after } }),
          changed: ['question_sets.active'],
        }),
      'GET /admin/overview': () => overviewOf([]),
    });
    const group = await screen.findByRole('group', { name: 'question_sets.active' });
    const field = within(group).getByLabelText('question_sets.active');
    await app.user.clear(field);
    await app.user.type(field, JSON.stringify(after).replaceAll('{', '{{'));
    await app.user.click(within(group).getByRole('button', { name: 'Save question_sets.active' }));
    await wait(1_000);
    if (shown) {
      expect(within(group).getByRole('status')).toHaveTextContent(/Re-processing/);
    } else {
      expect(within(group).queryByRole('status')).toBeNull();
      expect(app.calls('GET /admin/overview')).toHaveLength(0);
    }
  });
});

const saveButton = (key: string) => screen.getByRole('button', { name: `Save ${key}` });
const resetButton = (key: string) => screen.getByRole('button', { name: `Reset ${key}` });

async function type(
  app: {
    user: { clear: (e: Element) => Promise<void>; type: (e: Element, t: string) => Promise<void> };
  },
  key: string,
  text: string,
) {
  const input = within(screen.getByRole('group', { name: key })).getByLabelText(key);
  await app.user.clear(input);
  await app.user.type(input, text);
}

describe('runtime editor busy states', () => {
  it('keeps Reset busy while its request is in flight', async () => {
    const held = gate();
    const fixture: RuntimeFixture = { stored: { 'engine.concurrency': 4 } };
    const app = await open(
      '/admin/settings',
      {
        'PATCH /admin/settings': async () => {
          await held.opened;
          return patchAnswer({ 'engine.concurrency': null }, fixture);
        },
      },
      fixture,
    );
    await screen.findByRole('group', { name: 'engine.concurrency' });

    await app.user.click(resetButton('engine.concurrency'));
    busy(resetButton('engine.concurrency'));
    // The label stays, and the Save button is not the one marked busy.
    expect(saveButton('engine.concurrency')).not.toHaveAttribute('aria-busy');

    held.release();
    await vi.waitFor(() =>
      expect(resetButton('engine.concurrency')).not.toHaveAttribute('aria-busy'),
    );
  });

  it('keeps the confirmation dialog open, with Confirm busy, until the save is answered', async () => {
    const held = gate();
    const app = await open(
      '/admin/settings',
      {
        'PATCH /admin/settings': async (request) => {
          await held.opened;
          return patchAnswer(bodyOf(request) as Record<string, unknown>);
        },
      },
      {},
    );
    await screen.findByRole('group', { name: 'engine.typesafe_model' });
    await type(app, 'engine.typesafe_model', 'jev-1.14.0');
    await app.user.click(saveButton('engine.typesafe_model'));
    const dialog = await screen.findByRole('dialog');
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));

    const confirm = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Confirm and save',
    });
    busy(confirm);
    held.release();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('follows the re-matching a new prefilter minimum queues', async () => {
    let queues: Queue[] = [];
    const app = await open(
      '/admin/settings',
      {
        'PATCH /admin/settings': () =>
          json(200, {
            ...makeSettings({
              values: {
                ...SETTINGS_VALUES,
                'engine.prefilter_enabled': true,
                'engine.prefilter_min_cards': 80,
              },
              workers: [worker()],
            }),
            changed: ['engine.prefilter_min_cards'],
          }),
        'GET /admin/overview': () => overviewOf(queues),
      },
      {},
    );
    await screen.findByRole('group', { name: 'engine.prefilter_min_cards' });
    await type(app, 'engine.prefilter_min_cards', '80');
    await app.user.click(saveButton('engine.prefilter_min_cards'));
    await wait(1_000);
    busy(saveButton('engine.prefilter_min_cards'));

    queues = [queue('house.rematch', 0, 1)];
    await wait(4_000);
    busy(saveButton('engine.prefilter_min_cards'));

    queues = [];
    await wait(4_000);
    const group = screen.getByRole('group', { name: 'engine.prefilter_min_cards' });
    expect(within(group).queryByRole('status')).toBeNull();
    expect(saveButton('engine.prefilter_min_cards')).not.toHaveAttribute('aria-busy');
  });

  it('reads the workers again while one of them waits for a restart, then stops', async () => {
    let pending = true;
    let reads = 0;
    const app = await open(
      '/admin/settings',
      {
        'GET /admin/settings': () => {
          reads += 1;
          return json(200, {
            ...makeSettings({ workers: [worker({ pendingRestart: pending })] }),
            values: { ...SETTINGS_VALUES },
          });
        },
        'PATCH /admin/settings': () =>
          json(200, {
            ...makeSettings({
              values: { ...SETTINGS_VALUES, 'engine.concurrency': 6 },
              workers: [worker({ pendingRestart: true })],
            }),
            changed: ['engine.concurrency'],
          }),
      },
      {},
    );
    await screen.findByRole('group', { name: 'engine.concurrency' });
    await type(app, 'engine.concurrency', '6');
    await app.user.click(saveButton('engine.concurrency'));
    expect(await screen.findByText('Workers are restarting to apply the change…')).toBeVisible();

    const before = reads;
    await wait(9_000);
    expect(reads - before).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Workers are restarting to apply the change…')).toBeVisible();

    pending = false;
    await wait(4_000);
    expect(screen.queryByText('Workers are restarting to apply the change…')).toBeNull();
    // Past the grace period of a worker that has not reported yet, nothing is read any more.
    await wait(40_000);
    const settled = reads;
    await wait(30_000);
    expect(reads).toBe(settled);
  });

  it('keeps reading through a full worker heartbeat before it trusts "no restart pending"', async () => {
    let pending = false;
    const app = await open(
      '/admin/settings',
      {
        'GET /admin/settings': () =>
          json(200, {
            ...makeSettings({ workers: [worker({ pendingRestart: pending })] }),
            values: { ...SETTINGS_VALUES },
          }),
        'PATCH /admin/settings': () =>
          json(200, {
            ...makeSettings({
              values: { ...SETTINGS_VALUES, 'engine.concurrency': 6 },
              workers: [worker({ pendingRestart: false })],
            }),
            changed: ['engine.concurrency'],
          }),
      },
      {},
    );
    await screen.findByRole('group', { name: 'engine.concurrency' });
    await type(app, 'engine.concurrency', '6');
    await app.user.click(saveButton('engine.concurrency'));

    // The worker's settings check (10 s) and its next heartbeat (30 s) report the restart late.
    await wait(38_000);
    pending = true;
    expect(
      await screen.findByText('Workers are restarting to apply the change…', undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
  });
});

describe('overview', () => {
  it('keeps the translations button busy until house.retranslate-skipped drains', async () => {
    let queues: Queue[] = [];
    const app = await open('/admin', {
      'GET /admin/overview': () => overviewOf(queues),
      'POST /admin/translations/reprocess': () => json(202, { queued: true }),
    });
    const button = () => screen.getByRole('button', { name: 'Reprocess translations' });
    await screen.findByRole('button', { name: 'Reprocess translations' });

    await app.user.click(button());
    await wait(1_000);
    busy(button());

    queues = [queue('house.retranslate-skipped', 1)];
    await wait(4_000);
    busy(button());
    queues = [queue('house.retranslate-skipped', 0, 1)];
    await wait(4_000);
    busy(button());

    queues = [];
    await wait(4_000);
    idle(button());
  });

  it('keeps the breaker Reset busy while the worker has not applied the reset', async () => {
    let current = breaker({ state: 'open', openUntil: T2 });
    const app = await open('/admin', {
      'GET /admin/overview': () =>
        json(
          200,
          makeOverview({
            engine: { ...makeOverview().engine, breakers: { typesafe: current, llm: breaker() } },
          }),
        ),
      'POST /admin/engine/reset-breaker': () => {
        current = { ...current, resetRequestedAt: T1 };
        return json(200, { engine: 'typesafe', resetRequestedAt: T1 });
      },
    });
    const card = await screen.findByRole('group', { name: 'Jev (typesafe)' });
    const reset = () => within(card).getByRole('button', { name: 'Reset breaker' });

    await app.user.click(reset());
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset breaker' }),
    );
    expect(
      await within(card).findByText('Waiting for the worker to apply the reset…'),
    ).toBeVisible();
    busy(reset());

    current = breaker({ state: 'closed', resetRequestedAt: T1 });
    await wait(4_000);
    idle(reset());
  });
  it('ends the breaker wait after 30 s even while the overview cannot be read', async () => {
    let failing = false;
    const current = breaker({ state: 'open', openUntil: T2 });
    const app = await open('/admin', {
      'GET /admin/overview': () =>
        failing
          ? json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } })
          : json(
              200,
              makeOverview({
                engine: {
                  ...makeOverview().engine,
                  breakers: { typesafe: current, llm: breaker() },
                },
              }),
            ),
      'POST /admin/engine/reset-breaker': () => {
        failing = true;
        return json(200, { engine: 'typesafe', resetRequestedAt: T1 });
      },
    });
    const card = await screen.findByRole('group', { name: 'Jev (typesafe)' });
    const reset = () => within(card).getByRole('button', { name: 'Reset breaker' });

    await app.user.click(reset());
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset breaker' }),
    );
    await wait(1_000);
    busy(reset());

    await wait(31_000);
    idle(reset());
  });
});

describe('feeds', () => {
  it('keeps the row busy until the reset feed has been fetched again', async () => {
    let feed = makeFeed({ id: '42', title: 'Broken Blog', lastSuccessAt: T1, lastErrorAt: null });
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page([feed])),
      'POST /admin/feeds/:id/reset': () => json(200, { feed }),
    });
    await screen.findByRole('table', { name: 'Feeds' });
    const reset = () => screen.getByRole('button', { name: 'Reset Broken Blog' });

    await app.user.click(reset());
    await wait(7_000);
    busy(reset());

    feed = { ...feed, lastSuccessAt: T2 };
    await wait(4_000);
    idle(reset());
    const settled = (app.calls('GET /admin/feeds') as unknown[]).length;
    await wait(15_000);
    expect(app.calls('GET /admin/feeds')).toHaveLength(settled);
  });

  it('stops waiting for a fetch after two minutes', async () => {
    const feed = makeFeed({ id: '42', title: 'Broken Blog' });
    const app = await open('/admin/feeds', {
      'GET /admin/feeds': () => json(200, page([feed])),
      'POST /admin/feeds/:id/reset': () => json(200, { feed }),
    });
    await screen.findByRole('table', { name: 'Feeds' });
    const reset = () => screen.getByRole('button', { name: 'Reset Broken Blog' });
    await app.user.click(reset());
    await wait(60_000);
    busy(reset());
    await wait(65_000);
    idle(reset());
  });
});
