import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, renderApp, type ApiRouteHandler } from '../support/app.js';
import { adminMe, adminRoutes, makeUser, page, unhandledGuard } from './support.js';

/**
 * D-255 (docs/design/plan-velocity.md §6): Admin → Plans, and the plan choices of Admin → Users
 * coming from `GET /admin/plans`. The plan DTO is written inline (the shared type is added by the
 * build); its fields are pinned by apps/api/test/admin-plans.int.test.ts.
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

function makePlan(over: Record<string, unknown> = {}) {
  return {
    key: 'beta',
    label: 'Beta',
    labelSk: 'Beta',
    maxFeeds: 200,
    maxCards: 150,
    maxLabels: 20,
    maxForks: 20,
    maxRules: 200,
    opmlMaxFeeds: 300,
    minFetchIntervalS: 900,
    releaseIntervalS: null,
    backfillDays: 7,
    invitesOnSignup: 3,
    sortOrder: 10,
    isDefault: true,
    retiredAt: null,
    version: 1,
    userCount: 12,
    ...over,
  };
}

const beta = makePlan();
const pro = makePlan({
  key: 'pro',
  label: 'Pro',
  labelSk: 'Pro SK',
  maxFeeds: 1000,
  minFetchIntervalS: 600,
  sortOrder: 20,
  isDefault: false,
  userCount: 3,
});
const old = makePlan({
  key: 'old',
  label: 'Old',
  sortOrder: 30,
  isDefault: false,
  retiredAt: '2026-10-01T09:00:00.000Z',
  userCount: 1,
});

async function open(path: string, routes: Record<string, ApiRouteHandler> = {}) {
  return guard(
    await renderApp({
      path,
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/plans': () => json(200, { items: [beta, pro, old] }),
          ...routes,
        }),
      },
    }),
  );
}

describe('Admin navigation', () => {
  it('offers a Plans screen next to Users', async () => {
    const app = await open('/admin/users');
    const nav = await screen.findByRole('navigation', { name: 'Administration sections' });
    const link = within(nav).getByRole('link', { name: 'Plans' });
    await app.user.click(link);
    expect(app.router.state.location.pathname).toBe('/admin/plans');
    expect(await screen.findByRole('table', { name: 'Plans' })).toBeVisible();
  });
});

describe('Admin → Plans', () => {
  it('lists the plans with user counts, the default and the retired state', async () => {
    await open('/admin/plans');
    const table = await screen.findByRole('table', { name: 'Plans' });
    const row = (name: RegExp) => within(within(table).getByRole('row', { name }));
    expect(row(/beta/i).getByText('12')).toBeVisible();
    expect(row(/beta/i).getByText('Default')).toBeVisible();
    expect(row(/pro/i).getByText('3')).toBeVisible();
    expect(row(/old/i).getByText('Retired')).toBeVisible();
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(names[0]).toMatch(/beta/i);
    expect(names[1]).toMatch(/pro/i);
    expect(names[2]).toMatch(/old/i);
  });

  it('says that intervals under 300 seconds wait for the scheduler change', async () => {
    await open('/admin/plans');
    await screen.findByRole('table', { name: 'Plans' });
    expect(
      screen.getByText(/under 300 seconds.*scheduler|scheduler.*under 300 seconds/i),
    ).toBeVisible();
  });

  it('links to the global analysis cap in Settings', async () => {
    await open('/admin/plans');
    await screen.findByRole('table', { name: 'Plans' });
    const link = screen.getByRole('link', { name: /engine\.auto_analysis_daily_cap/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('/admin/settings'));
  });

  it('edits the names and limits in a dialog, sending expectedVersion and only the changes', async () => {
    const app = await open('/admin/plans', {
      'PATCH /admin/plans/:key': () =>
        json(200, { plan: { ...pro, maxFeeds: 1500, label: 'Pro+', version: 2 } }),
    });
    await screen.findByRole('table', { name: 'Plans' });

    await app.user.click(screen.getByRole('button', { name: 'Edit pro' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit pro' });
    expect(within(dialog).getByLabelText('Name (English)')).toHaveValue('Pro');
    expect(within(dialog).getByLabelText('Name (Slovak)')).toHaveValue('Pro SK');
    expect(within(dialog).getByLabelText('Feeds')).toHaveValue(1000);
    expect(within(dialog).getByLabelText('Fetch interval (seconds)')).toHaveValue(600);
    expect(within(dialog).getByRole('button', { name: 'Save plan' })).toBeDisabled();

    await app.user.clear(within(dialog).getByLabelText('Name (English)'));
    await app.user.type(within(dialog).getByLabelText('Name (English)'), 'Pro+');
    await app.user.clear(within(dialog).getByLabelText('Feeds'));
    await app.user.type(within(dialog).getByLabelText('Feeds'), '1500');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await vi.waitFor(() => expect(app.calls('PATCH /admin/plans/:key')).toHaveLength(1));
    const [request] = app.calls('PATCH /admin/plans/:key');
    expect(request!.pathname).toBe('/api/v1/admin/plans/pro');
    expect(bodyOf(request!)).toEqual({ expectedVersion: 1, label: 'Pro+', maxFeeds: 1500 });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls('GET /admin/plans').length).toBeGreaterThanOrEqual(2);
  });

  it('checks the fetch interval (60 to 86400 seconds) before sending', async () => {
    const app = await open('/admin/plans');
    await screen.findByRole('table', { name: 'Plans' });
    await app.user.click(screen.getByRole('button', { name: 'Edit pro' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Fetch interval (seconds)');
    await app.user.clear(field);
    await app.user.type(field, '30');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    expect(field).toBeInvalid();
    expect(app.calls('PATCH /admin/plans/:key')).toHaveLength(0);
  });

  it('shows the conflict message and reloads the plans when the version is stale', async () => {
    const app = await open('/admin/plans', {
      'PATCH /admin/plans/:key': () => failure(409, 'STALE_STATE'),
    });
    await screen.findByRole('table', { name: 'Plans' });
    await app.user.click(screen.getByRole('button', { name: 'Edit pro' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.clear(within(dialog).getByLabelText('Feeds'));
    await app.user.type(within(dialog).getByLabelText('Feeds'), '5');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /changed by someone else|changed elsewhere/i,
    );
    await vi.waitFor(() => expect(app.calls('GET /admin/plans').length).toBeGreaterThanOrEqual(2));
  });

  it('retires a plan with the current version', async () => {
    const app = await open('/admin/plans', {
      'PATCH /admin/plans/:key': () =>
        json(200, { plan: { ...pro, retiredAt: '2026-10-16T09:00:00.000Z', version: 2 } }),
    });
    await screen.findByRole('table', { name: 'Plans' });
    await app.user.click(screen.getByRole('button', { name: 'Retire pro' }));
    await vi.waitFor(() => expect(app.calls('PATCH /admin/plans/:key')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /admin/plans/:key')[0]!)).toEqual({
      expectedVersion: 1,
      retired: true,
    });
  });

  it('makes a plan the default, and cannot make a retired plan the default', async () => {
    const app = await open('/admin/plans', {
      'POST /admin/plans/:key/default': () => json(200, { plan: { ...pro, isDefault: true } }),
    });
    await screen.findByRole('table', { name: 'Plans' });
    expect(screen.getByRole('button', { name: 'Make old the default' })).toBeDisabled();
    await app.user.click(screen.getByRole('button', { name: 'Make pro the default' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/plans/:key/default')).toHaveLength(1));
    expect(app.calls('POST /admin/plans/:key/default')[0]!.pathname).toBe(
      '/api/v1/admin/plans/pro/default',
    );
  });

  it('adds a plan with a new key', async () => {
    const app = await open('/admin/plans', {
      'POST /admin/plans': () => json(201, { plan: makePlan({ key: 'team', label: 'Team' }) }),
    });
    await screen.findByRole('table', { name: 'Plans' });
    await app.user.click(screen.getByRole('button', { name: 'Add plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add plan' });
    await app.user.type(within(dialog).getByLabelText('Key'), 'team');
    await app.user.type(within(dialog).getByLabelText('Name (English)'), 'Team');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await vi.waitFor(() => expect(app.calls('POST /admin/plans')).toHaveLength(1));
    expect(bodyOf(app.calls('POST /admin/plans')[0]!)).toMatchObject({
      key: 'team',
      label: 'Team',
    });
  });

  it('shows nothing of it to a user who is not an administrator', async () => {
    const app = await guard(
      await renderApp({
        path: '/admin/plans',
        server: { me: { ...adminMe(), role: 'user' }, routes: {} },
      }),
    );
    expect(app.calls('GET /admin/plans')).toHaveLength(0);
    expect(screen.queryByRole('table', { name: 'Plans' })).toBeNull();
  });
});

describe('Admin → Users plan select', () => {
  const optionValues = (select: HTMLElement) =>
    Array.from((select as HTMLSelectElement).options).map((o) => o.value);

  it('lists the active plans from GET /admin/plans, not a constant', async () => {
    const app = await open('/admin/users', {
      'GET /admin/plans': () =>
        json(200, {
          items: [beta, makePlan({ key: 'zeta', label: 'Zeta', isDefault: false }), old],
        }),
    });
    await screen.findByRole('table', { name: 'Users' });
    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    const values = optionValues(within(dialog).getByLabelText('Plan'));
    expect(values).toEqual(['beta', 'zeta']);
    expect(values).not.toContain('admin');
    expect(values).not.toContain('old');
  });

  it('keeps the retired current plan of the user selectable', async () => {
    const app = await open('/admin/users', {
      'GET /admin/users': () => json(200, page([makeUser({ plan: 'old' })])),
    });
    await screen.findByRole('table', { name: 'Users' });
    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Plan');
    expect(optionValues(select)).toEqual(['beta', 'pro', 'old']);
    expect(select).toHaveValue('old');
  });

  it('sends the chosen stored plan', async () => {
    const app = await open('/admin/users', {
      'PATCH /admin/users/:id': () =>
        json(200, { user: { ...makeUser(), plan: 'pro' }, sessionsRevoked: 0 }),
    });
    await screen.findByRole('table', { name: 'Users' });
    await app.user.click(screen.getByRole('button', { name: 'Edit reader@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await app.user.selectOptions(within(dialog).getByLabelText('Plan'), 'pro');
    await app.user.click(within(dialog).getByRole('button', { name: 'Save user' }));
    await vi.waitFor(() => expect(app.calls('PATCH /admin/users/:id')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /admin/users/:id')[0]!)).toEqual({ plan: 'pro' });
  });
});
