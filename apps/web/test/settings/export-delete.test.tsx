import type { Me } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { isOfflineEnabled, writeOfflineEnabled } from '../../src/offline/device.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { USER_A_ID, USER_B_ID, makeMe } from '../session/fixtures.js';
import { EMAIL, deferred, goOffline, openSettings, section } from './support.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface ExportCall {
  url: string;
  init: RequestInit | undefined;
  signal: AbortSignal | null;
}

/** Replaces the global `fetch`, which the page uses to stream `GET /me/export`, and records its calls. */
function stubExportFetch(respond: (call: ExportCall) => Response | Promise<Response>) {
  const calls: ExportCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? null;
      const call: ExportCall = { url: String(input), init, signal };
      calls.push(call);
      return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        Promise.resolve(respond(call)).then(resolve, reject);
      });
    }),
  );
  return calls;
}

/** A response whose body the test writes to, piece by piece, like a server streaming a file. */
function streamingResponse(call?: ExportCall, init: ResponseInit = {}) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  call?.signal?.addEventListener('abort', () => {
    try {
      controller.error(call.signal?.reason);
    } catch {
      // Already closed.
    }
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      ...init,
    }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
  };
}

const DOCUMENT = JSON.stringify({ schemaVersion: 2, padding: 'x'.repeat(4068) });

describe('export (spec 09 §7)', () => {
  const exporting = () => within(section('Export your data'));
  const download = () => exporting().getByRole('button', { name: 'Download my data' });
  const cancel = () => exporting().getByRole('button', { name: 'Cancel download' });

  const blobs: Blob[] = [];
  const saved: { href: string; download: string }[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;

  // The page releases the file after a delay; the stand-ins stay until this group is over.
  beforeAll(() => {
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return `blob:test-${blobs.length}`;
    });
    URL.revokeObjectURL = vi.fn();
  });

  afterAll(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  beforeEach(() => {
    blobs.length = 0;
    saved.length = 0;
    vi.mocked(URL.revokeObjectURL).mockClear();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      saved.push({ href: this.href, download: this.download });
    });
  });

  async function open() {
    return openSettings({ routes: { 'GET /rules': () => json(200, []) } });
  }

  it('explains what the file holds', async () => {
    await open();

    expect(exporting().getByText(/one JSON file/)).toBeVisible();
    expect(download()).toBeEnabled();
    expect(exporting().queryByRole('button', { name: 'Cancel download' })).toBeNull();
  });

  it('asks for the file from the same origin with the session cookie and shows how much has arrived', async () => {
    let stream!: ReturnType<typeof streamingResponse>;
    const calls = stubExportFetch((call) => {
      stream = streamingResponse(call);
      return stream.response;
    });
    const { user } = await open();

    await user.click(download());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/v1/me/export');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(download()).toBeDisabled();
    expect(exporting().getByRole('status')).toHaveTextContent('Downloading your data…');
    act(() => stream.send(DOCUMENT.slice(0, 1500)));
    expect(await exporting().findByText(/Downloading… 1\.5\s*kB received/)).toBeVisible();
    act(() => stream.send(DOCUMENT.slice(1500, 2500)));
    expect(await exporting().findByText(/Downloading… 2\.5\s*kB received/)).toBeVisible();
    expect(exporting().getByRole('status')).toHaveTextContent('Downloading your data…');
    expect(cancel()).toBeEnabled();
    expect(blobs).toHaveLength(0);
  });

  describe('a complete file', () => {
    it('is saved under a name with the date in the account time zone', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-08T22:30:00.000Z') });
      let stream!: ReturnType<typeof streamingResponse>;
      stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user } = await open();

      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());
      act(() => stream.send(DOCUMENT.slice(0, 2000)));
      act(() => stream.send(DOCUMENT.slice(2000)));
      act(() => stream.end());

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]).toEqual({
        href: 'blob:test-1',
        download: 'bantoozi-export-2026-10-09.json',
      });
      expect(blobs).toHaveLength(1);
      expect(blobs[0]?.type).toBe('application/json');
      expect(await blobs[0]?.text()).toBe(DOCUMENT);
      expect(exporting().getByRole('status')).toHaveTextContent(
        /Saved bantoozi-export-2026-10-09\.json \(4\.1\s*kB\)\./,
      );
      expect(download()).toBeEnabled();
      expect(exporting().queryByRole('alert')).toBeNull();
    });

    it('is not released straight away, so the browser can read it', async () => {
      let stream!: ReturnType<typeof streamingResponse>;
      stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());

      act(() => stream.send(DOCUMENT));
      act(() => stream.end());

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it('can be asked for again', async () => {
      const calls = stubExportFetch(() => new Response(DOCUMENT, { status: 200 }));
      const { user } = await open();

      await user.click(download());
      await waitFor(() => expect(saved).toHaveLength(1));
      await user.click(download());

      await waitFor(() => expect(saved).toHaveLength(2));
      expect(calls).toHaveLength(2);
    });
  });

  describe('cancelling', () => {
    it('stops the download, saves nothing and says so', async () => {
      let stream!: ReturnType<typeof streamingResponse>;
      const calls = stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());
      act(() => stream.send(DOCUMENT.slice(0, 1500)));
      await exporting().findByText(/Downloading… 1\.5\s*kB received/);

      await user.click(cancel());

      expect(calls[0]?.signal?.aborted).toBe(true);
      await waitFor(() =>
        expect(exporting().getByRole('status')).toHaveTextContent(
          'Download cancelled. Nothing was saved.',
        ),
      );
      expect(download()).toBeEnabled();
      expect(exporting().queryByRole('button', { name: 'Cancel download' })).toBeNull();
      expect(exporting().queryByRole('alert')).toBeNull();
      expect(blobs).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });

    it('puts the focus back on the button that began the download, since the cancel button is gone', async () => {
      const calls = stubExportFetch(() => new Promise<Response>(() => {}));
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(calls).toHaveLength(1));

      await user.click(cancel());

      await waitFor(() => expect(download()).toHaveFocus());
    });

    it('can be cancelled before the server has answered', async () => {
      const calls = stubExportFetch(() => new Promise<Response>(() => {}));
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(calls).toHaveLength(1));

      await user.click(cancel());

      expect(calls[0]?.signal?.aborted).toBe(true);
      await waitFor(() =>
        expect(exporting().getByRole('status')).toHaveTextContent(
          'Download cancelled. Nothing was saved.',
        ),
      );
      expect(download()).toBeEnabled();
    });

    it('is also what leaving the page does', async () => {
      let stream!: ReturnType<typeof streamingResponse>;
      const calls = stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user, router } = await open();
      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());
      act(() => stream.send(DOCUMENT.slice(0, 1500)));

      await act(async () => {
        await router.navigate({ to: '/rules' });
      });

      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(blobs).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });
  });

  describe('when it fails', () => {
    it('says the file is incomplete, and saves nothing, when it ends in the middle of the JSON', async () => {
      let stream!: ReturnType<typeof streamingResponse>;
      stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());

      act(() => stream.send(DOCUMENT.slice(0, 2500)));
      act(() => stream.end());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        'The file arrived incomplete, so nothing was saved. Try again.',
      );
      expect(blobs).toHaveLength(0);
      expect(saved).toHaveLength(0);
      expect(download()).toBeEnabled();
    });

    it('says the file is incomplete when the server sends nothing at all', async () => {
      stubExportFetch(() => new Response('', { status: 200 }));
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        'The file arrived incomplete, so nothing was saved. Try again.',
      );
      expect(saved).toHaveLength(0);
    });

    it('says the download was interrupted when the connection breaks while the file arrives', async () => {
      let stream!: ReturnType<typeof streamingResponse>;
      stubExportFetch((call) => {
        stream = streamingResponse(call);
        return stream.response;
      });
      const { user } = await open();
      await user.click(download());
      await waitFor(() => expect(stream).toBeDefined());

      act(() => stream.send(DOCUMENT.slice(0, 1500)));
      act(() => stream.fail(new TypeError('network error')));

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        'The download was interrupted. Check your connection and try again.',
      );
      expect(saved).toHaveLength(0);
      expect(download()).toBeEnabled();
    });

    it('says the download was interrupted when the server cannot be reached', async () => {
      stubExportFetch(() => Promise.reject(new TypeError('Failed to fetch')));
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        'The download was interrupted. Check your connection and try again.',
      );
      expect(download()).toBeEnabled();
    });

    it('says the server could not prepare the file, with the code it answered', async () => {
      stubExportFetch(
        () => new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 503 }),
      );
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        'The server could not prepare your export (error 503). Try again.',
      );
      expect(saved).toHaveLength(0);
      expect(download()).toBeEnabled();
    });

    it('ends the session when the server answers 401, as every other call does', async () => {
      stubExportFetch(
        () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
      );
      const { user, queryClient } = await open();

      await user.click(download());

      await waitFor(() => expect(queryClient.getQueryData(meKey())).toBeNull());
      expect(saved).toHaveLength(0);
    });

    it('ends only the session it was asked in, not one that began while it was on its way', async () => {
      let answer!: (response: Response) => void;
      stubExportFetch(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const { user, session } = await open();
      const cookie = vi.spyOn(session, 'currentCookie').mockReturnValue(7);
      const told = vi.spyOn(session, 'unauthorized');
      await user.click(download());
      cookie.mockReturnValue(8);

      answer(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }));

      await waitFor(() => expect(told).toHaveBeenCalledWith(7));
    });

    it('lets the person try again after an error, and the error goes away', async () => {
      let failing = true;
      stubExportFetch(() =>
        failing ? new Response('', { status: 500 }) : new Response(DOCUMENT, { status: 200 }),
      );
      const { user } = await open();
      await user.click(download());
      await exporting().findByRole('alert');

      failing = false;
      await user.click(download());

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(exporting().queryByRole('alert')).toBeNull();
    });

    it.each([
      ['150', 'Try again in 3 minutes.'],
      ['60', 'Try again in 1 minute.'],
      ['1', 'Try again in 1 minute.'],
      ['3600', 'Try again in 60 minutes.'],
    ])('tells how long to wait when the server says %s seconds', async (seconds, wait) => {
      stubExportFetch(() => new Response('', { status: 429, headers: { 'Retry-After': seconds } }));
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        `You've asked for your data too often. ${wait}`,
      );
      expect(saved).toHaveLength(0);
    });

    it('works out the wait from a date, too', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-08T12:00:00.000Z') });
      stubExportFetch(
        () =>
          new Response('', {
            status: 429,
            headers: { 'Retry-After': new Date('2026-10-08T12:10:00.000Z').toUTCString() },
          }),
      );
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        "You've asked for your data too often. Try again in 10 minutes.",
      );
    });

    it('asks the person to try again later when the server gives no time', async () => {
      stubExportFetch(() => new Response('', { status: 429 }));
      const { user } = await open();

      await user.click(download());

      expect(await exporting().findByRole('alert')).toHaveTextContent(
        "You've asked for your data too often. Try again later.",
      );
    });
  });

  describe('in Slovak', () => {
    it('is written in the account language', async () => {
      stubExportFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
      const { user } = await openSettings({
        me: makeMe({ email: EMAIL, locale: 'sk' }),
        routes: { 'GET /rules': () => json(200, []) },
      });
      const region = within(screen.getByRole('region', { name: 'Export údajov' }));

      await user.click(region.getByRole('button', { name: 'Stiahnuť moje údaje' }));

      expect(await region.findByRole('alert')).toHaveTextContent('Skúste to znova o 2 minúty.');
    });
  });
});

describe('deleting the account (spec 09 §7)', () => {
  const deleting = () => within(section('Delete account'));
  const trigger = () => deleting().getByRole('button', { name: 'Delete my account…' });
  const dialog = () => screen.findByRole('dialog', { name: 'Delete your account?' });
  const typed = () => screen.getByRole('textbox', { name: `Type ${EMAIL} to confirm` });
  const confirm = () =>
    within(screen.getByRole('dialog', { name: 'Delete your account?' })).getByRole('button', {
      name: 'Delete account',
    });

  async function openDialog(options: Parameters<typeof openSettings>[0] = {}) {
    const app = await openSettings(options);
    await app.user.click(trigger());
    await dialog();
    return app;
  }

  it('explains the seven days in which the account can still be restored, before anything is asked', async () => {
    await openSettings();

    expect(deleting().getByText(/within 7 days/)).toBeVisible();
    expect(deleting().getByText(/sign in again/i)).toBeVisible();
    expect(trigger()).toBeEnabled();
  });

  it('opens a dialog that asks for the email address of the account', async () => {
    await openDialog();

    const found = await dialog();
    expect(found).toHaveAccessibleDescription(expect.stringContaining('7 days'));
    expect(typed()).toBeVisible();
    expect(typed()).toHaveValue('');
    expect(confirm()).toBeDisabled();
    expect(within(found).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('is confirmed only by typing the address, in any case and with spaces around it', async () => {
    const { user } = await openDialog();

    await user.type(typed(), 'someone@example.com');
    expect(confirm()).toBeDisabled();
    await user.clear(typed());
    await user.type(typed(), 'a@example');
    expect(confirm()).toBeDisabled();
    await user.clear(typed());
    await user.type(typed(), '  A@Example.COM ');
    expect(confirm()).toBeEnabled();
  });

  it('sends nothing when the person cancels', async () => {
    const { user, calls } = await openDialog();
    await user.type(typed(), EMAIL);

    await user.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls('DELETE /me')).toHaveLength(0);
    await user.click(trigger());
    expect(typed()).toHaveValue('');
  });

  describe('confirmed', () => {
    const routes = { 'DELETE /me': () => noContent() };

    afterEach(() => {
      writeOfflineEnabled(USER_A_ID, false);
      writeOfflineEnabled(USER_B_ID, false);
    });

    it("forgets this device's choice to keep the account's articles, and keeps another account's", async () => {
      writeOfflineEnabled(USER_A_ID, true);
      writeOfflineEnabled(USER_B_ID, true);
      const { user } = await openDialog({ routes });
      await user.type(typed(), EMAIL);

      await user.click(confirm());

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(isOfflineEnabled(USER_A_ID)).toBe(false);
      expect(isOfflineEnabled(USER_B_ID)).toBe(true);
    });

    it('deletes through the API, then drops every trace of the account and goes to the sign-in page', async () => {
      const { user, calls, router, queryClient } = await openDialog({ routes });
      await user.type(typed(), EMAIL);

      await user.click(confirm());

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/login');
      expect(calls('DELETE /me')).toHaveLength(1);
      const [request] = calls('DELETE /me');
      expect(request?.pathname).toBe('/api/v1/me');
      expect(request?.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(queryClient.getQueryData(meKey())).toBeNull();
      expect(
        queryClient
          .getQueryCache()
          .findAll()
          .filter((query) => query.queryKey[0] === USER_A_ID),
      ).toEqual([]);
    });

    it('says on the sign-in page that the account is deleted and can be restored for 7 days', async () => {
      const { user } = await openDialog({ routes });
      await user.type(typed(), EMAIL);

      await user.click(confirm());

      expect(
        await screen.findByText(
          'Your account is deleted. Sign in again within 7 days to restore it.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('waits for the server before it signs out or says anything was deleted', async () => {
      const gate = deferred();
      const { user, router, queryClient } = await openDialog({
        routes: {
          'DELETE /me': async () => {
            await gate.promise;
            return noContent();
          },
        },
      });
      await user.type(typed(), EMAIL);

      await user.click(confirm());

      await waitFor(() => expect(confirm()).toBeDisabled());
      expect(router.state.location.pathname).toBe('/settings');
      expect(queryClient.getQueryData<Me>(meKey())?.id).toBe(USER_A_ID);
      expect(screen.queryByText(/Your account is deleted/)).toBeNull();
      gate.release();
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    });

    it('cannot be sent twice', async () => {
      const gate = deferred();
      const { user, calls } = await openDialog({
        routes: {
          'DELETE /me': async () => {
            await gate.promise;
            return noContent();
          },
        },
      });
      await user.type(typed(), EMAIL);

      await user.click(confirm());
      await user.click(confirm());
      gate.release();

      await screen.findByRole('heading', { level: 1, name: 'Sign in' });
      expect(calls('DELETE /me')).toHaveLength(1);
    });

    it('can be confirmed with the Enter key once the address is typed', async () => {
      const { user, calls } = await openDialog({ routes });

      await user.type(typed(), `${EMAIL}{Enter}`);

      await screen.findByRole('heading', { level: 1, name: 'Sign in' });
      expect(calls('DELETE /me')).toHaveLength(1);
    });
  });

  describe('when it cannot be done', () => {
    it('keeps the account, the session and the dialog, and says the account was not deleted', async () => {
      const { user, router, queryClient } = await openDialog({
        routes: { 'DELETE /me': () => failure(500, 'INTERNAL') },
      });
      await user.type(typed(), EMAIL);

      await user.click(confirm());

      expect(await within(await dialog()).findByRole('alert')).toHaveTextContent(
        'Your account was not deleted. Something went wrong on our side. Try again.',
      );
      expect(router.state.location.pathname).toBe('/settings');
      expect(queryClient.getQueryData<Me>(meKey())?.id).toBe(USER_A_ID);
      expect(screen.queryByText(/Your account is deleted/)).toBeNull();
      expect(typed()).toHaveValue(EMAIL);
      expect(confirm()).toBeEnabled();
    });

    it('says so when the browser is offline, and deletes nothing', async () => {
      const { user, router, queryClient } = await openDialog({
        routes: {
          'DELETE /me': () => {
            throw new TypeError('Failed to fetch');
          },
        },
      });
      await user.type(typed(), EMAIL);
      goOffline();

      await user.click(confirm());

      expect(await within(await dialog()).findByRole('alert')).toHaveTextContent(
        "Your account was not deleted. You seem to be offline, or the server can't be reached.",
      );
      expect(router.state.location.pathname).toBe('/settings');
      expect(queryClient.getQueryData<Me>(meKey())?.id).toBe(USER_A_ID);
    });

    it('can be tried again, and the message goes away', async () => {
      let failing = true;
      const { user, calls } = await openDialog({
        routes: {
          'DELETE /me': () => (failing ? failure(500, 'INTERNAL') : noContent()),
        },
      });
      await user.type(typed(), EMAIL);
      await user.click(confirm());
      await within(await dialog()).findByRole('alert');

      failing = false;
      await user.click(confirm());

      await screen.findByRole('heading', { level: 1, name: 'Sign in' });
      expect(calls('DELETE /me')).toHaveLength(2);
    });

    it('starts from nothing when the dialog is opened again after a failure', async () => {
      const { user } = await openDialog({
        routes: { 'DELETE /me': () => failure(500, 'INTERNAL') },
      });
      await user.type(typed(), EMAIL);
      await user.click(confirm());
      await within(await dialog()).findByRole('alert');

      await user.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      await user.click(trigger());

      expect(within(await dialog()).queryByRole('alert')).toBeNull();
      expect(typed()).toHaveValue('');
    });
  });

  describe('in Slovak', () => {
    it('asks for the address in the account language', async () => {
      const { user } = await openSettings({ me: makeMe({ email: EMAIL, locale: 'sk' }) });
      const region = within(screen.getByRole('region', { name: 'Odstránenie účtu' }));

      await user.click(region.getByRole('button', { name: 'Odstrániť môj účet…' }));

      expect(await screen.findByRole('dialog', { name: 'Odstrániť váš účet?' })).toBeVisible();
      expect(screen.getByRole('textbox', { name: `Na potvrdenie napíšte ${EMAIL}` })).toBeVisible();
    });
  });
});
