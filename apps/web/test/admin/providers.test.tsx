import type { CredentialStatus } from '@bantoozi/shared';
import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { gate } from '../interests/support.js';
import { bodyOf, renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';
import { T1, adminMe, adminRoutes, makeCredential, unhandledGuard } from './support.js';

const SECRET = 'sk-test-SECRET-9f3a7c41';
const JEV = 'Jev (typesafe)';
const KEY_LABEL = `New API key for ${JEV}`;
const STAGED_MESSAGE = 'Key staged. Validate it next.';
const CHANGED_MESSAGE =
  'This credential changed in the meantime. The latest state is shown; check it and try again.';

const guard = unhandledGuard();

async function render(options: Parameters<typeof renderApp>[0]) {
  return guard(await renderApp(options));
}

/** An hour after the fixtures' validation time: a validation counts for 24 hours. */
const NOW = Date.parse(T1) + 3_600_000;
const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

const jevCredential = (over: Partial<CredentialStatus> = {}) =>
  makeCredential('typesafe', {
    source: 'db',
    enabled: true,
    revision: '5',
    activeVersion: '3',
    candidateVersion: '4',
    candidateStatus: 'pending',
    ...over,
  });
const ollamaCredential = (over: Partial<CredentialStatus> = {}) =>
  makeCredential('ollama', { source: 'env', enabled: true, ...over });

interface Server {
  items: CredentialStatus[];
}

async function openProviders(server: Server, routes: Record<string, ApiRouteHandler> = {}) {
  const app = await render({
    path: '/admin/providers',
    server: {
      me: adminMe(),
      routes: adminRoutes({
        'GET /admin/engine/credentials': () => json(200, { items: server.items }),
        ...routes,
      }),
    },
  });
  await screen.findByRole('region', { name: JEV });
  return app;
}

/** `openProviders`, also giving the fake API, so that a test can end the sign-in. */
async function openWithServer(credentials: Server, routes: Record<string, ApiRouteHandler> = {}) {
  const server: FakeServer = {
    me: adminMe(),
    routes: adminRoutes({
      'GET /admin/engine/credentials': () => json(200, { items: credentials.items }),
      ...routes,
    }),
  };
  const app = await render({ path: '/admin/providers', server });
  await screen.findByRole('region', { name: JEV });
  return { app, server };
}

type App = Awaited<ReturnType<typeof renderApp>>;

/**
 * Ends the sign-in and has the cache hold `loaded`, as it would once the next sign-in of this
 * account has loaded the credentials; the key of that entry is returned.
 */
async function endSignIn(app: App, server: FakeServer, loaded: Server) {
  server.me = null;
  await act(() => app.session.resetAccountState());
  const key = accountKey(adminMe().id, 'admin', 'credentials');
  app.queryClient.setQueryData(key, { items: loaded.items });
  return key;
}

const panel = (name: string = JEV) => within(screen.getByRole('region', { name }));

function dump(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error
      ? { name: item.name, message: item.message, cause: String(item.cause) }
      : item,
  );
}

/** Every place the key could be kept: the page, the caches, the address and the browser storage. */
function placesHolding(app: Awaited<ReturnType<typeof renderApp>>, secret: string): string[] {
  const places: Record<string, string> = {
    html: document.documentElement.outerHTML,
    text: document.body.textContent ?? '',
    fields: dump(
      Array.from(
        document.querySelectorAll('input, textarea'),
        (e) => (e as HTMLInputElement).value,
      ),
    ),
    queryCache: dump(
      app.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => ({
          key: query.queryKey,
          data: query.state.data,
          error: query.state.error,
        })),
    ),
    mutationCache: dump(
      app.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => ({
          key: mutation.options.mutationKey,
          variables: mutation.state.variables,
          data: mutation.state.data,
          error: mutation.state.error,
        })),
    ),
    routerLocation: dump(app.router.state.location),
    windowLocation: window.location.href,
    localStorage: dump({ ...window.localStorage }),
    sessionStorage: dump({ ...window.sessionStorage }),
    cookie: document.cookie,
  };
  return Object.entries(places)
    .filter(([, content]) => content.includes(secret))
    .map(([place]) => place);
}

describe('provider accounts (spec 09 §8)', () => {
  it('shows each provider panel with its configured source, versions, validation and capabilities', async () => {
    await openProviders({
      items: [
        jevCredential({
          candidateStatus: 'valid',
          validatedAt: T1,
          capabilities: {
            model: 'jev-1.13.0',
            concurrencyLimit: 4,
            flags: { noul: true, score: false },
          },
        }),
        ollamaCredential({ lastErrorCode: 'rate_limited' }),
      ],
    });

    const jev = panel();
    expect(jev.getByText('Stored encrypted in the database')).toBeVisible();
    expect(jev.getByText('Enabled')).toBeVisible();
    expect(jev.getByText('Version 3')).toBeVisible();
    expect(jev.getByText('Version 4')).toBeVisible();
    expect(jev.getByText('Valid')).toBeVisible();
    expect(
      screen.getByRole('region', { name: JEV }).querySelector(`time[datetime="${T1}"]`),
    ).not.toBeNull();
    expect(jev.getByText('Model: jev-1.13.0')).toBeVisible();
    expect(jev.getByText('Concurrency limit: 4')).toBeVisible();
    expect(jev.getByText('noul: yes')).toBeVisible();
    expect(jev.getByText('score: no')).toBeVisible();
    expect(jev.getByLabelText(KEY_LABEL)).toHaveValue('');

    const ollama = panel('Ollama');
    expect(ollama.getByText('Environment key on the worker')).toBeVisible();
    expect(ollama.getByText('Enabled')).toBeVisible();
    expect(
      ollama.getByText('The provider is rate limiting requests. Validate again in a few minutes.'),
    ).toBeVisible();
    expect(screen.getByText(/never shown again/)).toBeVisible();
  });

  it('shows a provider that is not configured', async () => {
    await openProviders({ items: [makeCredential('typesafe'), makeCredential('ollama')] });

    expect(panel().getByText('Not configured')).toBeVisible();
    expect(panel().getByText('Disabled')).toBeVisible();
    expect(panel().queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(panel().queryByRole('button', { name: 'Validate' })).toBeNull();
    expect(panel().queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it.each([
    [
      'invalid_response',
      'The provider answered, but not in the expected format. Check that the endpoint and model are right.',
    ],
    ['rate_limited', 'The provider is rate limiting requests. Validate again in a few minutes.'],
    ['timeout', 'The provider did not answer in time. Validate again.'],
    ['provider_unavailable', 'The provider is unavailable right now. Validate again later.'],
    ['not_configured', 'The worker has no endpoint or model configured for this provider.'],
    [
      'probe_budget_exceeded',
      'The validation reached its spending limit before it finished. Validate again.',
    ],
    ['decrypt_failed', 'The worker could not decrypt the staged key. Stage the key again.'],
    [
      'budget_unavailable',
      'The daily budget is spent, so no test call was made. Validate again once budget is available.',
    ],
    [
      'auth_rejected',
      'The provider rejected the key. Check that it is correct and still active, then stage it again.',
    ],
    [
      'request_rejected',
      'The provider rejected the test request, for example because the model is not available to this key.',
    ],
    ['provider_error', 'The provider returned an error during validation.'],
    ['cost_overrun', 'The test call cost more than expected and was stopped. Validate again.'],
    [
      'credential_unavailable',
      'The worker could not load the staged key. Validate again, or stage the key again.',
    ],
    ['something_new', 'Validation stopped with the code something_new.'],
  ])('explains the last error %s in words', async (code, explanation) => {
    await openProviders({
      items: [
        jevCredential({
          candidateStatus: code === 'rate_limited' ? 'pending' : 'invalid',
          lastErrorCode: code,
        }),
        ollamaCredential(),
      ],
    });

    expect(panel().getByText(explanation)).toBeVisible();
  });

  it('stages a key without keeping it anywhere, and sends the revision it was staged against', async () => {
    const server: Server = {
      items: [jevCredential({ candidateVersion: null, candidateStatus: null }), ollamaCredential()],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staged = jevCredential({
      revision: '6',
      candidateVersion: '6',
      candidateStatus: 'pending',
    });
    const app = await openProviders(server, {
      'PUT /admin/engine/credentials/:provider': async () => {
        await gate;
        server.items = [staged, ollamaCredential()];
        return json(200, { credential: staged });
      },
    });
    const input = panel().getByLabelText(KEY_LABEL);
    expect(input).toHaveAttribute('type', 'password');
    expect(panel().getByRole('button', { name: 'Stage key' })).toBeDisabled();

    await app.user.type(input, SECRET);
    await app.user.click(panel().getByRole('button', { name: 'Stage key' }));

    // The input is empty as soon as the key is sent, before the answer is known.
    expect(input).toHaveValue('');
    expect(placesHolding(app, SECRET)).toEqual([]);
    expect(panel().getByRole('button', { name: 'Stage key' })).toHaveAttribute('aria-busy', 'true');
    release();
    expect(await screen.findByText(STAGED_MESSAGE)).toBeVisible();

    const requests = app.calls('PUT /admin/engine/credentials/:provider');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe('/api/v1/admin/engine/credentials/typesafe');
    expect(bodyOf(requests[0]!)).toEqual({ apiKey: SECRET, expectedRevision: '5' });
    expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(panel().getByText('Version 6')).toBeVisible();
    expect(panel().getByLabelText(KEY_LABEL)).toHaveValue('');
    expect(placesHolding(app, SECRET)).toEqual([]);
    expect(app.queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(app.unhandled).toEqual([]);
  });

  it('stages the Ollama key against the Ollama revision', async () => {
    const server: Server = { items: [jevCredential(), ollamaCredential({ revision: '2' })] };
    const app = await openProviders(server, {
      'PUT /admin/engine/credentials/:provider': () =>
        json(200, {
          credential: ollamaCredential({
            source: 'db',
            revision: '3',
            candidateVersion: '3',
            candidateStatus: 'pending',
          }),
        }),
    });

    await app.user.type(panel('Ollama').getByLabelText('New API key for Ollama'), SECRET);
    await app.user.click(panel('Ollama').getByRole('button', { name: 'Stage key' }));

    expect(await screen.findByText(STAGED_MESSAGE)).toBeVisible();
    const [request] = app.calls('PUT /admin/engine/credentials/:provider');
    expect(request!.pathname).toBe('/api/v1/admin/engine/credentials/ollama');
    expect(bodyOf(request!)).toEqual({ apiKey: SECRET, expectedRevision: '2' });
    expect(placesHolding(app, SECRET)).toEqual([]);
  });

  it.each([
    [409, 'CONFLICT', { sqlState: 'BZ409' }, CHANGED_MESSAGE],
    [
      503,
      'ENGINE_UNAVAILABLE',
      { reason: 'keyring_unavailable' },
      'Key storage is not set up on the server (no master key), so keys cannot be saved.',
    ],
    [
      400,
      'VALIDATION_FAILED',
      { field: 'apiKey' },
      'The server did not accept this key. Check that you pasted the whole key without spaces.',
    ],
    [429, 'RATE_LIMITED', { retryAfter: 60 }, 'Too many requests. Wait a moment and try again.'],
  ])(
    'explains a refused key (%i %s) without echoing it',
    async (status, code, details, message) => {
      const server: Server = { items: [jevCredential(), ollamaCredential()] };
      const app = await openProviders(server, {
        'PUT /admin/engine/credentials/:provider': () => failure(status, code, details),
      });

      await app.user.type(panel().getByLabelText(KEY_LABEL), SECRET);
      await app.user.click(panel().getByRole('button', { name: 'Stage key' }));

      expect(await panel().findByRole('alert')).toHaveTextContent(message);
      expect(placesHolding(app, SECRET)).toEqual([]);
      expect(panel().getByLabelText(KEY_LABEL)).toHaveValue('');
      expect(app.calls('GET /admin/engine/credentials')).toHaveLength(status === 409 ? 2 : 1);
    },
  );

  it('explains validation, then polls every 2 seconds while it runs and stops once it is valid', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    const server: Server = { items: [jevCredential(), ollamaCredential()] };
    let reads = 0;
    const app = await openProviders(server, {
      'GET /admin/engine/credentials': () => {
        reads += 1;
        return json(200, { items: server.items });
      },
      'POST /admin/engine/credentials/:provider/validate': () => {
        server.items = [jevCredential({ candidateStatus: 'validating' }), ollamaCredential()];
        return json(202, { credential: server.items[0] });
      },
    });
    expect(panel().getByText(/Validation makes a small test call to the provider/)).toBeVisible();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();
    const quiet = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(quiet);

    await app.user.click(panel().getByRole('button', { name: 'Validate' }));

    const [request] = app.calls('POST /admin/engine/credentials/:provider/validate');
    expect(request!.pathname).toBe('/api/v1/admin/engine/credentials/typesafe/validate');
    expect(bodyOf(request!)).toEqual({ candidateVersion: '4', expectedRevision: '5' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(await panel().findByText('Validating…')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();

    const before = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(reads - before).toBe(3);
    expect(panel().getByText('Validating…')).toBeVisible();

    server.items = [
      jevCredential({ candidateStatus: 'valid', validatedAt: T1 }),
      ollamaCredential(),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(await panel().findByText('Valid')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeEnabled();

    const settled = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(settled);
    expect(app.unhandled).toEqual([]);
  });

  it('stops polling at an inconclusive result and offers to validate again', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    const server: Server = { items: [jevCredential(), ollamaCredential()] };
    let reads = 0;
    const app = await openProviders(server, {
      'GET /admin/engine/credentials': () => {
        reads += 1;
        return json(200, { items: server.items });
      },
      'POST /admin/engine/credentials/:provider/validate': () => {
        server.items = [jevCredential({ candidateStatus: 'validating' }), ollamaCredential()];
        return json(202, { credential: server.items[0] });
      },
    });

    await app.user.click(panel().getByRole('button', { name: 'Validate' }));
    await panel().findByText('Validating…');
    server.items = [jevCredential({ lastErrorCode: 'rate_limited' }), ollamaCredential()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(
      await panel().findByText(
        'The provider is rate limiting requests. Validate again in a few minutes.',
      ),
    ).toBeVisible();
    const settled = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(settled);
    expect(panel().getByRole('button', { name: 'Validate' })).toBeEnabled();
  });

  it('activates the validated candidate and shows it as the active version', async () => {
    const server: Server = {
      items: [jevCredential({ candidateStatus: 'valid', validatedAt: T1 }), ollamaCredential()],
    };
    const app = await openProviders(server, {
      'POST /admin/engine/credentials/:provider/activate': () => {
        server.items = [
          jevCredential({
            revision: '6',
            activeVersion: '4',
            candidateVersion: null,
            candidateStatus: null,
          }),
          ollamaCredential(),
        ];
        return json(200, { credential: server.items[0] });
      },
    });
    expect(panel().getByText(/A validation is good for 24 hours/)).toBeVisible();

    await app.user.click(panel().getByRole('button', { name: 'Activate' }));

    const [request] = app.calls('POST /admin/engine/credentials/:provider/activate');
    expect(request!.pathname).toBe('/api/v1/admin/engine/credentials/typesafe/activate');
    expect(bodyOf(request!)).toEqual({ candidateVersion: '4', expectedRevision: '5' });
    expect(await screen.findByText('Key activated. It is used from now on.')).toBeVisible();
    expect(panel().getByText('Version 4')).toBeVisible();
    expect(panel().queryByText('Version 3')).toBeNull();
    expect(panel().queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('stages a key only once no other change of the provider is on its way', async () => {
    const server: Server = {
      items: [jevCredential({ candidateStatus: 'valid', validatedAt: T1 }), ollamaCredential()],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await openProviders(server, {
      'POST /admin/engine/credentials/:provider/activate': async () => {
        await gate;
        server.items = [
          jevCredential({
            revision: '6',
            activeVersion: '4',
            candidateVersion: null,
            candidateStatus: null,
          }),
          ollamaCredential(),
        ];
        return json(200, { credential: server.items[0] });
      },
    });

    await app.user.click(panel().getByRole('button', { name: 'Activate' }));
    await app.user.type(panel().getByLabelText(KEY_LABEL), SECRET);

    expect(panel().getByRole('button', { name: 'Stage key' })).toBeDisabled();
    await app.user.type(panel().getByLabelText(KEY_LABEL), '{Enter}');
    expect(app.calls('PUT /admin/engine/credentials/:provider')).toHaveLength(0);
    release();
    expect(await screen.findByText('Key activated. It is used from now on.')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Stage key' })).toBeEnabled();
    expect(app.calls('PUT /admin/engine/credentials/:provider')).toHaveLength(0);
  });

  it('refetches and explains a refused activation (the credential changed)', async () => {
    const server: Server = {
      items: [jevCredential({ candidateStatus: 'valid', validatedAt: T1 }), ollamaCredential()],
    };
    const app = await openProviders(server, {
      'POST /admin/engine/credentials/:provider/activate': () => {
        server.items = [
          jevCredential({ revision: '7', candidateStatus: 'pending' }),
          ollamaCredential(),
        ];
        return failure(409, 'CONFLICT', { sqlState: 'BZ409' });
      },
    });

    await app.user.click(panel().getByRole('button', { name: 'Activate' }));

    expect(await panel().findByRole('alert')).toHaveTextContent(CHANGED_MESSAGE);
    expect(app.calls('GET /admin/engine/credentials')).toHaveLength(2);
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();
  });

  it('shows a validation older than 24 hours as expired and does not offer to activate it', async () => {
    await openProviders({
      items: [
        jevCredential({
          candidateStatus: 'valid',
          validatedAt: new Date(NOW - DAY_MS - 60_000).toISOString(),
        }),
        ollamaCredential(),
      ],
    });

    expect(panel().getByText('Expired')).toBeVisible();
    expect(panel().queryByText('Valid')).toBeNull();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(panel().getByRole('button', { name: 'Validate' })).toBeEnabled();
  });

  it('says to validate again when the validation expired while the page was open', async () => {
    const server: Server = {
      items: [
        jevCredential({
          candidateStatus: 'valid',
          validatedAt: new Date(NOW - DAY_MS + 30_000).toISOString(),
        }),
        ollamaCredential(),
      ],
    };
    const app = await openProviders(server, {
      'POST /admin/engine/credentials/:provider/activate': () =>
        failure(409, 'CONFLICT', { sqlState: 'BZ409' }),
    });
    expect(panel().getByText('Valid')).toBeVisible();
    vi.setSystemTime(NOW + 60_000);

    await app.user.click(panel().getByRole('button', { name: 'Activate' }));

    expect(await panel().findByRole('alert')).toHaveTextContent(
      'This validation is older than 24 hours, so the key cannot be activated. Validate it again first.',
    );
    expect(await panel().findByText('Expired')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();
  });

  it('refetches and explains a validation that found no staged key (404)', async () => {
    const server: Server = { items: [jevCredential(), ollamaCredential()] };
    const app = await openProviders(server, {
      'POST /admin/engine/credentials/:provider/validate': () =>
        failure(404, 'NOT_FOUND', { sqlState: 'BZ404' }),
    });

    await app.user.click(panel().getByRole('button', { name: 'Validate' }));

    expect(await panel().findByRole('alert')).toHaveTextContent(
      'There is no staged key any more. The latest state is shown.',
    );
    expect(app.calls('GET /admin/engine/credentials')).toHaveLength(2);
  });

  it('keeps a rejected key visible as invalid and lets it be validated again', async () => {
    await openProviders({
      items: [
        jevCredential({
          candidateStatus: 'invalid',
          validatedAt: T1,
          lastErrorCode: 'auth_rejected',
        }),
        ollamaCredential(),
      ],
    });

    expect(panel().getByText('Invalid')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Validate' })).toBeEnabled();
    expect(panel().getByRole('button', { name: 'Activate' })).toBeDisabled();
  });

  it('disables a provider only after saying the key must also be revoked at the provider', async () => {
    const server: Server = { items: [jevCredential(), ollamaCredential()] };
    const app = await openProviders(server, {
      'DELETE /admin/engine/credentials/:provider': () => {
        server.items = [
          makeCredential('typesafe', { source: 'db', enabled: false, revision: '6' }),
          ollamaCredential(),
        ];
        return json(200, { credential: server.items[0] });
      },
    });

    await app.user.click(panel().getByRole('button', { name: 'Disable' }));

    const dialog = await screen.findByRole('dialog', { name: `Disable ${JEV}?` });
    expect(within(dialog).getByText(/does not revoke the key at the provider/)).toBeVisible();
    expect(app.calls('DELETE /admin/engine/credentials/:provider')).toHaveLength(0);

    await app.user.click(within(dialog).getByRole('button', { name: 'Disable provider' }));

    expect(await panel().findByText('Disabled')).toBeVisible();
    const [request] = app.calls('DELETE /admin/engine/credentials/:provider');
    expect(request!.pathname).toBe('/api/v1/admin/engine/credentials/typesafe');
    expect(request!.query.get('expectedRevision')).toBe('5');
    expect(request!.body).toBeNull();
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(panel().queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('confirms nothing when the key is staged once the sign-in has ended', async () => {
    const answer = gate();
    const credentials: Server = {
      items: [jevCredential({ candidateVersion: null, candidateStatus: null }), ollamaCredential()],
    };
    const { app, server } = await openWithServer(credentials, {
      'PUT /admin/engine/credentials/:provider': async () => {
        await answer.opened;
        return json(200, {
          credential: jevCredential({
            revision: '6',
            candidateVersion: '6',
            candidateStatus: 'pending',
          }),
        });
      },
    });
    await app.user.type(panel().getByLabelText(KEY_LABEL), SECRET);
    await app.user.click(panel().getByRole('button', { name: 'Stage key' }));
    await vi.waitFor(() =>
      expect(app.calls('PUT /admin/engine/credentials/:provider')).toHaveLength(1),
    );

    const key = await endSignIn(app, server, credentials);
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText(STAGED_MESSAGE)).toBeNull();
    expect(app.queryClient.getQueryData(key)).toEqual({ items: credentials.items });
  });

  it('adopts nothing when the validation is requested once the sign-in has ended', async () => {
    const answer = gate();
    const credentials: Server = { items: [jevCredential(), ollamaCredential()] };
    const { app, server } = await openWithServer(credentials, {
      'POST /admin/engine/credentials/:provider/validate': async () => {
        await answer.opened;
        return json(202, { credential: jevCredential({ candidateStatus: 'validating' }) });
      },
    });
    await app.user.click(panel().getByRole('button', { name: 'Validate' }));
    await vi.waitFor(() =>
      expect(app.calls('POST /admin/engine/credentials/:provider/validate')).toHaveLength(1),
    );

    const key = await endSignIn(app, server, credentials);
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(app.queryClient.getQueryData(key)).toEqual({ items: credentials.items });
  });

  it('confirms nothing when the key is activated once the sign-in has ended', async () => {
    const answer = gate();
    const credentials: Server = {
      items: [jevCredential({ candidateStatus: 'valid', validatedAt: T1 }), ollamaCredential()],
    };
    const { app, server } = await openWithServer(credentials, {
      'POST /admin/engine/credentials/:provider/activate': async () => {
        await answer.opened;
        return json(200, {
          credential: jevCredential({
            revision: '6',
            activeVersion: '4',
            candidateVersion: null,
            candidateStatus: null,
          }),
        });
      },
    });
    await app.user.click(panel().getByRole('button', { name: 'Activate' }));
    await vi.waitFor(() =>
      expect(app.calls('POST /admin/engine/credentials/:provider/activate')).toHaveLength(1),
    );

    const key = await endSignIn(app, server, credentials);
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('Key activated. It is used from now on.')).toBeNull();
    expect(app.queryClient.getQueryData(key)).toEqual({ items: credentials.items });
  });

  it('confirms nothing when the provider is disabled once the sign-in has ended', async () => {
    const answer = gate();
    const credentials: Server = { items: [jevCredential(), ollamaCredential()] };
    const { app, server } = await openWithServer(credentials, {
      'DELETE /admin/engine/credentials/:provider': async () => {
        await answer.opened;
        return json(200, {
          credential: makeCredential('typesafe', { source: 'db', enabled: false, revision: '6' }),
        });
      },
    });
    await app.user.click(panel().getByRole('button', { name: 'Disable' }));
    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable provider' }),
    );
    await vi.waitFor(() =>
      expect(app.calls('DELETE /admin/engine/credentials/:provider')).toHaveLength(1),
    );

    const key = await endSignIn(app, server, credentials);
    answer.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText('Provider disabled.')).toBeNull();
    expect(app.queryClient.getQueryData(key)).toEqual({ items: credentials.items });
  });

  it.each([
    [
      'staging the key',
      'PUT /admin/engine/credentials/:provider',
      async (app: App) => {
        await app.user.type(panel().getByLabelText(KEY_LABEL), SECRET);
        await app.user.click(panel().getByRole('button', { name: 'Stage key' }));
      },
    ],
    [
      'requesting a validation',
      'POST /admin/engine/credentials/:provider/validate',
      async (app: App) => {
        await app.user.click(panel().getByRole('button', { name: 'Validate' }));
      },
    ],
    [
      'activating the key',
      'POST /admin/engine/credentials/:provider/activate',
      async (app: App) => {
        await app.user.click(panel().getByRole('button', { name: 'Activate' }));
      },
    ],
    [
      'disabling the provider',
      'DELETE /admin/engine/credentials/:provider',
      async (app: App) => {
        await app.user.click(panel().getByRole('button', { name: 'Disable' }));
        await app.user.click(
          within(await screen.findByRole('dialog')).getByRole('button', {
            name: 'Disable provider',
          }),
        );
      },
    ],
  ])(
    'refreshes nothing when %s is refused once the sign-in has ended',
    async (_change, route, start) => {
      const answer = gate();
      const credentials: Server = {
        items: [jevCredential({ candidateStatus: 'valid', validatedAt: T1 }), ollamaCredential()],
      };
      const { app, server } = await openWithServer(credentials, {
        [route]: async () => {
          await answer.opened;
          return failure(409, 'CONFLICT', { sqlState: 'BZ409' });
        },
      });
      await start(app);
      await vi.waitFor(() => expect(app.calls(route)).toHaveLength(1));

      const key = await endSignIn(app, server, credentials);
      answer.release();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(app.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    },
  );

  it('shows the error state when the credentials cannot be loaded', async () => {
    await render({
      path: '/admin/providers',
      server: {
        me: adminMe(),
        routes: adminRoutes({ 'GET /admin/engine/credentials': () => failure(500, 'INTERNAL') }),
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
  });
});
