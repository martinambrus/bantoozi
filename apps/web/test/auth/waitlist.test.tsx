import { INVITE_NOTE_MAX_LENGTH } from '@bantoozi/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../src/i18n/index.js';
import { failure, json } from '../api/fake-fetch.js';
import { bodyOf, type FakeServer } from '../support/app.js';
import { EMAIL, createHarness } from './harness.js';

const WAITLIST = 'POST /waitlist';

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

function waitlistServer(
  answer: () => Response | Promise<Response> = () => json(202, { next: 'waitlisted' }),
): FakeServer {
  return { me: null, routes: { [WAITLIST]: answer } };
}

async function join(app: App, options: { email?: string; note?: string } = {}) {
  await app.user.type(screen.getByLabelText('Email'), options.email ?? EMAIL);
  if (options.note !== undefined) {
    await app.user.type(screen.getByLabelText('Note (optional)'), options.note);
  }
  await app.user.click(screen.getByRole('button', { name: 'Join the waitlist' }));
}

describe('/waitlist', () => {
  it('asks for the email and an optional note', async () => {
    await open({ path: '/waitlist', server: waitlistServer() });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Request an invite');
    expect(screen.getByText(/invite-only/)).toBeVisible();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toBeRequired();
    const note = screen.getByLabelText('Note (optional)');
    expect(note.tagName).toBe('TEXTAREA');
    expect(note).not.toBeRequired();
    expect(screen.getByRole('button', { name: 'Join the waitlist' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('enforces the length limit of the note', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });
    const note = screen.getByLabelText('Note (optional)');
    expect(note).toHaveAttribute('maxlength', String(INVITE_NOTE_MAX_LENGTH));

    await app.user.click(note);
    await app.user.paste('x'.repeat(INVITE_NOTE_MAX_LENGTH + 100));

    expect((note as HTMLTextAreaElement).value).toHaveLength(INVITE_NOTE_MAX_LENGTH);
    expect(note).toHaveAccessibleDescription(`Up to ${INVITE_NOTE_MAX_LENGTH} characters.`);
  });

  it('sends the email and the locale, without a note when none was given', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });

    await join(app);

    const requests = app.calls(WAITLIST);
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ email: EMAIL, locale: 'en' });
    expect(requests[0]!.headers.has('Idempotency-Key')).toBe(false);
  });

  it('sends the note when there is one', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });

    await join(app, { note: '  I read a lot of Slovak news.  ' });

    expect(bodyOf(app.calls(WAITLIST)[0]!)).toEqual({
      email: EMAIL,
      locale: 'en',
      note: 'I read a lot of Slovak news.',
    });
  });

  it('leaves out a note that is only spaces', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });

    await join(app, { note: '   ' });

    expect(bodyOf(app.calls(WAITLIST)[0]!)).toEqual({ email: EMAIL, locale: 'en' });
  });

  it('sends nothing without a valid email', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });

    await join(app, { email: 'not an email' });

    expect(app.calls(WAITLIST)).toHaveLength(0);
    expect(screen.getByLabelText('Email')).toBeInvalid();
  });

  it('confirms without saying anything about the address being known', async () => {
    const app = await open({ path: '/waitlist', server: waitlistServer() });

    await join(app, { note: 'Hello' });

    const confirmation = await screen.findByRole('heading', { name: "You're on the waitlist" });
    expect(confirmation).toHaveFocus();
    expect(screen.getByText(`We'll email ${EMAIL} when your invite is ready.`)).toBeVisible();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeInTheDocument();
    expect(confirmation.parentElement).not.toHaveTextContent(/already|again|existing|known/i);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('shows the wait when the server limits the requests', async () => {
    const app = await open({
      path: '/waitlist',
      server: waitlistServer(() =>
        failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '2700' }),
      ),
    });

    await join(app, { note: 'Please' });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 45 minutes.',
    );
    expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Please');
    expect(screen.getByRole('button', { name: 'Join the waitlist' })).toBeEnabled();
  });

  it('shows the sentence for any other error and lets the visitor try again', async () => {
    let attempts = 0;
    const app = await open({
      path: '/waitlist',
      server: waitlistServer(() =>
        ++attempts === 1 ? failure(500, 'INTERNAL') : json(202, { next: 'waitlisted' }),
      ),
    });
    await join(app);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );

    await app.user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    await screen.findByRole('heading', { name: "You're on the waitlist" });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(app.calls(WAITLIST)).toHaveLength(2);
  });

  it('disables the button while the request runs', async () => {
    let release: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await open({
      path: '/waitlist',
      server: waitlistServer(async () => {
        await opened;
        return json(202, { next: 'waitlisted' });
      }),
    });

    await join(app);

    const button = screen.getByRole('button', { name: 'Join the waitlist' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    release();
    await screen.findByRole('heading', { name: "You're on the waitlist" });
    expect(app.calls(WAITLIST)).toHaveLength(1);
  });

  it('confirms the address that was sent when the field changed meanwhile', async () => {
    let release: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await open({
      path: '/waitlist',
      server: waitlistServer(async () => {
        await opened;
        return json(202, { next: 'waitlisted' });
      }),
    });
    await join(app);

    await app.user.type(screen.getByLabelText('Email'), '.uk');
    release();

    await screen.findByRole('heading', { name: "You're on the waitlist" });
    expect(screen.getByText(`We'll email ${EMAIL} when your invite is ready.`)).toBeVisible();
    expect(bodyOf(app.calls(WAITLIST)[0]!)).toMatchObject({ email: EMAIL });
  });

  it('is in Slovak for a Slovak browser', async () => {
    const en = createI18n('en');
    const sk = createI18n('sk');
    for (const key of [
      'auth:waitlist.title',
      'auth:waitlist.lead',
      'auth:waitlist.note',
      'auth:waitlist.noteHint',
      'auth:waitlist.submit',
      'auth:waitlist.doneTitle',
      'auth:waitlist.doneBody',
      'auth:waitlist.haveAccount',
      'auth:waitlist.signIn',
    ]) {
      expect(sk.t(key, { max: 500, email: EMAIL }), key).not.toBe(
        en.t(key, { max: 500, email: EMAIL }),
      );
      expect(sk.t(key), key).not.toBe(key);
    }

    const app = await open({
      path: '/waitlist',
      language: 'sk',
      server: waitlistServer(),
    });
    expect(
      screen.getByRole('heading', { level: 1, name: sk.t('auth:waitlist.title') }),
    ).toBeInTheDocument();
    await app.user.type(screen.getByLabelText(sk.t('auth:flow.email')), EMAIL);
    await app.user.click(screen.getByRole('button', { name: sk.t('auth:waitlist.submit') }));

    expect(bodyOf(app.calls(WAITLIST)[0]!)).toEqual({ email: EMAIL, locale: 'sk' });
    expect(
      await screen.findByRole('heading', { name: sk.t('auth:waitlist.doneTitle') }),
    ).toBeInTheDocument();
    expect(screen.getByText(sk.t('auth:waitlist.doneBody', { email: EMAIL }))).toBeVisible();
  });
});
