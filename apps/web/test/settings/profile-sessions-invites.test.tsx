import type { CreateInviteBody, InviteDto, Me, SessionDto } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import {
  EMAIL,
  bodiesOf,
  deferred,
  formatted,
  goOffline,
  makeInviteRow,
  makeSession,
  openSettings,
  patchMe,
  section,
} from './support.js';

describe('profile (spec 09 §7)', () => {
  const profile = () => within(section('Profile'));
  const nameField = () => profile().getByRole('textbox', { name: 'Display name' });
  const language = () => profile().getByRole('combobox', { name: 'Language' });
  const zone = () => profile().getByRole('combobox', { name: 'Time zone' });
  const theme = (name: string) =>
    within(profile().getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name });
  const save = () => profile().getByRole('button', { name: 'Save profile' });

  it('shows the account as it is, with nothing to save yet', async () => {
    await openSettings({
      me: makeMe({
        email: EMAIL,
        displayName: 'Ada',
        timezone: 'Europe/Prague',
        preferences: { theme: 'dark' },
      }),
    });

    expect(profile().getByText('Signed in as a@example.com')).toBeVisible();
    expect(nameField()).toHaveValue('Ada');
    expect(nameField()).toHaveAttribute('maxlength', '100');
    expect(language()).toHaveValue('en');
    expect(zone()).toHaveValue('Europe/Prague');
    expect(theme('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(theme('Light')).toHaveAttribute('aria-checked', 'false');
    expect(save()).toBeDisabled();
  });

  it('offers English and Slovak', async () => {
    await openSettings();

    expect(
      within(language())
        .getAllByRole('option')
        .map((item) => [item.getAttribute('value'), item.textContent]),
    ).toEqual([
      ['en', 'English'],
      ['sk', 'Slovenčina'],
    ]);
  });

  it('offers every time zone the browser knows, and the account own even when it is not one of them', async () => {
    const known = Intl.supportedValuesOf('timeZone');
    expect(known).not.toContain('UTC');
    await openSettings({ me: makeMe({ email: EMAIL, timezone: 'UTC' }) });

    const values = within(zone())
      .getAllByRole('option')
      .map((item) => item.getAttribute('value'));
    expect(values).toEqual(expect.arrayContaining(known));
    expect(values).toContain('UTC');
    expect(new Set(values).size).toBe(values.length);
    expect(zone()).toHaveValue('UTC');
  });

  it('offers UTC, which the browser does not list, to an account in another zone', async () => {
    await openSettings({ me: makeMe({ email: EMAIL, timezone: 'Europe/Prague' }) });

    const values = within(zone())
      .getAllByRole('option')
      .map((item) => item.getAttribute('value'));
    expect(values).toContain('UTC');
    expect(values).toContain('Europe/Prague');
    expect(new Set(values).size).toBe(values.length);
  });

  it('offers the three themes', async () => {
    await openSettings();

    expect(
      within(profile().getByRole('radiogroup', { name: 'Theme' }))
        .getAllByRole('radio')
        .map((item) => item.textContent),
    ).toEqual(['Match my device', 'Light', 'Dark']);
    expect(theme('Match my device')).toHaveAttribute('aria-checked', 'true');
  });

  describe('saving', () => {
    it('sends a new display name alone and says it was saved', async () => {
      const { user, calls, queryClient } = await openSettings();

      await user.type(nameField(), 'Ada');
      expect(save()).toBeEnabled();
      await user.click(save());

      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ displayName: 'Ada' }]);
      expect(queryClient.getQueryData<Me>(meKey())?.displayName).toBe('Ada');
      expect(nameField()).toHaveValue('Ada');
      expect(save()).toBeDisabled();
    });

    it('sends the request the way every mutation of the app is sent', async () => {
      const { user, calls } = await openSettings();

      await user.type(nameField(), 'Ada');
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      const request = calls('PATCH /me')[0];
      expect(request?.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(request?.credentials).toBe('same-origin');
    });

    it('trims the display name', async () => {
      const { user, calls } = await openSettings();

      await user.type(nameField(), '  Ada Lovelace  ');
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ displayName: 'Ada Lovelace' }]);
    });

    it.each([
      ['empty', ''],
      ['only spaces', '   '],
    ])('clears the display name when it is %s', async (_name, text) => {
      const { user, calls } = await openSettings({
        me: makeMe({ email: EMAIL, displayName: 'Ada' }),
      });

      await user.clear(nameField());
      if (text !== '') await user.type(nameField(), text);
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ displayName: null }]);
      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );
      expect(nameField()).toHaveValue('');
    });

    it('sends the language alone, and the screen switches to it', async () => {
      const { user, calls } = await openSettings();

      await user.selectOptions(language(), 'sk');
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ locale: 'sk' }]);
      expect(await screen.findByRole('heading', { level: 1, name: 'Nastavenia' })).toBeVisible();
      expect(within(section('Profil')).getByRole('status')).toHaveTextContent(
        'Profil bol uložený.',
      );
      expect(document.documentElement.lang).toBe('sk');
    });

    it('sends the time zone alone', async () => {
      const { user, calls, queryClient } = await openSettings();

      await user.selectOptions(zone(), 'Europe/Prague');
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ timezone: 'Europe/Prague' }]);
      await waitFor(() =>
        expect(queryClient.getQueryData<Me>(meKey())?.timezone).toBe('Europe/Prague'),
      );
    });

    it('sends the theme as a preference, and applies it once it is saved', async () => {
      const { user, calls } = await openSettings();

      await user.click(theme('Dark'));
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { theme: 'dark' } }]);
      await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
      expect(theme('Dark')).toHaveAttribute('aria-checked', 'true');
    });

    it('sends everything that changed in one request', async () => {
      const { user, calls } = await openSettings({
        me: makeMe({ email: EMAIL, displayName: 'Ada' }),
      });

      await user.clear(nameField());
      await user.type(nameField(), 'Ada L');
      await user.selectOptions(language(), 'sk');
      await user.selectOptions(zone(), 'Europe/Prague');
      await user.click(theme('Light'));
      await user.click(save());

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([
        {
          displayName: 'Ada L',
          locale: 'sk',
          timezone: 'Europe/Prague',
          preferences: { theme: 'light' },
        },
      ]);
    });

    it('takes what another tab saved into the fields not edited here, and sends only the edit', async () => {
      const { user, calls, queryClient } = await openSettings({
        me: makeMe({ email: EMAIL, displayName: 'Ada', timezone: 'Europe/Bratislava' }),
      });
      await user.clear(nameField());
      await user.type(nameField(), 'Ada L');

      // Another tab saved a new time zone, and the account of this tab is loaded again with it.
      act(() => {
        queryClient.setQueryData<Me>(meKey(), (me) => me && { ...me, timezone: 'Europe/Prague' });
      });

      await waitFor(() => expect(zone()).toHaveValue('Europe/Prague'));
      expect(nameField()).toHaveValue('Ada L');
      await user.click(save());
      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ displayName: 'Ada L' }]);
    });

    it('has nothing to save until something differs from the saved profile', async () => {
      const { user, calls } = await openSettings({
        me: makeMe({ email: EMAIL, displayName: 'Ada' }),
      });

      await user.type(nameField(), ' ');
      expect(save()).toBeDisabled();
      await user.type(nameField(), 'x');
      expect(save()).toBeEnabled();
      await user.type(nameField(), '{Backspace}');
      expect(save()).toBeDisabled();
      await user.selectOptions(language(), 'sk');
      expect(save()).toBeEnabled();
      await user.selectOptions(language(), 'en');
      expect(save()).toBeDisabled();
      expect(calls('PATCH /me')).toHaveLength(0);
    });

    it('stops saying "saved" as soon as the profile is edited again', async () => {
      const { user } = await openSettings();
      await user.type(nameField(), 'Ada');
      await user.click(save());
      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );

      await user.type(nameField(), 'x');

      expect(profile().getByRole('status')).toBeEmptyDOMElement();
    });

    it('does not send a second request while the first one is on its way', async () => {
      const gate = deferred();
      const { user, calls } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });
      await user.type(nameField(), 'Ada');

      await user.click(save());
      expect(save()).toBeDisabled();
      await user.click(save());
      gate.release();

      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );
      expect(calls('PATCH /me')).toHaveLength(1);
    });

    it('keeps a preference saved meanwhile when the answer of the profile arrives after it', async () => {
      // The profile is saved first; its answer, the account as it stood then, arrives last.
      const gate = deferred();
      const { user, calls, queryClient } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            const answer = await patchMe(server)(request, params);
            if ((bodyOf(request) as Partial<Me>).displayName !== undefined) await gate.promise;
            return answer;
          },
        }),
      });
      const simpleMode = () =>
        within(section('Reading preferences')).getByRole('switch', { name: 'Simple mode' });
      const shown = () => queryClient.getQueryData<Me>(meKey());

      await user.type(nameField(), 'Ada');
      await user.click(save());
      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      await user.click(simpleMode());
      await waitFor(() => expect(simpleMode()).toHaveAccessibleDescription(/Saved/));
      gate.release();

      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );
      expect(shown()?.displayName).toBe('Ada');
      expect(shown()?.preferences.simpleMode).toBe(true);
      expect(simpleMode()).toHaveAttribute('aria-checked', 'true');
      expect(nameField()).toHaveValue('Ada');
      expect(save()).toBeDisabled();
    });
  });

  describe('when saving fails', () => {
    it('keeps what was typed, says what happened and lets the person try again', async () => {
      let failing = true;
      const { user, calls } = await openSettings({
        routes: (server) => ({
          'PATCH /me': (request, params) =>
            failing ? failure(500, 'INTERNAL') : patchMe(server)(request, params),
        }),
      });
      await user.type(nameField(), 'Ada');

      await user.click(save());

      expect(await profile().findByRole('alert')).toHaveTextContent(
        'Your profile was not saved. Something went wrong on our side. Try again.',
      );
      expect(nameField()).toHaveValue('Ada');
      expect(save()).toBeEnabled();
      expect(profile().getByRole('status')).toBeEmptyDOMElement();

      failing = false;
      await user.click(save());

      await waitFor(() =>
        expect(profile().getByRole('status')).toHaveTextContent('Profile saved.'),
      );
      expect(profile().queryByRole('alert')).toBeNull();
      expect(calls('PATCH /me')).toHaveLength(2);
    });

    it('says so when the browser is offline instead of waiting for a connection', async () => {
      const { user } = await openSettings({
        routes: {
          'PATCH /me': () => {
            throw new TypeError('Failed to fetch');
          },
        },
      });
      await user.type(nameField(), 'Ada');
      goOffline();

      await user.click(save());

      expect(await profile().findByRole('alert')).toHaveTextContent(
        "Your profile was not saved. You seem to be offline, or the server can't be reached.",
      );
      expect(save()).toBeEnabled();
    });
  });
});

describe('sessions (spec 09 §7)', () => {
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0';
  const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1';
  const CURRENT = makeSession({
    id: '1',
    userAgent: FIREFOX,
    ip: '203.0.113.7',
    createdAt: '2026-10-01T08:00:00.000Z',
    lastSeenAt: '2026-10-08T07:30:00.000Z',
    current: true,
  });
  const PHONE_SESSION = makeSession({
    id: '2',
    userAgent: PHONE,
    ip: '198.51.100.20',
    createdAt: '2026-10-03T10:15:00.000Z',
    lastSeenAt: '2026-10-07T18:45:00.000Z',
  });
  const UNKNOWN = makeSession({
    id: '3',
    userAgent: null,
    ip: null,
    createdAt: '2026-09-20T06:00:00.000Z',
    lastSeenAt: '2026-09-21T06:00:00.000Z',
  });

  function sessionsApi(initial: SessionDto[], over: Record<string, ApiRouteHandler> = {}) {
    const state = { sessions: [...initial] };
    const routes: Record<string, ApiRouteHandler> = {
      'GET /auth/sessions': () => json(200, state.sessions),
      'DELETE /auth/sessions/:id': (_request, params) => {
        state.sessions = state.sessions.filter((item) => item.id !== params['id']);
        return noContent();
      },
      ...over,
    };
    return { state, routes };
  }

  const sessions = () => within(section('Sessions'));
  const rowOf = (text: string) => {
    const row = sessions().getByText(text).closest('li');
    if (row === null) throw new Error(`no list item holds "${text}"`);
    return within(row);
  };

  it('lists the devices, this one first and then the most recently used', async () => {
    const api = sessionsApi([UNKNOWN, PHONE_SESSION, CURRENT]);
    await openSettings({ routes: api.routes });

    await sessions().findByText(FIREFOX);
    expect(
      sessions()
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining(FIREFOX),
      expect.stringContaining(PHONE),
      expect.stringContaining('Unknown device'),
    ]);
  });

  it('shows the device, the address and when it signed in and was last used', async () => {
    const api = sessionsApi([CURRENT, PHONE_SESSION, UNKNOWN]);
    await openSettings({
      routes: api.routes,
      me: makeMe({ email: EMAIL, timezone: 'America/New_York' }),
    });

    await sessions().findByText(PHONE);
    const phone = rowOf(PHONE);
    expect(phone.getByText('198.51.100.20')).toBeVisible();
    const signedIn = phone.getByText(formatted(PHONE_SESSION.createdAt, 'America/New_York'));
    expect(signedIn.tagName.toLowerCase()).toBe('time');
    expect(signedIn).toHaveAttribute('datetime', PHONE_SESSION.createdAt);
    expect(phone.getByText('Signed in')).toBeVisible();
    expect(phone.getByText(formatted(PHONE_SESSION.lastSeenAt, 'America/New_York'))).toBeVisible();
    expect(phone.getByText('Last active')).toBeVisible();
    const unknown = rowOf('Unknown device');
    expect(unknown.getByText('Unknown address')).toBeVisible();
  });

  it('marks the device in use', async () => {
    const api = sessionsApi([CURRENT, PHONE_SESSION]);
    await openSettings({ routes: api.routes });

    await sessions().findByText(PHONE);
    expect(rowOf(FIREFOX).getByText('This device')).toBeVisible();
    expect(rowOf(PHONE).queryByText('This device')).toBeNull();
    expect(sessions().getAllByText('This device')).toHaveLength(1);
  });

  describe('revoking another device', () => {
    it('asks first, and does nothing when the person cancels', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION]);
      const { user, calls } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);

      await user.click(rowOf(PHONE).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining('will be signed out'));
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(calls('DELETE /auth/sessions/:id')).toHaveLength(0);
      expect(sessions().getByText(PHONE)).toBeVisible();
    });

    it('signs that device out and takes it off the list', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION]);
      const { user, calls } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);

      await user.click(rowOf(PHONE).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });
      await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

      await waitFor(() => expect(sessions().queryByText(PHONE)).toBeNull());
      expect(screen.queryByRole('dialog')).toBeNull();
      const [request] = calls('DELETE /auth/sessions/:id');
      expect(request?.pathname).toBe('/api/v1/auth/sessions/2');
      expect(request?.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(calls('GET /auth/sessions')).toHaveLength(2);
      expect(sessions().getByText(FIREFOX)).toBeVisible();
    });

    it('moves the focus to the list, since the button that opened the dialog is gone', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION]);
      const { user } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);

      await user.click(rowOf(PHONE).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });
      await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

      await waitFor(() =>
        expect(sessions().getByRole('list', { name: 'Your sessions' })).toHaveFocus(),
      );
    });

    it('names the session in the label of the button, so two buttons are never alike', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION, UNKNOWN]);
      await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);

      const names = sessions()
        .getAllByRole('button', { name: /^Revoke session: / })
        .map((button) => button.getAttribute('aria-label'));

      expect(new Set(names).size).toBe(3);
      expect(names[1]).toContain(PHONE);
    });

    it('keeps the dialog open and says what went wrong when the server fails', async () => {
      let failing = true;
      const api = sessionsApi([CURRENT, PHONE_SESSION], {
        'DELETE /auth/sessions/:id': (_request, params) => {
          if (failing) return failure(500, 'INTERNAL');
          api.state.sessions = api.state.sessions.filter((item) => item.id !== params['id']);
          return noContent();
        },
      });
      const { user } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);
      await user.click(rowOf(PHONE).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });

      await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(sessions().getByText(PHONE)).toBeVisible();
      failing = false;
      await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));
      await waitFor(() => expect(sessions().queryByText(PHONE)).toBeNull());
    });

    it('treats a session that is already gone as revoked', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION], {
        'DELETE /auth/sessions/:id': () => {
          api.state.sessions = api.state.sessions.filter((item) => item.id !== '2');
          return failure(404, 'NOT_FOUND');
        },
      });
      const { user } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);
      await user.click(rowOf(PHONE).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });

      await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));

      await waitFor(() => expect(sessions().queryByText(PHONE)).toBeNull());
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('revoking this device', () => {
    it('warns that it signs out, then drops everything of the account and lands on the sign-in page', async () => {
      const api = sessionsApi([CURRENT, PHONE_SESSION]);
      const { user, calls, router, queryClient } = await openSettings({ routes: api.routes });
      await sessions().findByText(PHONE);

      await user.click(rowOf(FIREFOX).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of this device?' });
      expect(dialog).toHaveAccessibleDescription(expect.stringContaining('signed out here'));
      await user.click(within(dialog).getByRole('button', { name: 'Revoke and sign out' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/login');
      expect(calls('DELETE /auth/sessions/:id').map((request) => request.pathname)).toEqual([
        '/api/v1/auth/sessions/1',
      ]);
      expect(queryClient.getQueryData(meKey())).toBeNull();
      expect(
        queryClient
          .getQueryCache()
          .findAll()
          .filter((query) => query.queryKey[0] === USER_A_ID),
      ).toEqual([]);
      expect(calls('GET /auth/sessions')).toHaveLength(1);
    });

    it('stays signed in when the server cannot revoke it', async () => {
      const api = sessionsApi([CURRENT], {
        'DELETE /auth/sessions/:id': () => failure(500, 'INTERNAL'),
      });
      const { user, router, queryClient } = await openSettings({ routes: api.routes });
      await sessions().findByText(FIREFOX);
      await user.click(rowOf(FIREFOX).getByRole('button', { name: /^Revoke session: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Sign out of this device?' });

      await user.click(within(dialog).getByRole('button', { name: 'Revoke and sign out' }));

      expect(await within(dialog).findByRole('alert')).toBeVisible();
      expect(router.state.location.pathname).toBe('/settings');
      expect(queryClient.getQueryData<Me>(meKey())?.id).toBe(USER_A_ID);
    });
  });

  describe('when the list cannot be shown', () => {
    it('says what went wrong and loads it again on request', async () => {
      let failing = true;
      const api = sessionsApi([CURRENT], {
        'GET /auth/sessions': () => (failing ? failure(500, 'INTERNAL') : json(200, [CURRENT])),
      });
      const { user } = await openSettings({ routes: api.routes });

      expect(await sessions().findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      failing = false;
      await user.click(sessions().getByRole('button', { name: 'Retry' }));

      expect(await sessions().findByText(FIREFOX)).toBeVisible();
    });

    it('says the server cannot be reached', async () => {
      const api = sessionsApi([CURRENT], {
        'GET /auth/sessions': () => {
          throw new TypeError('Failed to fetch');
        },
      });
      await openSettings({ routes: api.routes });

      expect(await sessions().findByText("You're offline")).toBeVisible();
      expect(sessions().getByRole('button', { name: 'Retry' })).toBeVisible();
    });
  });
});

describe('invites (spec 09 §7, spec 08 §2.2)', () => {
  const FUTURE = '2036-10-31T08:00:00.000Z';
  const urlOf = (code: string) => `http://localhost:5173/join?code=${code}`;
  const ACTIVE = makeInviteRow({ code: 'AAAAAAAAAA', url: urlOf('AAAAAAAAAA'), expiresAt: FUTURE });
  const SENT = makeInviteRow({
    code: 'BBBBBBBBBB',
    url: urlOf('BBBBBBBBBB'),
    email: 'friend@example.com',
    expiresAt: FUTURE,
  });
  const USED = makeInviteRow({
    code: 'CCCCCCCCCC',
    url: urlOf('CCCCCCCCCC'),
    email: 'joined@example.com',
    expiresAt: FUTURE,
    usedAt: '2026-10-03T09:30:00.000Z',
  });
  const EXPIRED = makeInviteRow({
    code: 'DDDDDDDDDD',
    url: urlOf('DDDDDDDDDD'),
    createdAt: '2020-01-01T08:00:00.000Z',
    expiresAt: '2020-01-31T08:00:00.000Z',
  });

  function invitesApi(
    initial: InviteDto[],
    left: number,
    over: Record<string, ApiRouteHandler> = {},
  ) {
    const state = { items: [...initial], left, created: 0 };
    const routes: Record<string, ApiRouteHandler> = {
      'GET /invites': () => json(200, { items: state.items, invitesLeft: state.left }),
      'POST /invites': (request) => {
        const body = bodyOf(request) as CreateInviteBody;
        if (state.left === 0) {
          return failure(409, 'QUOTA_EXCEEDED', { limit: 'invites', invitesLeft: 0 });
        }
        state.created += 1;
        state.left -= 1;
        const code = `NEWCODE${String(state.created).padStart(3, '0')}`;
        state.items.unshift(
          makeInviteRow({
            code,
            url: urlOf(code),
            email: body.email ?? null,
            createdAt: new Date().toISOString(),
            expiresAt: FUTURE,
          }),
        );
        return json(201, {
          code,
          url: urlOf(code),
          ...(body.email === undefined ? {} : { emailSent: true }),
        });
      },
      ...over,
    };
    return { state, routes };
  }

  const invites = () => within(section('Invites'));
  const list = () => invites().getByRole('list', { name: 'Your invites' });
  const rowOf = (code: string) => {
    const row = within(list()).getByText(code).closest('li');
    if (row === null) throw new Error(`no list item holds "${code}"`);
    return within(row);
  };
  const emailField = () => invites().getByRole('textbox', { name: 'Email address (optional)' });
  const noteField = () => invites().getByRole('textbox', { name: 'Note (optional)' });
  const create = () => invites().getByRole('button', { name: 'Create invite' });
  const created = () => within(invites().getByRole('group', { name: 'New invite' }));

  it('says how many invites are left', async () => {
    const api = invitesApi([ACTIVE], 2);
    await openSettings({ routes: api.routes });

    expect(await invites().findByText('Invites left: 2')).toBeVisible();
  });

  describe('the list', () => {
    it('shows each invite with who it is for, its dates and whether it is still good', async () => {
      const api = invitesApi([ACTIVE, SENT, USED, EXPIRED], 1);
      await openSettings({ routes: api.routes });

      await invites().findByRole('list', { name: 'Your invites' });
      const active = rowOf('AAAAAAAAAA');
      expect(active.getByText('Active')).toBeVisible();
      expect(active.getByText('Anyone with the link')).toBeVisible();
      expect(active.getByText(formatted(ACTIVE.createdAt))).toHaveAttribute(
        'datetime',
        ACTIVE.createdAt,
      );
      expect(active.getByText(formatted(FUTURE))).toBeVisible();
      expect(rowOf('BBBBBBBBBB').getByText('Sent to friend@example.com')).toBeVisible();
      const used = rowOf('CCCCCCCCCC');
      expect(used.getByText('Used')).toBeVisible();
      expect(used.getByText(formatted(USED.usedAt as string))).toBeVisible();
      expect(rowOf('DDDDDDDDDD').getByText('Expired')).toBeVisible();
      expect(rowOf('AAAAAAAAAA').getByText('Not used yet')).toBeVisible();
    });

    it('offers to copy the link of the invites that can still be used, and of no other', async () => {
      const api = invitesApi([ACTIVE, SENT, USED, EXPIRED], 1);
      await openSettings({ routes: api.routes });

      await invites().findByRole('list', { name: 'Your invites' });
      expect(
        rowOf('AAAAAAAAAA').getByRole('button', { name: 'Copy link for invite AAAAAAAAAA' }),
      ).toBeVisible();
      expect(
        rowOf('BBBBBBBBBB').getByRole('button', { name: 'Copy link for invite BBBBBBBBBB' }),
      ).toBeVisible();
      expect(rowOf('CCCCCCCCCC').queryByRole('button')).toBeNull();
      expect(rowOf('DDDDDDDDDD').queryByRole('button')).toBeNull();
    });

    it('puts the link of an invite on the clipboard', async () => {
      const api = invitesApi([ACTIVE], 2);
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByRole('list', { name: 'Your invites' });

      await user.click(
        rowOf('AAAAAAAAAA').getByRole('button', { name: 'Copy link for invite AAAAAAAAAA' }),
      );

      await waitFor(() => expect(invites().getByRole('status')).toHaveTextContent('Link copied.'));
      expect(await navigator.clipboard.readText()).toBe(urlOf('AAAAAAAAAA'));
    });

    it('gives the link to copy by hand when the browser refuses the clipboard', async () => {
      const api = invitesApi([ACTIVE], 2);
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByRole('list', { name: 'Your invites' });
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

      await user.click(
        rowOf('AAAAAAAAAA').getByRole('button', { name: 'Copy link for invite AAAAAAAAAA' }),
      );

      expect(await invites().findByRole('alert')).toHaveTextContent(
        `Couldn't copy the link automatically. Select it here and copy it: ${urlOf('AAAAAAAAAA')}`,
      );
    });

    it('says what went wrong and loads the list again on request', async () => {
      let failing = true;
      const api = invitesApi([ACTIVE], 2, {
        'GET /invites': () =>
          failing ? failure(500, 'INTERNAL') : json(200, { items: [ACTIVE], invitesLeft: 2 }),
      });
      const { user } = await openSettings({ routes: api.routes });

      expect(await invites().findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      failing = false;
      await user.click(invites().getByRole('button', { name: 'Retry' }));

      expect(await invites().findByText('Invites left: 2')).toBeVisible();
      expect(rowOf('AAAAAAAAAA')).toBeTruthy();
    });

    it('says when there is no invite yet', async () => {
      const api = invitesApi([], 3);
      await openSettings({ routes: api.routes });

      expect(await invites().findByText('You have not created an invite yet.')).toBeVisible();
      expect(invites().queryByRole('list', { name: 'Your invites' })).toBeNull();
    });
  });

  describe('creating one', () => {
    it('sends an invite without an address as a bare request, and shows the code and the link', async () => {
      const api = invitesApi([], 3);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.click(create());

      expect(await invites().findByRole('group', { name: 'New invite' })).toBeVisible();
      expect(bodiesOf(calls('POST /invites'))).toEqual([{}]);
      expect(created().getByText('NEWCODE001')).toBeVisible();
      expect(created().getByLabelText('Invite link')).toHaveValue(urlOf('NEWCODE001'));
      expect(created().queryByText(/Invite emailed/)).toBeNull();
      expect(invites().getByRole('status')).toHaveTextContent('Invite created.');
      const request = calls('POST /invites')[0];
      expect(request?.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    });

    it('lists the new invite and counts one fewer left', async () => {
      const api = invitesApi([], 3);
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.click(create());

      expect(await invites().findByText('Invites left: 2')).toBeVisible();
      expect(rowOf('NEWCODE001').getByText('Active')).toBeVisible();
    });

    it('keeps the account in step with the invites it has left', async () => {
      const api = invitesApi([], 3);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');
      const before = calls('GET /me').length;

      await user.click(create());
      await invites().findByText('Invites left: 2');

      await waitFor(() => expect(calls('GET /me').length).toBeGreaterThan(before));
    });

    it('sends the address, normalised, and the note, trimmed, and says the email went out', async () => {
      const api = invitesApi([], 3);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.type(emailField(), ' Friend@Example.com ');
      await user.type(noteField(), '  For Alice  ');
      await user.click(create());

      expect(await invites().findByRole('group', { name: 'New invite' })).toBeVisible();
      expect(bodiesOf(calls('POST /invites'))).toEqual([
        { email: 'friend@example.com', note: 'For Alice' },
      ]);
      expect(created().getByText('Invite emailed to friend@example.com.')).toBeVisible();
      expect(emailField()).toHaveValue('');
      expect(noteField()).toHaveValue('');
    });

    it('tells the person to share the link when the email could not be sent', async () => {
      const api = invitesApi([], 3, {
        'POST /invites': () =>
          json(201, { code: 'NEWCODE001', url: urlOf('NEWCODE001'), emailSent: false }),
      });
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.type(emailField(), 'friend@example.com');
      await user.click(create());

      expect(
        await created().findByText('The email could not be sent. Share the link yourself.'),
      ).toBeVisible();
      expect(created().getByLabelText('Invite link')).toHaveValue(urlOf('NEWCODE001'));
    });

    it('puts the new link on the clipboard', async () => {
      const api = invitesApi([], 3);
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');
      await user.click(create());
      await invites().findByRole('group', { name: 'New invite' });

      await user.click(created().getByRole('button', { name: 'Copy link' }));

      await waitFor(() => expect(invites().getByRole('status')).toHaveTextContent('Link copied.'));
      expect(await navigator.clipboard.readText()).toBe(urlOf('NEWCODE001'));
    });

    it('rejects an address that is not one, without asking the server', async () => {
      const api = invitesApi([], 3);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.type(emailField(), 'not-an-email');
      await user.click(create());

      expect(emailField()).toBeInvalid();
      expect(emailField()).toHaveAccessibleDescription(
        expect.stringContaining('Enter a valid email address.'),
      );
      expect(calls('POST /invites')).toHaveLength(0);
      await user.type(emailField(), '@example.com');
      expect(emailField()).not.toBeInvalid();
    });

    it('limits the note to what the server accepts', async () => {
      const api = invitesApi([], 3);
      await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      expect(noteField()).toHaveAttribute('maxlength', '500');
      expect(noteField()).toHaveAccessibleDescription(
        expect.stringContaining("isn't included in the email"),
      );
    });

    it('cannot create one when none are left', async () => {
      const api = invitesApi([ACTIVE], 0);
      await openSettings({ routes: api.routes });

      expect(await invites().findByText('Invites left: 0')).toBeVisible();
      expect(invites().getByText('You have no invites left.')).toBeVisible();
      expect(create()).toBeDisabled();
    });

    it('says there are none left when another device used the last one', async () => {
      const api = invitesApi([], 1, {
        'POST /invites': () => {
          api.state.left = 0;
          return failure(409, 'QUOTA_EXCEEDED', { limit: 'invites', invitesLeft: 0 });
        },
      });
      const { user } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 1');

      await user.click(create());

      expect(await invites().findByRole('alert')).toHaveTextContent('You have no invites left.');
      expect(await invites().findByText('Invites left: 0')).toBeVisible();
      expect(create()).toBeDisabled();
    });

    it('says what went wrong, keeps what was typed and sends the retry under the same key', async () => {
      let failing = true;
      const api = invitesApi([], 3);
      const original = api.routes['POST /invites'] as ApiRouteHandler;
      api.routes['POST /invites'] = (request, params) =>
        failing ? failure(500, 'INTERNAL') : original(request, params);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');
      await user.type(emailField(), 'friend@example.com');

      await user.click(create());

      expect(await invites().findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(emailField()).toHaveValue('friend@example.com');
      failing = false;
      await user.click(create());

      expect(await invites().findByRole('group', { name: 'New invite' })).toBeVisible();
      expect(invites().queryByRole('alert')).toBeNull();
      const keys = calls('POST /invites').map((request) => request.headers.get('Idempotency-Key'));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_V4);
      expect(keys[1]).toBe(keys[0]);
    });

    it('sends a changed invite under a new key', async () => {
      let failing = true;
      const api = invitesApi([], 3);
      const original = api.routes['POST /invites'] as ApiRouteHandler;
      api.routes['POST /invites'] = (request, params) =>
        failing ? failure(500, 'INTERNAL') : original(request, params);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');
      await user.type(emailField(), 'friend@example.com');
      await user.click(create());
      await invites().findByRole('alert');

      failing = false;
      await user.type(noteField(), 'For Alice');
      await user.click(create());

      await invites().findByRole('group', { name: 'New invite' });
      const keys = calls('POST /invites').map((request) => request.headers.get('Idempotency-Key'));
      expect(keys[1]).not.toBe(keys[0]);
    });

    it('makes a second invite of its own, not a replay of the first, even when asked the same way', async () => {
      const api = invitesApi([], 3);
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.click(create());
      await invites().findByText('Invites left: 2');
      await user.click(create());
      await invites().findByText('Invites left: 1');

      const keys = calls('POST /invites').map((request) => request.headers.get('Idempotency-Key'));
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
      expect(created().getByText('NEWCODE002')).toBeVisible();
    });

    it('does not send twice while the first request is on its way', async () => {
      const gate = deferred();
      const api = invitesApi([], 3);
      const original = api.routes['POST /invites'] as ApiRouteHandler;
      api.routes['POST /invites'] = async (request, params) => {
        await gate.promise;
        return original(request, params);
      };
      const { user, calls } = await openSettings({ routes: api.routes });
      await invites().findByText('Invites left: 3');

      await user.click(create());
      expect(create()).toBeDisabled();
      await user.click(create());
      gate.release();

      await invites().findByRole('group', { name: 'New invite' });
      expect(calls('POST /invites')).toHaveLength(1);
    });
  });

  describe('in Slovak', () => {
    it('is written in the account language', async () => {
      const api = invitesApi([ACTIVE], 3);
      await openSettings({ routes: api.routes, me: makeMe({ email: EMAIL, locale: 'sk' }) });

      const region = within(screen.getByRole('region', { name: 'Pozvánky' }));
      expect(await region.findByText('Zostávajúce pozvánky: 3')).toBeVisible();
      expect(region.getByRole('button', { name: 'Vytvoriť pozvánku' })).toBeVisible();
      expect(region.getByText('Aktívna')).toBeVisible();
    });
  });
});
