import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../src/i18n/index.js';
import { failure } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { CODE, EMAIL, createHarness, signInServer } from './harness.js';

const REQUEST_CODE = 'POST /auth/request-code';
const VERIFY = 'POST /auth/verify';

const newcomer = makeMe({ email: EMAIL, preferences: { onboardingCompletedAt: null } });

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

async function sendCode(app: App) {
  await app.user.type(screen.getByLabelText('Email'), EMAIL);
  await app.user.click(screen.getByRole('button', { name: 'Send code' }));
  return screen.findByLabelText('Code');
}

describe('/join', () => {
  it('explains that Bantoozi is invite-only and shows the invite code of the link', async () => {
    await open({ path: '/join?code=ABC123', server: signInServer({ account: newcomer }) });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Join Bantoozi');
    expect(screen.getByText(/invite-only/)).toBeVisible();
    const invite = screen.getByLabelText('Invite code');
    expect(invite).toHaveValue('ABC123');
    expect(invite).toBeRequired();
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('links existing accounts to /login and everyone else to the waitlist', async () => {
    await open({ path: '/join?code=ABC123', server: signInServer({ account: newcomer }) });

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Join the waitlist' })).toHaveAttribute(
      'href',
      '/waitlist',
    );
  });

  it('sends the invite code with the request and signs the new account in', async () => {
    const app = await open({
      path: '/join?code=ABC123',
      server: signInServer({ account: newcomer }),
    });

    const code = await sendCode(app);

    const requests = app.calls(REQUEST_CODE);
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ email: EMAIL, inviteCode: 'ABC123', locale: 'en' });
    expect(requests[0]!.headers.has('Idempotency-Key')).toBe(false);
    expect(
      screen.getByText(`We sent a code to ${EMAIL}. Enter it below to continue.`),
    ).toBeVisible();
    expect(screen.queryByLabelText('Invite code')).not.toBeInTheDocument();
    expect(code).toHaveFocus();

    await app.user.type(code, '123 456');
    await app.user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/onboarding'));
    expect(app.calls(VERIFY).map((request) => bodyOf(request))).toEqual([
      { email: EMAIL, code: CODE },
    ]);
  });

  it('sends the invite code again with a new code, and keeps it when going back', async () => {
    const app = await open({
      path: '/join?code=ABC123',
      server: signInServer({ account: newcomer }),
    });
    await sendCode(app);

    await app.user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await screen.findByText(`We sent a new code to ${EMAIL}.`);
    await app.user.click(screen.getByRole('button', { name: 'Use a different email' }));

    expect(screen.getByLabelText('Invite code')).toHaveValue('ABC123');
    expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
    expect(app.calls(REQUEST_CODE).map((request) => bodyOf(request))).toEqual([
      { email: EMAIL, inviteCode: 'ABC123', locale: 'en' },
      { email: EMAIL, inviteCode: 'ABC123', locale: 'en' },
    ]);
  });

  it('lets the visitor correct the invite code before sending', async () => {
    const app = await open({
      path: '/join?code=ABC123',
      server: signInServer({ account: newcomer }),
    });

    await app.user.clear(screen.getByLabelText('Invite code'));
    await app.user.type(screen.getByLabelText('Invite code'), '  ZZ99  ');
    await sendCode(app);

    expect(bodyOf(app.calls(REQUEST_CODE)[0]!)).toEqual({
      email: EMAIL,
      inviteCode: 'ZZ99',
      locale: 'en',
    });
  });

  describe('without a code in the link', () => {
    it('asks for the invite code, which is required', async () => {
      const app = await open({ path: '/join', server: signInServer({ account: newcomer }) });

      const invite = screen.getByLabelText('Invite code');
      expect(invite).toHaveValue('');
      expect(invite).toBeRequired();

      await app.user.type(screen.getByLabelText('Email'), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Send code' }));

      expect(app.calls(REQUEST_CODE)).toHaveLength(0);
      expect(invite).toBeInvalid();
      expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    });

    it('sends the invite code the visitor typed', async () => {
      const app = await open({ path: '/join', server: signInServer({ account: newcomer }) });

      await app.user.type(screen.getByLabelText('Invite code'), 'K7M2P9X4QA');
      await sendCode(app);

      expect(bodyOf(app.calls(REQUEST_CODE)[0]!)).toEqual({
        email: EMAIL,
        inviteCode: 'K7M2P9X4QA',
        locale: 'en',
      });
    });
  });

  it('shows the errors of the flow like /login does', async () => {
    const app = await open({
      path: '/join?code=ABC123',
      server: signInServer({
        account: newcomer,
        routes: {
          [REQUEST_CODE]: () => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '3000' }),
        },
      }),
    });

    await app.user.type(screen.getByLabelText('Email'), EMAIL);
    await app.user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 50 minutes.',
    );
    expect(screen.getByLabelText('Invite code')).toHaveValue('ABC123');
  });

  it('is in Slovak for a Slovak browser', async () => {
    const en = createI18n('en');
    const sk = createI18n('sk');
    for (const key of [
      'auth:join.title',
      'auth:join.lead',
      'auth:flow.inviteCode',
      'auth:join.haveAccount',
      'auth:join.signIn',
      'auth:join.noInvite',
      'auth:join.waitlist',
    ]) {
      expect(sk.t(key), key).not.toBe(en.t(key));
      expect(sk.t(key), key).not.toBe(key);
    }

    const app = await open({
      path: '/join?code=ABC123',
      language: 'sk',
      server: signInServer({ account: newcomer }),
    });

    expect(
      screen.getByRole('heading', { level: 1, name: sk.t('auth:join.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(sk.t('auth:join.lead'))).toBeVisible();
    expect(screen.getByLabelText(sk.t('auth:flow.inviteCode'))).toHaveValue('ABC123');
    await app.user.type(screen.getByLabelText(sk.t('auth:flow.email')), EMAIL);
    await app.user.click(screen.getByRole('button', { name: sk.t('auth:flow.sendCode') }));

    expect(bodyOf(app.calls(REQUEST_CODE)[0]!)).toEqual({
      email: EMAIL,
      inviteCode: 'ABC123',
      locale: 'sk',
    });
  });
});
