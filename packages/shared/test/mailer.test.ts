import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createLogger,
  createMailer,
  renderEmail,
  smtpOptionsFromUrl,
} from '../src/server/index.js';

describe('mailer', () => {
  it('log transport keeps the last email (spec 08 §10 test endpoint)', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    const mailer = createMailer({
      transport: 'log',
      from: 'Bantoozi <no-reply@localhost>',
      logger,
    });
    expect(mailer.lastEmail()).toBeUndefined();
    const email = renderEmail({ kind: 'login_code', code: '482913', expiresInMinutes: 15 }, 'en');
    await mailer.send({ to: 'reader@example.com', ...email });
    expect(mailer.lastEmail()).toEqual({ to: 'reader@example.com', ...email });
    expect(lines.join('')).toContain('482913');
  });

  it('renders en and sk templates', () => {
    const en = renderEmail({ kind: 'login_code', code: '111222', expiresInMinutes: 15 }, 'en');
    const sk = renderEmail({ kind: 'login_code', code: '111222', expiresInMinutes: 15 }, 'sk');
    expect(en.subject).toBe('Your Bantoozi sign-in code');
    expect(sk.subject).toBe('Váš prihlasovací kód do Bantoozi');
    expect(sk.text).toContain('111222');
    const invite = renderEmail(
      {
        kind: 'invite',
        inviterName: 'Martin',
        link: 'https://b.example/i/ABC',
        expiresAt: new Date('2026-10-01T00:00:00Z'),
      },
      'sk',
    );
    expect(invite.text).toContain('https://b.example/i/ABC');
    expect(invite.text).toContain('2026-10-01');
    expect(
      renderEmail({ kind: 'alert', title: 'Budget 80 %', detail: 'x', firstAt: new Date(0) }, 'en')
        .subject,
    ).toBe('Bantoozi alert: Budget 80 %');
  });

  it('parses SMTP URLs with encoded credentials', () => {
    expect(smtpOptionsFromUrl('smtp://user%40x.com:p%2Fss@mail.example.com:2525')).toEqual({
      host: 'mail.example.com',
      port: 2525,
      secure: false,
      auth: { user: 'user@x.com', pass: 'p/ss' },
    });
    expect(smtpOptionsFromUrl('smtps://mail.example.com')).toEqual({
      host: 'mail.example.com',
      port: 465,
      secure: true,
    });
    expect(() => createMailer({ transport: 'smtp', from: 'x' })).toThrow(/SMTP_URL/);
  });

  it('redacts secrets in structured logs', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    logger.info(
      {
        apiKey: 'sk-live-1',
        req: { headers: { authorization: 'Bearer abc', cookie: 'bantoozi_sid=x' } },
      },
      'call',
    );
    const out = lines.join('');
    expect(out).not.toContain('sk-live-1');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('bantoozi_sid=x');
  });
});
