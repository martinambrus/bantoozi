import type { AdminEngineModel } from '@bantoozi/shared';
import { act, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESOURCES } from '../../src/i18n/resources.js';
import { UUID_V4, failure } from '../api/fake-fetch.js';
import { gate } from '../interests/support.js';
import { bodyOf, renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';
import {
  modelServer,
  patchAnswer,
  runtimeRoutes,
  worker,
  type ModelServerOptions,
  type RuntimeFixture,
} from './m8b-t10-support.js';
import {
  MODEL_NOW,
  T1,
  adminMe,
  freshProbes,
  modelAgo,
  modelProbe,
  printedTime,
  unhandledGuard,
} from './support.js';

/**
 * JEV-5 ruler: the Jev release editor of Admin → Settings (`engine.typesafe_model`). Contract fixed
 * by this ruler (visible-learning §4.1, packages/shared/src/model-impact.ts):
 * - Inside the key group (`role=group` named the key): a radiogroup 'Jev release' with the radios
 *   'Follow the newest Jev (jev-latest)' and 'Use one release'; pinned mode shows the text input
 *   labelled exactly the key; alias mode shows 'Resolves to {model} · checked {time}' (or 'Not
 *   resolved yet. …') and 'Check now' (only while the SAVED setting is the alias).
 * - Save: a target equal to the saved setting is sent at once; otherwise the editor reads the
 *   status, reuses a probe that is fresh on the API clock (up to 8 minutes old) or asks for one
 *   (one POST per click, polled every 1.5 s for 90 s at most), then shows the dialog the change
 *   needs and sends the PATCH, with `acknowledge` only for a restart.
 * - Slovak is rendered from the strings of a2-web.md S4.
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(MODEL_NOW));
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

const MODEL = 'engine.typesafe_model';
const ALIAS = 'jev-latest';
const DEFAULT = 'jev-1.13.0';
const PATCH = 'PATCH /admin/settings';
const GET_MODEL = 'GET /admin/engine/model';
const POST_PROBE = 'POST /admin/engine/model-probe';
const POST_CHECK = 'POST /admin/engine/model-check';
const TICK = 'I ran eval replay and it passed';
const KEPT_TEXT = 'Ratings and personal models are kept; the 14-day window is analysed again.';
const RESTART_TITLE = 'This change re-enriches the corpus';
const CHANGE_TITLE = 'Change the Jev release?';

interface Open {
  /** The stored setting; omitted or null: no stored row, the environment default (jev-1.13.0). */
  saved?: string | null;
  savedAt?: string;
  status?: Partial<AdminEngineModel>;
  server?: ModelServerOptions;
  routes?: Record<string, ApiRouteHandler>;
  language?: 'en' | 'sk';
  /** Problems a live worker reports for the key. */
  problems?: string[];
  /** Skips the PATCH handler of the model server (the test routes PATCH itself). */
  ownPatch?: boolean;
}

/** The status of a setting that follows jev-latest, which resolved to `model` at `checkedAt`. */
const aliasStatus = (model = DEFAULT, checkedAt = modelAgo(15)): Partial<AdminEngineModel> => ({
  setting: { value: ALIAS, source: 'stored' },
  resolution: { alias: ALIAS, model, resolvedAt: modelAgo(60 * 24), checkedAt },
  pin: { model, alias: ALIAS, since: T1 },
});

async function open(o: Open = {}) {
  const saved = o.saved ?? null;
  const fixture: RuntimeFixture = {
    // Existing alias fixtures describe a setting saved before its active resolution.
    storedAt: o.savedAt ?? '2026-09-01T00:00:00.000Z',
    ...(saved === null ? {} : { stored: { [MODEL]: saved } }),
    ...(o.problems
      ? { workers: [worker({ problems: o.problems.map((message) => ({ key: MODEL, message })) })] }
      : {}),
  };
  const value = saved ?? DEFAULT;
  const model = modelServer(
    {
      setting: { value, source: saved === null ? 'env' : 'stored' },
      pin: { model: value === ALIAS ? DEFAULT : value, since: T1 },
      ...o.status,
    },
    o.server,
  );
  const server: FakeServer = {
    me: adminMe(),
    routes: runtimeRoutes(fixture, {
      ...model.routes(),
      ...(o.ownPatch
        ? {}
        : { [PATCH]: (request) => model.patched(bodyOf(request) as never, fixture) }),
      ...o.routes,
    }),
  };
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      ...(o.language ? { language: o.language } : {}),
      server,
    }),
  );
  await screen.findByRole('group', { name: MODEL });
  await within(group()).findByRole('radiogroup', {
    name: o.language === 'sk' ? 'Vydanie Jevu' : 'Jev release',
  });
  return { app, model, server, fixture };
}

const group = () => screen.getByRole('group', { name: MODEL });
const inGroup = () => within(group());
const input = () => inGroup().getByLabelText(MODEL);
const saveButton = () =>
  inGroup().getByRole('button', { name: new RegExp(`^(Save|Uložiť) ${MODEL}$`) });
const resetButton = () => inGroup().getByRole('button', { name: `Reset ${MODEL}` });
const revertButton = () => inGroup().getByRole('button', { name: `Revert ${MODEL}` });
const radio = (name: string) => inGroup().getByRole('radio', { name });
const LATEST_RADIO = 'Follow the newest Jev (jev-latest)';
const PINNED_RADIO = 'Use one release';

async function typeId(app: { user: UserEvent }, text: string) {
  await app.user.clear(input());
  await app.user.type(input(), text);
}

const changeDialog = () => screen.findByRole('dialog', { name: CHANGE_TITLE });
const restartDialog = () => screen.findByRole('dialog', { name: RESTART_TITLE });
const confirmIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Confirm and save' });
const tickIn = (dialog: HTMLElement) => within(dialog).getByRole('checkbox', { name: TICK });
const alertText = async () => (await inGroup().findByRole('alert')).textContent;

describe('JEV-5 the Jev release editor: layout', () => {
  it('shows alias mode: the radios, where jev-latest points, when it was checked, and Check now', async () => {
    const checkedAt = modelAgo(15);
    await open({ saved: ALIAS, status: aliasStatus(DEFAULT, checkedAt) });

    const radios = inGroup().getByRole('radiogroup', { name: 'Jev release' });
    expect(within(radios).getAllByRole('radio')).toHaveLength(2);
    expect(radio(LATEST_RADIO)).toBeChecked();
    expect(radio(PINNED_RADIO)).not.toBeChecked();
    expect(inGroup().queryByLabelText(MODEL)).toBeNull();
    expect(group()).toHaveTextContent(`Resolves to ${DEFAULT} · checked ${printedTime(checkedAt)}`);
    expect(inGroup().getByRole('button', { name: 'Check now' })).toBeEnabled();
    expect(group()).toHaveTextContent('Source: stored');
    expect(group()).toHaveTextContent('Default: jev-1.13.0');
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeEnabled();
    expect(revertButton()).toBeDisabled();
  });

  it('names the day too when the check was not today', async () => {
    const checkedAt = modelAgo(30 * 60);
    await open({ saved: ALIAS, status: aliasStatus(DEFAULT, checkedAt) });

    const day = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeZone: 'Europe/Bratislava',
    }).format(new Date(checkedAt));
    expect(group()).toHaveTextContent(printedTime(checkedAt));
    expect(group()).toHaveTextContent(day);
  });

  it('says so when the alias was never resolved', async () => {
    await open({
      saved: ALIAS,
      status: { setting: { value: ALIAS, source: 'stored' }, resolution: null, pin: null },
    });

    expect(group()).toHaveTextContent(
      'Not resolved yet. Check now, or wait for the next scheduled check.',
    );
    expect(group()).not.toHaveTextContent('Resolves to');
    expect(inGroup().getByRole('button', { name: 'Check now' })).toBeVisible();
  });

  it('shows pinned mode: the id box labelled with the key, no resolution line, no Check now', async () => {
    await open();

    expect(radio(PINNED_RADIO)).toBeChecked();
    expect(radio(LATEST_RADIO)).not.toBeChecked();
    expect(input()).toHaveValue(DEFAULT);
    expect(group()).not.toHaveTextContent('Resolves to');
    expect(group()).not.toHaveTextContent('Not resolved yet');
    expect(inGroup().queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(group()).toHaveTextContent('Source: environment');
    expect(screen.getAllByText('Default: jev-1.13.0')).toHaveLength(1);
  });

  it('shows no id box and no Check now when alias is picked over a saved release', async () => {
    const { app } = await open();

    await app.user.click(radio(LATEST_RADIO));

    expect(radio(LATEST_RADIO)).toBeChecked();
    expect(inGroup().queryByLabelText(MODEL)).toBeNull();
    expect(inGroup().queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(saveButton()).toBeEnabled();
    await app.user.click(revertButton());
    expect(radio(PINNED_RADIO)).toBeChecked();
    expect(input()).toHaveValue(DEFAULT);
  });

  it('keeps the worker problem of the key inside its group', async () => {
    await open({ problems: ['model jev-9 has no price entry'] });

    expect(group()).toHaveTextContent('Rejected by worker: model jev-9 has no price entry');
  });

  it('renders the editor in Slovak, with no English string of it', async () => {
    const checkedAt = modelAgo(15);
    await open({ language: 'sk', saved: ALIAS, status: aliasStatus(DEFAULT, checkedAt) });

    expect(radio('Sledovať najnovší Jev (jev-latest)')).toBeChecked();
    expect(radio('Použiť jedno vydanie')).not.toBeChecked();
    expect(group()).toHaveTextContent(
      `Ukazuje na ${DEFAULT} · overené ${printedTime(checkedAt, 'Europe/Bratislava', 'sk')}`,
    );
    expect(inGroup().getByRole('button', { name: 'Overiť teraz' })).toBeVisible();
    expect(group()).not.toHaveTextContent('Follow the newest');
    expect(group()).not.toHaveTextContent('Use one release');
    expect(group()).not.toHaveTextContent('Resolves to');
    expect(inGroup().queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});

describe('JEV-5 saving with a fresh probe', () => {
  it('reuses a fresh probe: no new probe, the kept dialog without a tick, a PATCH without acknowledge', async () => {
    const { app, model } = await open({ status: { probes: freshProbes('jev-1.14.0') } });

    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    const dialog = await changeDialog();
    expect(dialog).toHaveTextContent(`${MODEL} changes from jev-1.13.0 to jev-1.14.0.`);
    expect(dialog).toHaveTextContent(KEPT_TEXT);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(dialog).not.toHaveTextContent('eval replay');
    expect(app.calls(POST_PROBE)).toHaveLength(0);
    expect(app.calls(PATCH)).toHaveLength(0);
    await app.user.click(confirmIn(dialog));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: 'jev-1.14.0' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(model.probes).toEqual([]);
  });

  it('keeps the edit and sends nothing when the dialog is cancelled', async () => {
    const { app } = await open({ status: { probes: freshProbes('jev-1.14.0') } });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    await app.user.click(within(await changeDialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input()).toHaveValue('jev-1.14.0');
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(saveButton()).toBeEnabled();
  });

  it.each([
    [7, 0],
    [9, 1],
  ])('judges a probe %i minutes old on the API clock: %i new probes', async (minutes, posts) => {
    const { app, model } = await open({
      status: { probes: { 'jev-1.14.0': modelProbe('jev-1.14.0', { at: modelAgo(minutes) }) } },
      server: { probeOnRead: 1 },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    await changeDialog();
    await wait(100);
    expect(model.probes).toHaveLength(posts);
  });

  it.each([15, -15])(
    'does not ask again when the browser clock is %i minutes off the API clock',
    async (skew) => {
      vi.setSystemTime(new Date(Date.parse(MODEL_NOW) + skew * 60_000));
      const { app, model } = await open({ status: { probes: freshProbes('jev-1.14.0') } });
      await typeId(app, 'jev-1.14.0');
      await app.user.click(saveButton());

      await changeDialog();
      expect(model.probes).toEqual([]);
      expect(app.calls(POST_PROBE)).toHaveLength(0);
    },
  );
});

describe('JEV-5 saving needs a new probe', () => {
  it('asks once, polls every 1.5 s until the answer is newer, then shows the dialog and stops polling', async () => {
    const { app, model } = await open({ server: { probeOnRead: 3 } });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(100);

    expect(app.calls(POST_PROBE)).toHaveLength(1);
    const [request] = app.calls(POST_PROBE);
    expect(bodyOf(request!)).toEqual({ model: 'jev-1.14.0' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(saveButton()).toHaveAttribute('aria-busy', 'true');
    expect(inGroup().getByText('Asking Jev whether it serves jev-1.14.0…')).toBeVisible();
    expect(inGroup().queryAllByRole('status').length).toBeLessThanOrEqual(1);
    expect(screen.queryByRole('dialog')).toBeNull();

    await wait(3_000);
    expect(model.readsSincePost).toBeGreaterThanOrEqual(1);
    expect(model.readsSincePost).toBeLessThanOrEqual(2);
    expect(screen.queryByRole('dialog')).toBeNull();

    const dialog = await changeDialog();
    expect(dialog).toHaveTextContent(KEPT_TEXT);
    const settled = model.reads;
    await wait(10_000);
    expect(model.reads).toBe(settled);
    expect(app.calls(POST_PROBE)).toHaveLength(1);
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it('polls about every 1.5 s', async () => {
    const { app, model } = await open();
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    await wait(9_100);

    expect(model.readsSincePost).toBeGreaterThanOrEqual(5);
    expect(model.readsSincePost).toBeLessThanOrEqual(6);
  });

  it('waits for an answer strictly newer than the stale one it started from', async () => {
    const { app, model } = await open({
      status: {
        probes: { 'jev-1.14.0': modelProbe('jev-1.14.0', { at: modelAgo(9) }) },
      },
    });
    model.onRead = (server, read) => {
      if (read === 2) delete server.status.probes['jev-1.14.0'];
      if (read === 3) {
        // Older than the stale row it started from, yet young enough to be a usable answer: only
        // "strictly newer" keeps the editor waiting, a mere "different" would accept it.
        server.status.probes['jev-1.14.0'] = modelProbe('jev-1.14.0', { at: modelAgo(9.5) });
      }
      if (read === 4) server.landProbe('jev-1.14.0');
    };
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    await wait(4_800);
    expect(model.readsSincePost).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inGroup().queryByRole('alert')).toBeNull();

    await changeDialog();
    expect(app.calls(POST_PROBE)).toHaveLength(1);
  });

  it('refuses a failed probe with what Jev answered: no PATCH, the draft kept, a second Save asks again', async () => {
    const { app, model } = await open({
      server: {
        probeOnRead: 2,
        probeAnswer: () => ({ ok: false, answered: 'jev-fake', error: 'model_mismatch' }),
      },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(3_100);

    expect(await alertText()).toBe('Jev answered jev-fake for jev-1.14.0, so nothing was saved.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(input()).toHaveValue('jev-1.14.0');
    expect(saveButton()).toBeEnabled();
    const settled = model.reads;
    await wait(10_000);
    expect(model.reads).toBe(settled);

    await app.user.click(saveButton());
    await wait(3_100);
    expect(model.probes).toEqual(['jev-1.14.0', 'jev-1.14.0']);
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it('says why when Jev could not confirm the id', async () => {
    const { app } = await open({
      server: {
        probeOnRead: 1,
        probeAnswer: () => ({ ok: false, error: 'model_unavailable' }),
      },
    });
    await typeId(app, 'jev-9.9.9');
    await app.user.click(saveButton());
    await wait(1_700);

    expect(await alertText()).toBe(
      'Jev could not confirm jev-9.9.9 (Jev does not serve this model.), so nothing was saved.',
    );
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it.each([
    ['timeout', 'Jev did not answer in time.'],
    ['rate_limited', 'Jev is rate limiting requests.'],
    ['no_key:missing', 'No Jev key is available.'],
    ['brand_new_code', 'code brand_new_code'],
  ])('shows the probe error %s in words', async (error, words) => {
    const { app } = await open({
      server: { probeOnRead: 1, probeAnswer: () => ({ ok: false, error }) },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(1_700);

    expect(await alertText()).toBe(
      `Jev could not confirm jev-1.14.0 (${words}), so nothing was saved.`,
    );
  });

  it('gives up after 90 seconds with one request, and stops polling', async () => {
    const { app, model } = await open();
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    await wait(85_000);
    expect(inGroup().queryByRole('alert')).toBeNull();
    await wait(10_000);

    expect(await alertText()).toBe(
      'Jev has not answered after 90 seconds. Check that a worker is running, then save again.',
    );
    expect(model.probes).toEqual(['jev-1.14.0']);
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(input()).toHaveValue('jev-1.14.0');
    expect(saveButton()).toBeEnabled();
    const settled = model.reads;
    await wait(20_000);
    expect(model.reads).toBe(settled);
    expect(model.probes).toHaveLength(1);
  });

  it('treats an answer that is newer but too old to use as a timeout, never as a reason to ask again', async () => {
    const { app, model } = await open({
      status: { probes: { 'jev-1.14.0': modelProbe('jev-1.14.0', { at: modelAgo(30) }) } },
    });
    model.onRead = (server, read) => {
      if (read === 2) {
        server.status.probes['jev-1.14.0'] = modelProbe('jev-1.14.0', { at: modelAgo(12) });
      }
    };
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(95_000);

    expect(await alertText()).toBe(
      'Jev has not answered after 90 seconds. Check that a worker is running, then save again.',
    );
    expect(model.probes).toEqual(['jev-1.14.0']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls(PATCH)).toHaveLength(0);
  });
});

describe('JEV-5 what the change does', () => {
  it.each([
    [1, "1 user's personal model restarts from new ratings."],
    [5, "5 users' personal models restart from new ratings."],
    [0, 'No personal model is active yet, so none restarts.'],
  ])(
    'restart with %i active models: the acknowledgement dialog and its count line',
    async (count, line) => {
      const { app } = await open({
        status: {
          probes: freshProbes('jev-2.0.0'),
          impact: { at: T1, activeModels: count },
        },
      });
      await typeId(app, 'jev-2.0.0');
      await app.user.click(saveButton());

      const dialog = await restartDialog();
      expect(dialog).toHaveTextContent(`${MODEL} changes from jev-1.13.0 to jev-2.0.0`);
      expect(dialog).toHaveTextContent(line);
      expect(within(dialog).getByText(/eval replay/)).toBeVisible();
      expect(confirmIn(dialog)).toBeDisabled();
      await app.user.click(confirmIn(dialog));
      expect(app.calls(PATCH)).toHaveLength(0);

      await app.user.click(tickIn(dialog));
      expect(confirmIn(dialog)).toBeEnabled();
      await app.user.click(confirmIn(dialog));

      await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
      expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: 'jev-2.0.0', acknowledge: true });
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    },
  );

  it('restart from a worker that does not know the count: a line that names no number', async () => {
    const { app } = await open({ status: { probes: freshProbes('jev-2.0.0'), impact: null } });
    await typeId(app, 'jev-2.0.0');
    await app.user.click(saveButton());

    const dialog = await restartDialog();
    expect(dialog).toHaveTextContent('Personal models restart from new ratings.');
    expect(dialog).not.toHaveTextContent(/\d+ users?'/);
    expect(dialog).not.toHaveTextContent('none restarts');
  });

  it.each([
    [1, 'Osobný model 1 používateľa sa začne učiť odznova z nových hodnotení.'],
    [3, 'Osobné modely 3 používateľov sa začnú učiť odznova z nových hodnotení.'],
    [5, 'Osobné modely 5 používateľov sa začnú učiť odznova z nových hodnotení.'],
  ])('restart with %i active models, in Slovak', async (count, line) => {
    const { app } = await open({
      language: 'sk',
      status: { probes: freshProbes('jev-2.0.0'), impact: { at: T1, activeModels: count } },
    });
    await typeId(app, 'jev-2.0.0');
    await app.user.click(saveButton());

    const dialog = await screen.findByRole('dialog', { name: 'Táto zmena znovu obohatí korpus' });
    expect(dialog).toHaveTextContent(line);
    expect(
      within(dialog).getByRole('checkbox', { name: 'Spustil som eval replay a prešiel' }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Potvrdiť a uložiť' })).toBeDisabled();
  });

  it('shows the kept dialog in Slovak', async () => {
    const { app } = await open({ language: 'sk', status: { probes: freshProbes('jev-1.14.0') } });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());

    const dialog = await screen.findByRole('dialog', { name: 'Zmeniť vydanie Jevu?' });
    expect(dialog).toHaveTextContent(
      'Hodnotenia a osobné modely zostanú zachované; 14-dňové okno sa analyzuje znova.',
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('changes nothing for the release already in use: a dialog without a tick, a PATCH without acknowledge', async () => {
    const { app } = await open({
      saved: ALIAS,
      status: { ...aliasStatus(DEFAULT), probes: freshProbes(DEFAULT) },
    });
    await app.user.click(radio(PINNED_RADIO));
    await typeId(app, DEFAULT);
    await app.user.click(saveButton());

    const dialog = await changeDialog();
    expect(dialog).toHaveTextContent(/engine\.typesafe_model changes from .+ to jev-1\.13\.0\./);
    expect(dialog).toHaveTextContent('jev-1.13.0 is the release in use, so nothing is rebuilt.');
    expect(dialog).not.toHaveTextContent(KEPT_TEXT);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(app.calls(POST_PROBE)).toHaveLength(0);
    await app.user.click(confirmIn(dialog));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: DEFAULT });
  });

  it.each([
    ['jev-1.14.0', 'kept', false],
    ['jev-2.0.0', 'restart', true],
  ])('following the alias, when Jev answers %s: %s', async (answered, kind, acknowledge) => {
    const { app } = await open({
      status: { probes: { [ALIAS]: modelProbe(ALIAS, { answered }) } },
    });
    await app.user.click(radio(LATEST_RADIO));
    await app.user.click(saveButton());

    const dialog = await (kind === 'kept' ? changeDialog() : restartDialog());
    if (acknowledge) await app.user.click(tickIn(dialog));
    else expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await app.user.click(confirmIn(dialog));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({
      [MODEL]: ALIAS,
      ...(acknowledge ? { acknowledge: true } : {}),
    });
    expect(app.calls(POST_PROBE)).toHaveLength(0);
  });

  it('probes the alias itself when it is picked, not a release id', async () => {
    const { app, model } = await open({ server: { probeOnRead: 1 } });
    await app.user.click(radio(LATEST_RADIO));
    await app.user.click(saveButton());
    await wait(1_700);

    expect(model.probes).toEqual([ALIAS]);
    expect(bodyOf(app.calls(POST_PROBE)[0]!)).toEqual({ model: ALIAS });
    await changeDialog();
  });
});

describe('JEV-5 what the server says', () => {
  it('switches the same dialog to the acknowledgement when the server wants one after a predicted kept', async () => {
    const { app } = await open({
      status: { probes: freshProbes('jev-1.14.0') },
      ownPatch: true,
      routes: {
        [PATCH]: (request) => {
          const body = bodyOf(request) as Record<string, unknown>;
          return body['acknowledge'] === true
            ? patchAnswer(body)
            : failure(409, 'CONFLICT', {
                reason: 'confirmation_required',
                effects: ['reenrich', 'rematch'],
              });
        },
      },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await app.user.click(confirmIn(await changeDialog()));

    const dialog = await restartDialog();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(app.calls(PATCH)).toHaveLength(1);
    expect(confirmIn(dialog)).toBeDisabled();
    await app.user.click(tickIn(dialog));
    await app.user.click(confirmIn(dialog));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(2));
    expect(bodyOf(app.calls(PATCH)[1]!)).toEqual({ [MODEL]: 'jev-1.14.0', acknowledge: true });
    expect(app.calls(POST_PROBE)).toHaveLength(0);
  });

  it('says the check is too old on 409 model_probe_required, and asks again only when Save is pressed again', async () => {
    const { app, model } = await open({
      status: { probes: freshProbes('jev-1.14.0') },
      server: { probeOnRead: 1 },
      ownPatch: true,
      routes: {
        [PATCH]: () =>
          failure(409, 'CONFLICT', { reason: 'model_probe_required', model: 'jev-1.14.0' }),
      },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await app.user.click(confirmIn(await changeDialog()));

    expect(await alertText()).toBe(
      'The check of jev-1.14.0 is more than 10 minutes old. Save again to check it once more.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input()).toHaveValue('jev-1.14.0');
    await wait(10_000);
    expect(app.calls(PATCH)).toHaveLength(1);
    expect(model.probes).toEqual([]);

    model.status.probes = {
      'jev-1.14.0': modelProbe('jev-1.14.0', { at: modelAgo(30) }),
    };
    await app.user.click(saveButton());
    await wait(1_700);
    expect(model.probes).toEqual(['jev-1.14.0']);
  });

  it('says what Jev answered on 409 model_probe_failed', async () => {
    const { app } = await open({
      status: { probes: freshProbes('jev-1.14.0') },
      ownPatch: true,
      routes: {
        [PATCH]: () =>
          failure(409, 'CONFLICT', {
            reason: 'model_probe_failed',
            model: 'jev-1.14.0',
            answered: 'jev-fake',
            error: 'model_mismatch',
            at: MODEL_NOW,
          }),
      },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await app.user.click(confirmIn(await changeDialog()));

    expect(await alertText()).toBe('Jev answered jev-fake for jev-1.14.0, so nothing was saved.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input()).toHaveValue('jev-1.14.0');
  });

  it('reloads the settings on 409 settings_changed and keeps the draft', async () => {
    const { app } = await open({
      status: { probes: freshProbes('jev-1.14.0') },
      ownPatch: true,
      routes: { [PATCH]: () => failure(409, 'CONFLICT', { reason: 'settings_changed' }) },
    });
    expect(app.calls('GET /admin/settings')).toHaveLength(1);
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await app.user.click(confirmIn(await changeDialog()));

    expect(await alertText()).toBe(
      'Settings changed while saving. The latest values were loaded; review your edit and save again.',
    );
    expect(app.calls('GET /admin/settings')).toHaveLength(2);
    expect(input()).toHaveValue('jev-1.14.0');
  });
});

describe('JEV-5 reset', () => {
  it('probes the default, not the stored value, and asks for the tick when the default is another family', async () => {
    const { app, model } = await open({ saved: 'jev-2.0.0', server: { probeOnRead: 1 } });

    await app.user.click(resetButton());
    await wait(1_700);

    expect(model.probes).toEqual([DEFAULT]);
    const dialog = await restartDialog();
    expect(dialog).toHaveTextContent(`${MODEL} changes from jev-2.0.0 to jev-1.13.0`);
    await app.user.click(tickIn(dialog));
    await app.user.click(confirmIn(dialog));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: null, acknowledge: true });
  });

  it('needs no tick when the default is another release of the same family', async () => {
    const { app } = await open({ saved: 'jev-1.14.0', status: { probes: freshProbes(DEFAULT) } });

    await app.user.click(resetButton());

    const dialog = await changeDialog();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await app.user.click(confirmIn(dialog));
    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: null });
  });

  it('sends a reset of a stored row that equals the default at once: no probe, no dialog', async () => {
    const { app, model } = await open({ saved: DEFAULT });

    await app.user.click(resetButton());

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(model.probes).toEqual([]);
    expect(app.calls(POST_PROBE)).toHaveLength(0);
  });
});

describe('JEV-5 Check now', () => {
  const checked = (model: string, at: string) =>
    `Resolves to ${model} · checked ${printedTime(at)}`;

  it('asks once, polls until the check has ended, and shows the new answer', async () => {
    const { app, model } = await open({
      saved: ALIAS,
      status: aliasStatus(DEFAULT, modelAgo(60)),
      server: { checkOnRead: 2, checkResult: { ok: true, model: 'jev-1.14.0' } },
    });

    await app.user.click(inGroup().getByRole('button', { name: 'Check now' }));
    await wait(100);

    expect(app.calls(POST_CHECK)).toHaveLength(1);
    const [request] = app.calls(POST_CHECK);
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(inGroup().getByRole('button', { name: 'Check now' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(inGroup().queryAllByRole('status').length).toBeLessThanOrEqual(1);
    await wait(3_200);

    await vi.waitFor(() => expect(group()).toHaveTextContent(checked('jev-1.14.0', MODEL_NOW)));
    expect(inGroup().getByRole('button', { name: 'Check now' })).not.toHaveAttribute('aria-busy');
    expect(inGroup().queryByRole('alert')).toBeNull();
    const settled = model.reads;
    await wait(20_000);
    expect(model.reads).toBe(settled);
    expect(model.checks).toBe(1);
  });

  it('says so when the check failed, and that the release stays', async () => {
    const { app } = await open({
      saved: ALIAS,
      status: aliasStatus(DEFAULT, modelAgo(60)),
      server: { checkOnRead: 1, checkResult: { ok: false, error: 'timeout' } },
    });
    await app.user.click(inGroup().getByRole('button', { name: 'Check now' }));
    await wait(1_800);

    await vi.waitFor(() =>
      expect(group()).toHaveTextContent(
        `The check at ${printedTime(MODEL_NOW)} failed (Jev did not answer in time.). The release stays ${DEFAULT}.`,
      ),
    );
    expect(group()).toHaveTextContent(DEFAULT);
  });

  it('gives up after 90 seconds, with one request', async () => {
    const { app, model } = await open({
      saved: ALIAS,
      status: aliasStatus(DEFAULT, modelAgo(60)),
    });
    await app.user.click(inGroup().getByRole('button', { name: 'Check now' }));

    await wait(85_000);
    expect(group()).not.toHaveTextContent('Jev has not answered yet');
    await wait(10_000);

    expect(group()).toHaveTextContent(
      'Jev has not answered yet. Check that a worker is running, then try again.',
    );
    expect(model.checks).toBe(1);
    expect(inGroup().getByRole('button', { name: 'Check now' })).toBeEnabled();
    const settled = model.reads;
    await wait(20_000);
    expect(model.reads).toBe(settled);
  });

  it.each([
    ['newer than the last answer', modelAgo(120), modelAgo(60), true],
    ['older than the last answer', modelAgo(30), modelAgo(60), false],
  ])('a failed check %s', async (_name, checkedAt, failedAt, shown) => {
    await open({
      saved: ALIAS,
      status: {
        ...aliasStatus(DEFAULT, checkedAt),
        watch: { lastCheck: { at: failedAt, ok: false, error: 'timeout' } },
      },
    });

    expect(radio(LATEST_RADIO)).toBeChecked();
    if (shown)
      expect(group()).toHaveTextContent(/The check at .+ failed \(Jev did not answer in time\.\)/);
    else expect(group()).not.toHaveTextContent('failed');
  });
});

describe('JEV-5 while waiting', () => {
  it('Revert cancels the wait: no more requests, no dialog, no PATCH, even if the answer arrives later', async () => {
    const { app, model } = await open();
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(3_100);
    expect(revertButton()).toBeEnabled();

    await app.user.click(revertButton());
    await wait(100);

    expect(input()).toHaveValue(DEFAULT);
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).not.toHaveAttribute('aria-busy');
    const settled = model.reads;
    model.landProbe('jev-1.14.0');
    await wait(20_000);
    expect(model.reads).toBe(settled);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inGroup().queryByRole('alert')).toBeNull();
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(model.probes).toHaveLength(1);
  });

  it('stops asking and says nothing when the sign-in ends during the wait', async () => {
    const { app, model, server } = await open();
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(3_100);

    server.me = null;
    await act(() => app.session.resetAccountState());
    const reads = app.calls(GET_MODEL).length;
    const posts = app.calls(POST_PROBE).length;
    await wait(20_000);

    expect(app.calls(GET_MODEL)).toHaveLength(reads);
    expect(app.calls(POST_PROBE)).toHaveLength(posts);
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(model.probes).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops asking when the editor is left', async () => {
    const { app, model } = await open();
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await wait(3_100);

    await act(() => app.router.navigate({ to: '/admin/usage' }));
    await screen.findByRole('heading', { level: 2, name: 'Usage' });
    const reads = app.calls(GET_MODEL).length;
    await wait(20_000);

    expect(app.calls(GET_MODEL)).toHaveLength(reads);
    expect(app.calls(PATCH)).toHaveLength(0);
    expect(model.probes).toHaveLength(1);
  });

  it('confirms nothing when the save is answered after the sign-in has ended', async () => {
    const answer = gate();
    const { app, server } = await open({
      status: { probes: freshProbes('jev-1.14.0') },
      ownPatch: true,
      routes: {
        [PATCH]: async (request) => {
          await answer.opened;
          return patchAnswer(bodyOf(request) as never);
        },
      },
    });
    await typeId(app, 'jev-1.14.0');
    await app.user.click(saveButton());
    await app.user.click(confirmIn(await changeDialog()));
    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));

    server.me = null;
    await act(() => app.session.resetAccountState());
    answer.release();
    await wait(500);

    expect(screen.queryByText(`Saved ${MODEL}.`)).toBeNull();
  });
});

/** The strings the editor needs in both languages (admin namespace), as m8b-t10-status lists them. */
const REQUIRED = [
  'settings.modelEditor.modeLabel',
  'settings.modelEditor.latest',
  'settings.modelEditor.latestHint',
  'settings.modelEditor.pinned',
  'settings.modelEditor.pinnedHint',
  'settings.modelEditor.idRejected',
  'settings.modelEditor.resolves',
  'settings.modelEditor.unresolved',
  'settings.modelEditor.checkNow',
  'settings.modelEditor.checking',
  'settings.modelEditor.checkTimeout',
  'settings.modelEditor.checkFailed',
  'settings.modelEditor.probing',
  'settings.modelEditor.probeAnswered',
  'settings.modelEditor.probeRefused',
  'settings.modelEditor.probeTimeout',
  'settings.modelEditor.probeExpired',
  'settings.modelEditor.impact.title',
  'settings.modelEditor.impact.change',
  'settings.modelEditor.impact.none',
  'settings.modelEditor.impact.kept',
  'settings.modelEditor.impact.restart',
  'settings.modelEditor.impact.restartNone',
  'settings.modelEditor.impact.restartUnknown',
  ...[
    'model_unavailable',
    'model_mismatch',
    'alias_unresolved',
    'timeout',
    'provider_unavailable',
    'rate_limited',
    'auth_rejected',
    'request_rejected',
    'invalid_response',
    'probe_budget_exceeded',
    'budget_unavailable',
    'cost_overrun',
    'internal_error',
    'unsupported_model',
    'no_key',
    'unknown',
  ].map((code) => `settings.modelEditor.errors.${code}`),
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

describe('JEV-5 strings', () => {
  it.each(REQUIRED)('has %s in en and sk, translated', (path) => {
    const en = lookup(RESOURCES.en['admin'] ?? {}, path);
    const sk = lookup(RESOURCES.sk['admin'] ?? {}, path);
    // The count line lives under `_one`/`_other` (sk also `_few`/`_many`); accept a key or its forms.
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

  it('has the count line in every plural form of both languages and no zero form', () => {
    const forms = (lang: 'en' | 'sk') =>
      Object.keys(
        (lookup(RESOURCES[lang]['admin'] ?? {}, 'settings.modelEditor.impact') as object) ?? {},
      )
        .filter((key) => key.startsWith('restart_'))
        .sort();
    expect(forms('en')).toEqual(['restart_one', 'restart_other']);
    expect(forms('sk')).toEqual(['restart_few', 'restart_many', 'restart_one', 'restart_other']);
  });
});

it('hides a dormant resolution after returning from a concrete pin to the alias', async () => {
  await open({
    saved: ALIAS,
    savedAt: T1,
    status: {
      ...aliasStatus('jev-1.12.0', modelAgo(60 * 24 * 14)),
      pin: { model: DEFAULT, since: T1 },
    },
  });
  expect(group()).not.toHaveTextContent('Resolves to jev-1.12.0');
  expect(group()).toHaveTextContent('Not resolved yet.');
});

it('uses the active pin rather than a dormant resolution when choosing one release', async () => {
  const { app } = await open({
    saved: ALIAS,
    savedAt: T1,
    status: {
      ...aliasStatus('jev-1.12.0', modelAgo(60 * 24 * 14)),
      pin: { model: DEFAULT, since: T1 },
    },
  });
  await app.user.click(radio(PINNED_RADIO));
  expect(input()).toHaveValue(DEFAULT);
});

it.each([0, 1])('shows an alias resolution checked %i ms after a recent save', async (gap) => {
  const savedAt = modelAgo(1);
  const checkedAt = new Date(Date.parse(savedAt) + gap).toISOString();
  await open({ saved: ALIAS, savedAt, status: aliasStatus('jev-1.14.0', checkedAt) });
  expect(group()).toHaveTextContent(`Resolves to jev-1.14.0 · checked ${printedTime(checkedAt)}`);
  expect(group()).not.toHaveTextContent('Not resolved yet.');
});
