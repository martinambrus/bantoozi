import {
  EmailSchema,
  RequestedLocaleSchema,
  normalizeEmail,
  normalizeInviteCode,
} from '@bantoozi/shared';
import { escapeHtml, renderEmail } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import {
  digestsEqual,
  emailBucketKey,
  loginCodeDigest,
  newLoginCode,
  preferredLocale,
} from '../src/services/auth.js';

/** Pure helpers of M4-T2 (spec 08 §2.1–2.2). */

const PEPPER = 'unit-pepper-0123456789abcdef0123456789abcdef';
const NONCE = '0190a6f2-1111-7000-8000-000000000001';

describe('login codes', () => {
  it('are 6 CSPRNG digits', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = newLoginCode();
      expect(code).toMatch(/^\d{6}$/);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(190);
  });

  it('digest binds nonce, email and code with an unambiguous encoding', () => {
    const base = { challengeNonce: NONCE, email: 'a@example.test', code: '123456' };
    const digest = loginCodeDigest(PEPPER, base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(loginCodeDigest(PEPPER, base)).toBe(digest);
    expect(loginCodeDigest(PEPPER, { ...base, code: '123457' })).not.toBe(digest);
    expect(loginCodeDigest(PEPPER, { ...base, email: 'b@example.test' })).not.toBe(digest);
    expect(loginCodeDigest(PEPPER, { ...base, challengeNonce: NONCE.replace(/1$/, '2') })).not.toBe(
      digest,
    );
    expect(loginCodeDigest(`${PEPPER}x`, base)).not.toBe(digest);
    // Shifting characters between fields changes the digest (no concatenation ambiguity).
    expect(loginCodeDigest(PEPPER, { ...base, email: 'a@example.test1', code: '23456' })).not.toBe(
      digest,
    );
    expect(digest).not.toContain('123456');
  });

  it('compares digests in constant time and refuses malformed input', () => {
    const d = loginCodeDigest(PEPPER, { challengeNonce: NONCE, email: 'a@x.test', code: '000000' });
    expect(digestsEqual(d, d)).toBe(true);
    expect(digestsEqual(d, d.replace(/.$/, d.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(digestsEqual(d, d.slice(0, 62))).toBe(false);
    expect(digestsEqual('', '')).toBe(false);
  });

  it('keys the per-email throttle by a keyed hash, never the address', () => {
    const key = emailBucketKey(PEPPER, 'a@example.test');
    expect(key).toMatch(/^auth-request-code:email:[0-9a-f]{64}$/);
    expect(key).not.toContain('example');
    expect(emailBucketKey(PEPPER, 'b@example.test')).not.toBe(key);
  });
});

describe('emails, locales and invite codes', () => {
  it('normalizes emails like citext without provider rewriting', () => {
    expect(normalizeEmail('  John.Doe+News@Example.COM ')).toBe('john.doe+news@example.com');
    expect(EmailSchema.parse(' A.B+c@Example.test ')).toBe('a.b+c@example.test');
    expect(EmailSchema.safeParse('not-an-email').success).toBe(false);
    expect(EmailSchema.safeParse(`${'a'.repeat(64)}@${'b'.repeat(186)}.test`).success).toBe(false);
  });

  it('maps requested locales to en/sk with fallback en', () => {
    expect(RequestedLocaleSchema.parse('sk')).toBe('sk');
    expect(RequestedLocaleSchema.parse('SK-sk')).toBe('sk');
    expect(RequestedLocaleSchema.parse('en-GB')).toBe('en');
    expect(RequestedLocaleSchema.parse('de')).toBe('en');
    expect(RequestedLocaleSchema.safeParse('<script>').success).toBe(false);
  });

  it('picks the preferred supported Accept-Language', () => {
    expect(preferredLocale(undefined)).toBe('en');
    expect(preferredLocale('sk-SK,sk;q=0.9,en;q=0.8')).toBe('sk');
    expect(preferredLocale('de-DE,en;q=0.5,sk;q=0.7')).toBe('sk');
    expect(preferredLocale('en, sk')).toBe('en');
    expect(preferredLocale('sk;q=0, en;q=0.1')).toBe('en');
    expect(preferredLocale('fr, de')).toBe('en');
    expect(preferredLocale('skx')).toBe('en');
  });

  it('normalizes typed invite codes with Crockford decoding', () => {
    expect(normalizeInviteCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeInviteCode(' 0o1il23456 ')).toBe('0011123456');
    expect(normalizeInviteCode('ABCDEFGHJ')).toBeNull();
    expect(normalizeInviteCode('ABCDEFGHJU')).toBeNull();
    expect(normalizeInviteCode('ABCDEFGHJKL')).toBeNull();
  });
});

describe('email templates (spec 08 §2.1: en/sk, plain text and HTML)', () => {
  const templates = [
    { kind: 'login_code', code: '123456', expiresInMinutes: 10 },
    { kind: 'signup_code', code: '123456', expiresInMinutes: 10 },
    { kind: 'invite_only', waitlistUrl: 'https://b.example/waitlist' },
    {
      kind: 'invite',
      inviterName: null,
      link: 'https://b.example/join?code=ABCDEFGHJK',
      expiresAt: new Date('2026-10-31T00:00:00Z'),
    },
    { kind: 'alert', title: 'Budget', detail: 'Spend at 80 %', firstAt: new Date(0) },
  ] as const;

  it('renders every template in both locales with both parts', () => {
    for (const template of templates) {
      const en = renderEmail(template, 'en');
      const sk = renderEmail(template, 'sk');
      expect(en.subject).not.toBe(sk.subject);
      for (const email of [en, sk]) {
        expect(email.text.length).toBeGreaterThan(0);
        expect(email.html).toMatch(/^<!doctype html>/);
        if ('code' in template) {
          expect(email.text).toContain(template.code);
          expect(email.html).toContain(template.code);
        }
      }
    }
    expect(renderEmail(templates[2], 'en').subject).toBe('Bantoozi is invite-only');
    expect(renderEmail(templates[2], 'en').html).toContain('href="https://b.example/waitlist"');
    expect(renderEmail(templates[3], 'sk').html).toContain(
      'href="https://b.example/join?code=ABCDEFGHJK"',
    );
  });

  it('escapes every interpolation in the HTML part', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    const invite = renderEmail(
      {
        kind: 'invite',
        inviterName: '<img src=x onerror=alert(1)>',
        link: 'https://b.example/join?code=A"><script>',
        expiresAt: new Date('2026-10-31T00:00:00Z'),
      },
      'en',
    );
    expect(invite.html).not.toContain('<img');
    expect(invite.html).not.toContain('<script>');
    expect(invite.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const alert = renderEmail(
      { kind: 'alert', title: '<b>t</b>', detail: '<i>d</i>', firstAt: new Date(0) },
      'en',
    );
    expect(alert.html).not.toMatch(/<b>|<i>/);
  });
});
