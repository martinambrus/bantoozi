import { loadConfig } from '@bantoozi/shared/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { clearSessionCookie, setSessionCookie } from '../src/plugins/auth.js';

/** Spec 08 §1/§2.1: the session cookie is Secure in production (the config the code reads). */

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://bantoozi_app:pw@db:5432/bantoozi',
  SESSION_PEPPER: 'prod-session-pepper-0123456789abcdef0123456789',
  PUBLIC_BASE_URL: 'https://bantoozi.example.com',
  MAIL_TRANSPORT: 'smtp',
  SMTP_URL: 'smtp://user:pw@mail.example.com:587',
  TYPESAFE_MODEL: 'jev-1.13.0',
};

async function cookieFor(env: Record<string, string>): Promise<string> {
  const config = loadConfig({ process: 'api', env });
  const app = Fastify({ logger: false });
  app.get('/set', (_request, reply) => {
    const now = new Date('2026-10-11T00:00:00Z');
    setSessionCookie(reply, config, 'tok', new Date(now.getTime() + 60 * 86_400_000), now);
    return reply.send({});
  });
  app.get('/clear', (_request, reply) => {
    void reply.header('set-cookie', clearSessionCookie(config));
    return reply.send({});
  });
  const res = await app.inject({ method: 'GET', url: '/set' });
  const cleared = await app.inject({ method: 'GET', url: '/clear' });
  await app.close();
  return `${String(res.headers['set-cookie'])}\n${String(cleared.headers['set-cookie'])}`;
}

describe('session cookie attributes', () => {
  it('has Secure, HttpOnly, SameSite=Lax, Path=/ and a sliding Max-Age in production', async () => {
    const [set, cleared] = (await cookieFor(PRODUCTION_ENV)).split('\n') as [string, string];
    for (const cookie of [set, cleared]) {
      expect(cookie).toMatch(/^bantoozi_sid=/);
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    }
    expect(set).toContain('Max-Age=5184000');
    expect(cleared).toContain('Max-Age=0');
  });

  it('has no Secure outside production (plain-http local development)', async () => {
    const cookie = await cookieFor({
      ...PRODUCTION_ENV,
      NODE_ENV: 'development',
      MAIL_TRANSPORT: 'log',
    });
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });
});
