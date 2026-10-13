import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESOURCES } from '../../src/i18n/resources.js';
import { failure, json } from '../api/fake-fetch.js';
import { READER_READS } from '../auth/harness.js';
import { adminMe, adminRoutes } from '../admin/support.js';
import { bodyOf, renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';

/**
 * M8b-T11 ruler: the one-step first-run screen at /setup (token + email -> admin session).
 *
 * Rules the builder must meet (chosen here, see harness notes):
 *  - /setup asks `GET /setup` ({open}); closed redirects to /login (replace), open shows ONE form.
 *  - Form: h1 "First-run setup"; fields labelled "Setup token" and "Email"; button "Create admin account".
 *  - Submit: `POST /setup/complete` {token (trimmed), email}, header X-Bantoozi-Client: web,
 *    NO Idempotency-Key; on 200 the app lands on /admin with the returned user as the session.
 *  - 400 INVALID_CODE (and any other failure of the call) -> one generic role=alert, email kept.
 *  - 429 -> role=alert "Too many attempts. Try again in N minute(s)." from Retry-After, form kept.
 *  - /login shows a link "First-run setup" -> /setup only while GET /setup says open.
 *  - Strings live in the `setup` (and `auth` for the login link) namespaces in en and sk.
 */

const EMAIL = 'owner@example.com';
const TOKEN = 'tok_AbC123-xyz_0123456789abcdefghijklmnopqrstuvwxy';
const COMPLETE = 'POST /setup/complete';
const STATE = 'GET /setup';
const admin = adminMe();

const opened: Awaited<ReturnType<typeof renderApp>>[] = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  const apps = opened.splice(0);
  for (const app of apps) app.session.dispose();
  vi.restoreAllMocks();
  for (const app of apps) expect(app.unhandled).toEqual([]);
});

function setupServer(state: boolean, routes: Record<string, ApiRouteHandler> = {}): FakeServer {
  const server: FakeServer = {
    me: null,
    routes: {
      ...READER_READS,
      ...adminRoutes(),
      [STATE]: () => json(200, { open: state }),
      [COMPLETE]: () => {
        server.me = admin;
        return json(200, { user: admin });
      },
      ...routes,
    },
  };
  return server;
}

async function open(path: string, server: FakeServer, language?: 'en' | 'sk') {
  const app = await renderApp({ path, server, ...(language ? { language } : {}) });
  opened.push(app);
  return app;
}

type App = Awaited<ReturnType<typeof open>>;
const pathname = (app: App) => app.router.state.location.pathname;

async function fill(app: App, token = TOKEN, email = EMAIL) {
  await app.user.type(await screen.findByLabelText('Setup token'), token);
  await app.user.type(screen.getByLabelText('Email'), email);
  await app.user.click(screen.getByRole('button', { name: 'Create admin account' }));
}

describe('/setup when setup is open', () => {
  it('shows one form: a setup token, an email and one button', async () => {
    const app = await open('/setup', setupServer(true));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'First-run setup' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Setup token')).toBeRequired();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toBeRequired();
    expect(screen.getByRole('button', { name: 'Create admin account' })).toBeEnabled();
    // One step: no code field, no second form.
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(pathname(app)).toBe('/setup');
    expect(app.calls(COMPLETE)).toHaveLength(0);
  });

  it('sends the token and the email with the CSRF header, no Idempotency-Key, and lands in /admin', async () => {
    const app = await open('/setup', setupServer(true));

    await fill(app, `  ${TOKEN} `);

    await waitFor(() => expect(pathname(app)).toBe('/admin'));
    const sent = app.calls(COMPLETE);
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0]!)).toEqual({ token: TOKEN, email: EMAIL });
    expect(sent[0]!.headers.get('X-Bantoozi-Client')).toBe('web');
    expect(sent[0]!.headers.has('Idempotency-Key')).toBe(false);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Administration' }),
    ).toBeInTheDocument();
    // The returned user is the session: no further sign-in step.
    expect(app.calls('POST /auth/request-code')).toHaveLength(0);
    expect(app.calls('POST /auth/verify')).toHaveLength(0);
  });

  it.each([
    ['no token', '', EMAIL],
    ['no email', TOKEN, ''],
    ['an address without an @', TOKEN, 'owner.example.com'],
  ])('sends nothing for %s', async (_name, token, email) => {
    const app = await open('/setup', setupServer(true));
    if (token !== '') await app.user.type(await screen.findByLabelText('Setup token'), token);
    else await screen.findByLabelText('Setup token');
    if (email !== '') await app.user.type(screen.getByLabelText('Email'), email);
    await app.user.click(screen.getByRole('button', { name: 'Create admin account' }));

    expect(app.calls(COMPLETE)).toHaveLength(0);
    expect(pathname(app)).toBe('/setup');
  });

  it('answers a refused token with one generic error and keeps the email', async () => {
    const app = await open(
      '/setup',
      setupServer(true, { [COMPLETE]: () => failure(400, 'INVALID_CODE') }),
    );

    await fill(app);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That setup token didn't work.");
    expect(alert).not.toHaveTextContent(EMAIL);
    expect(alert).not.toHaveTextContent(TOKEN);
    expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
    expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
    expect(pathname(app)).toBe('/setup');
    expect(app.calls(COMPLETE)).toHaveLength(1);
  });

  it('can be retried after a refusal', async () => {
    let first = true;
    const app = await open(
      '/setup',
      setupServer(true, {
        [COMPLETE]: () => {
          if (first) {
            first = false;
            return failure(400, 'INVALID_CODE');
          }
          return json(200, { user: admin });
        },
      }),
    );
    await fill(app);
    await screen.findByRole('alert');

    await app.user.click(screen.getByRole('button', { name: 'Create admin account' }));

    await waitFor(() => expect(pathname(app)).toBe('/admin'));
    expect(app.calls(COMPLETE)).toHaveLength(2);
  });

  it.each([
    ['125', 'Too many attempts. Try again in 3 minutes.'],
    ['60', 'Too many attempts. Try again in 1 minute.'],
  ])('says to try later on 429 with Retry-After %s', async (retryAfter, message) => {
    const app = await open(
      '/setup',
      setupServer(true, {
        [COMPLETE]: () => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': retryAfter }),
      }),
    );

    await fill(app);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
    expect(pathname(app)).toBe('/setup');
  });
});

describe('negative control (passes before and after the feature)', () => {
  it('the fake server serves /login and the admin overview, so a failure above is the feature', async () => {
    const login = await open('/login', setupServer(false));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(pathname(login)).toBe('/login');
    cleanup();
    const signedIn = await open('/admin', { ...setupServer(false), me: admin });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Administration' }),
    ).toBeInTheDocument();
    expect(pathname(signedIn)).toBe('/admin');
  });
});

describe('/setup when setup is closed', () => {
  it('redirects to /login without showing the form', async () => {
    const app = await open('/setup', setupServer(false));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(pathname(app)).toBe('/login');
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
    expect(app.calls(COMPLETE)).toHaveLength(0);
  });
});

describe('the first-run link on /login', () => {
  it('is there while setup is open and leads to /setup', async () => {
    const app = await open('/login', setupServer(true));

    const link = await screen.findByRole('link', { name: 'First-run setup' });
    expect(link).toHaveAttribute('href', '/setup');
    await app.user.click(link);
    await waitFor(() => expect(pathname(app)).toBe('/setup'));
  });

  it('is absent once setup is closed', async () => {
    const app = await open('/login', setupServer(false));

    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await waitFor(() => expect(app.calls(STATE).length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: 'First-run setup' })).not.toBeInTheDocument();
  });

  it('is absent, and the page still works, when the state cannot be read', async () => {
    const app = await open(
      '/login',
      setupServer(true, { [STATE]: () => failure(500, 'INTERNAL') }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await waitFor(() => expect(app.calls(STATE).length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: 'First-run setup' })).not.toBeInTheDocument();
  });
});

describe('Slovak', () => {
  it('shows the setup screen in Slovak with no raw keys', async () => {
    await open('/setup', setupServer(true), 'sk');

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).not.toBe('First-run setup');
    expect(document.body.textContent).not.toMatch(/\b(title|lead|submit|token)\b\./);
    expect(document.body.textContent).not.toMatch(/setup:|auth:/);
  });
});

describe('i18n resources', () => {
  const flatten = (value: unknown, prefix = ''): Record<string, string> =>
    typeof value === 'string'
      ? { [prefix]: value }
      : Object.entries((value ?? {}) as Record<string, unknown>).reduce(
          (all, [key, inner]) => ({
            ...all,
            ...flatten(inner, prefix === '' ? key : `${prefix}.${key}`),
          }),
          {} as Record<string, string>,
        );

  const STRINGS = [
    'title',
    'lead',
    'token',
    'email',
    'submit',
    'invalid',
    'rateLimited_one',
    'rateLimited_other',
  ];

  it.each(STRINGS)('setup.%s is a non-empty string in en and sk', (key) => {
    const en = flatten(RESOURCES.en['setup']);
    const sk = flatten(RESOURCES.sk['setup']);
    expect(en[key], `en ${key}`).toBeTruthy();
    expect(sk[key], `sk ${key}`).toBeTruthy();
  });

  it('the login link has an en and an sk string (auth login.setup)', () => {
    expect(flatten(RESOURCES.en['auth'])['login.setup']).toBe('First-run setup');
    expect(flatten(RESOURCES.sk['auth'])['login.setup']).toBeTruthy();
  });

  it('sk defines every key en defines, in setup and auth', () => {
    for (const ns of ['setup', 'auth']) {
      const en = Object.keys(flatten(RESOURCES.en[ns]));
      const sk = Object.keys(flatten(RESOURCES.sk[ns]));
      expect(
        en.filter((key) => !sk.includes(key)),
        ns,
      ).toEqual([]);
    }
  });
});
