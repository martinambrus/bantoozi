import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../src/i18n/index.js';
import { failure, json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { CODE, EMAIL, createHarness, signInServer } from './harness.js';

const REQUEST_CODE = 'POST /auth/request-code';
const VERIFY = 'POST /auth/verify';

const member = makeMe({ email: EMAIL });
const newcomer = makeMe({ email: EMAIL, preferences: { onboardingCompletedAt: null } });

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

async function sendCode(app: App, email = EMAIL) {
  await app.user.type(screen.getByLabelText('Email'), email);
  await app.user.click(screen.getByRole('button', { name: 'Send code' }));
  return screen.findByLabelText('Code');
}

async function enterCode(app: App, code = CODE) {
  await app.user.type(await screen.findByLabelText('Code'), code);
  await app.user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const pathname = (app: App) => app.router.state.location.pathname;

/** A promise to hold an answer back until the test lets it go. */
function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
}

describe('/login', () => {
  it('asks for the email, with a way to join the waitlist', async () => {
    await open({ path: '/login', server: signInServer({ account: member }) });

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toBeRequired();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Invite code')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join the waitlist' })).toHaveAttribute(
      'href',
      '/waitlist',
    );
  });

  it('is a page with a main landmark of its own', async () => {
    await open({ path: '/login', server: signInServer({ account: member }) });
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('requests a code for the email, without an Idempotency-Key, and asks for it', async () => {
    const app = await open({ path: '/login', server: signInServer({ account: member }) });

    const code = await sendCode(app);

    const requests = app.calls(REQUEST_CODE);
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ email: EMAIL, locale: 'en' });
    expect(requests[0]!.headers.has('Idempotency-Key')).toBe(false);
    expect(
      screen.getByText(`We sent a code to ${EMAIL}. Enter it below to continue.`),
    ).toBeVisible();
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveFocus();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send code' })).not.toBeInTheDocument();
    expect(pathname(app)).toBe('/login');
  });

  it.each([
    ['nothing', ''],
    ['an address without an @', 'ada.example.com'],
  ])('sends nothing for %s', async (_name, typed) => {
    const app = await open({ path: '/login', server: signInServer({ account: member }) });

    if (typed !== '') await app.user.type(screen.getByLabelText('Email'), typed);
    await app.user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(app.calls(REQUEST_CODE)).toHaveLength(0);
    expect(screen.getByLabelText('Email')).toBeInvalid();
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
  });

  it('removes the spaces of the code before sending it', async () => {
    const app = await open({ path: '/login', server: signInServer({ account: member }) });
    await sendCode(app);

    await enterCode(app, '123 456');

    const requests = app.calls(VERIFY);
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ email: EMAIL, code: '123456' });
    expect(requests[0]!.headers.has('Idempotency-Key')).toBe(false);
  });

  it('submits the email and the code with Enter', async () => {
    const app = await open({ path: '/login', server: signInServer({ account: member }) });

    await app.user.type(screen.getByLabelText('Email'), `${EMAIL}{Enter}`);
    await app.user.type(await screen.findByLabelText('Code'), `${CODE}{Enter}`);

    await waitFor(() => expect(pathname(app)).toBe('/read/for_you'));
    expect(app.calls(REQUEST_CODE)).toHaveLength(1);
    expect(app.calls(VERIFY)).toHaveLength(1);
  });

  describe('after signing in', () => {
    it.each([
      ['lands on the For you lane', '/login', member, '/read/for_you'],
      ['sends a new account to the onboarding wizard', '/login', newcomer, '/onboarding'],
      [
        'goes to the page the visitor wanted',
        '/login?redirect=%2Fread%2Fmaybe',
        member,
        '/read/maybe',
      ],
      [
        'keeps the query string of the wanted page',
        '/login?redirect=%2Fread%2Ffeed%2F42%3Fx%3D1',
        member,
        '/read/feed/42?x=1',
      ],
      [
        'still holds a new account in the wizard when a page was wanted',
        '/login?redirect=%2Fread%2Fmaybe',
        newcomer,
        '/onboarding',
      ],
    ])('%s', async (_name, path, account, expected) => {
      const app = await open({ path, server: signInServer({ account }) });
      await sendCode(app);

      await enterCode(app);

      await waitFor(() => {
        expect(app.router.state.location.href).toBe(expected);
        expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
      });
    });

    it.each([
      ['a protocol-relative URL', '//evil.example'],
      ['an absolute URL', 'https://evil.example'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a backslash URL', '/\\evil.example'],
      ['the login page itself', '/login'],
    ])('ignores %s as the wanted page', async (_name, redirect) => {
      const app = await open({
        path: `/login?redirect=${encodeURIComponent(redirect)}`,
        server: signInServer({ account: member }),
      });
      await sendCode(app);

      await enterCode(app);

      await waitFor(() => expect(app.router.state.location.href).toBe('/read/for_you'));
    });

    it('replaces the login screen in the history', async () => {
      const app = await open({ path: '/login', server: signInServer({ account: member }) });
      await sendCode(app);

      await enterCode(app);

      await waitFor(() => expect(pathname(app)).toBe('/read/for_you'));
      expect(app.router.history.length).toBe(1);
    });
  });

  describe('when the code is wrong', () => {
    it('stays on the code step and tells the visitor what to do', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [VERIFY]: () => failure(400, 'INVALID_CODE') },
        }),
      });
      await sendCode(app);

      await enterCode(app);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        "That code didn't work. Check the latest email we sent you, or send a new code.",
      );
      const code = screen.getByLabelText('Code');
      expect(code).toBeInvalid();
      expect(code).toHaveAccessibleDescription(alert.textContent ?? '');
      expect(code).toHaveFocus();
      expect(code).toHaveValue(CODE);
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
      expect(pathname(app)).toBe('/login');
    });

    it('lets the visitor try again', async () => {
      let attempts = 0;
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [VERIFY]: () =>
              ++attempts === 1 ? failure(400, 'INVALID_CODE') : json(200, { user: member }),
          },
        }),
      });
      await sendCode(app);
      await enterCode(app, '000000');
      await screen.findByRole('alert');

      await app.user.clear(screen.getByLabelText('Code'));
      await app.user.type(screen.getByLabelText('Code'), CODE);
      await app.user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(pathname(app)).toBe('/read/for_you'));
      expect(app.calls(VERIFY).map((request) => bodyOf(request))).toEqual([
        { email: EMAIL, code: '000000' },
        { email: EMAIL, code: CODE },
      ]);
    });
  });

  describe('when the server limits the requests', () => {
    it.each([
      ['rounds the wait up to whole minutes', '125', 'Too many attempts. Try again in 3 minutes.'],
      ['says one minute for an exact minute', '60', 'Too many attempts. Try again in 1 minute.'],
      ['waits at least a minute', '5', 'Too many attempts. Try again in 1 minute.'],
      ['counts an hour in minutes', '3600', 'Too many attempts. Try again in 60 minutes.'],
    ])('%s when verifying', async (_name, retryAfter, message) => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [VERIFY]: () => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': retryAfter }),
          },
        }),
      });
      await sendCode(app);

      await enterCode(app);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByLabelText('Code')).toBeInTheDocument();
      expect(pathname(app)).toBe('/login');
    });

    it('says so when asking for the code', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [REQUEST_CODE]: () =>
              failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '1800' }),
          },
        }),
      });

      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Try again in 30 minutes.',
      );
      expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
      expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    });

    it('falls back to the general sentence without a Retry-After', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [REQUEST_CODE]: () => failure(429, 'RATE_LIMITED') },
        }),
      });

      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many requests. Wait a moment and try again.',
      );
    });
  });

  describe('when something else goes wrong', () => {
    it('shows the sentence for the error when asking for the code', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [REQUEST_CODE]: () => failure(500, 'INTERNAL') },
        }),
      });

      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
      expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
    });

    it('shows the sentence for the error when verifying, not on the field', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [VERIFY]: () => failure(400, 'VALIDATION_FAILED') },
        }),
      });
      await sendCode(app);

      await enterCode(app);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Some of the information isn't valid. Check it and try again.",
      );
      expect(screen.getByLabelText('Code')).toBeValid();
    });

    it('says the server cannot be reached when the request fails', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [REQUEST_CODE]: () => Promise.reject(new TypeError('Failed to fetch')) },
        }),
      });

      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "You seem to be offline, or the server can't be reached.",
      );
    });

    it('clears the message when the visitor tries again', async () => {
      let attempts = 0;
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [REQUEST_CODE]: () =>
              ++attempts === 1 ? failure(500, 'INTERNAL') : json(202, { next: 'check_email' }),
          },
        }),
      });
      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));
      await screen.findByRole('alert');

      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      await screen.findByLabelText('Code');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('while a request runs', () => {
    it('disables the buttons and marks the one that was pressed as busy', async () => {
      const verifying = gate();
      const server = signInServer({
        account: member,
        routes: {
          [VERIFY]: async () => {
            await verifying.opened;
            server.me = member;
            return json(200, { user: member });
          },
        },
      });
      const app = await open({ path: '/login', server });
      await sendCode(app);

      await enterCode(app);

      const signIn = screen.getByRole('button', { name: 'Sign in' });
      await waitFor(() => expect(signIn).toBeDisabled());
      expect(signIn).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('button', { name: 'Send a new code' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Use a different email' })).toBeDisabled();

      verifying.release();
      await waitFor(() => expect(pathname(app)).toBe('/read/for_you'));
      expect(app.calls(VERIFY)).toHaveLength(1);
    });

    it('sends one request when the button is pressed twice', async () => {
      const sending = gate();
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [REQUEST_CODE]: async () => {
              await sending.opened;
              return json(202, { next: 'check_email' });
            },
          },
        }),
      });
      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      const send = screen.getByRole('button', { name: 'Send code' });

      await app.user.click(send);
      await app.user.click(send);
      sending.release();

      await screen.findByLabelText('Code');
      expect(app.calls(REQUEST_CODE)).toHaveLength(1);
    });
  });

  describe('on the code step', () => {
    it('sends a new code on request and says so', async () => {
      const app = await open({ path: '/login', server: signInServer({ account: member }) });
      await sendCode(app);
      await app.user.type(screen.getByLabelText('Code'), '999');

      await app.user.click(screen.getByRole('button', { name: 'Send a new code' }));

      expect(await screen.findByText(`We sent a new code to ${EMAIL}.`)).toBeVisible();
      expect(app.calls(REQUEST_CODE).map((request) => bodyOf(request))).toEqual([
        { email: EMAIL, locale: 'en' },
        { email: EMAIL, locale: 'en' },
      ]);
      const code = screen.getByLabelText('Code');
      expect(code).toHaveValue('');
      expect(code).toHaveFocus();
      expect(pathname(app)).toBe('/login');
    });

    it('drops the notice about the new code once the visitor tries a code', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [VERIFY]: () => failure(400, 'INVALID_CODE') },
        }),
      });
      await sendCode(app);
      await app.user.click(screen.getByRole('button', { name: 'Send a new code' }));
      await screen.findByText(`We sent a new code to ${EMAIL}.`);

      await enterCode(app);

      await screen.findByRole('alert');
      expect(screen.queryByText(`We sent a new code to ${EMAIL}.`)).not.toBeInTheDocument();
    });

    it('shows why a new code could not be sent', async () => {
      let requests = 0;
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: {
            [REQUEST_CODE]: () =>
              ++requests === 1
                ? json(202, { next: 'check_email' })
                : failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '600' }),
          },
        }),
      });
      await sendCode(app);

      await app.user.click(screen.getByRole('button', { name: 'Send a new code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Try again in 10 minutes.',
      );
      expect(screen.getByLabelText('Code')).toBeInTheDocument();
    });

    it('goes back to the email with "Use a different email"', async () => {
      const app = await open({
        path: '/login',
        server: signInServer({
          account: member,
          routes: { [VERIFY]: () => failure(400, 'INVALID_CODE') },
        }),
      });
      await sendCode(app, 'typo@example.com');
      await enterCode(app);
      await screen.findByRole('alert');

      await app.user.click(screen.getByRole('button', { name: 'Use a different email' }));

      const email = screen.getByLabelText('Email');
      expect(email).toHaveValue('typo@example.com');
      expect(email).toHaveFocus();
      expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(app.calls(REQUEST_CODE)).toHaveLength(1);

      await app.user.clear(email);
      await sendCode(app, EMAIL);
      expect(app.calls(REQUEST_CODE).map((request) => bodyOf(request))).toEqual([
        { email: 'typo@example.com', locale: 'en' },
        { email: EMAIL, locale: 'en' },
      ]);
      expect(screen.getByLabelText('Code')).toHaveValue('');
      expect(
        screen.getByText(`We sent a code to ${EMAIL}. Enter it below to continue.`),
      ).toBeVisible();
    });
  });

  describe('in Slovak', () => {
    const en = createI18n('en');
    const sk = createI18n('sk');

    it('translates every sentence of the flow', () => {
      for (const key of [
        'auth:title',
        'auth:flow.email',
        'auth:flow.sendCode',
        'auth:flow.code',
        'auth:flow.signIn',
        'auth:flow.sendNewCode',
        'auth:flow.differentEmail',
        'auth:flow.invalidCode',
        'auth:login.lead',
        'auth:login.noAccount',
        'auth:login.waitlist',
      ]) {
        expect(sk.t(key), key).not.toBe(en.t(key));
        expect(sk.t(key), key).not.toBe(key);
      }
      const options = { email: EMAIL };
      expect(sk.t('auth:flow.codeSent', options)).toContain(EMAIL);
      expect(sk.t('auth:flow.newCodeSent', options)).toContain(EMAIL);
    });

    it('signs in with the Slovak labels and asks for the code in Slovak', async () => {
      const app = await open({
        path: '/login',
        language: 'sk',
        server: signInServer({ account: member }),
      });

      expect(
        screen.getByRole('heading', { level: 1, name: sk.t('auth:title') }),
      ).toBeInTheDocument();
      await app.user.type(screen.getByLabelText(sk.t('auth:flow.email')), EMAIL);
      await app.user.click(screen.getByRole('button', { name: sk.t('auth:flow.sendCode') }));

      expect(bodyOf(app.calls(REQUEST_CODE)[0]!)).toEqual({ email: EMAIL, locale: 'sk' });
      expect(await screen.findByLabelText(sk.t('auth:flow.code'))).toBeInTheDocument();
      expect(screen.getByText(sk.t('auth:flow.codeSent', { email: EMAIL }))).toBeVisible();
      expect(screen.getByRole('button', { name: sk.t('auth:flow.signIn') })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: sk.t('auth:flow.sendNewCode') }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: sk.t('auth:flow.differentEmail') }),
      ).toBeInTheDocument();
    });

    it('says the wait with the Slovak plural of the minutes', async () => {
      const app = await open({
        path: '/login',
        language: 'sk',
        server: signInServer({
          account: member,
          routes: {
            [REQUEST_CODE]: () => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '125' }),
          },
        }),
      });

      await app.user.type(screen.getByLabelText(sk.t('auth:flow.email')), EMAIL);
      await app.user.click(screen.getByRole('button', { name: sk.t('auth:flow.sendCode') }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/o 3 minúty\./);
      expect(sk.t('auth:flow.rateLimited', { count: 1 })).toMatch(/o 1 minútu\./);
      expect(sk.t('auth:flow.rateLimited', { count: 5 })).toMatch(/o 5 minút\./);
    });
  });
});
