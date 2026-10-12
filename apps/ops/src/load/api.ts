import { randomUUID } from 'node:crypto';

/** A minimal client of the HTTP API with the headers its CSRF and idempotency checks require. */

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

const LOGIN_CODE = /\b(\d{6})\b/u;

export class ApiClient {
  cookie = '';

  constructor(
    readonly base: string,
    private readonly origin: string = base,
  ) {}

  async call<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      origin: this.origin,
      'x-bantoozi-client': 'web',
      accept: 'application/json',
    };
    if (this.cookie !== '') headers['cookie'] = this.cookie;
    if (method !== 'GET') headers['idempotency-key'] = randomUUID();
    if (body !== undefined) headers['content-type'] = 'application/json';
    // A keep-alive socket the server already closed fails the first try; the idempotency key makes
    // the retry safe.
    let response: Response | undefined;
    for (let attempt = 1; response === undefined; attempt += 1) {
      try {
        response = await fetch(`${this.base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt >= 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    const text = await response.text();
    const parsed = ((): unknown => {
      try {
        return text === '' ? null : JSON.parse(text);
      } catch {
        return text;
      }
    })();
    const setCookie = response.headers.getSetCookie();
    const session = setCookie
      .map((value) => value.split(';')[0] ?? '')
      .find((value) => value.includes('='));
    if (session !== undefined) this.cookie = session;
    return { status: response.status, body: parsed as T };
  }

  /** Like `call`, but throws unless the status is one of `expected` (default 200). */
  async expect<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    expected: readonly number[] = [200],
  ): Promise<T> {
    const result = await this.call<T>(method, path, body);
    if (!expected.includes(result.status)) {
      throw new Error(
        `${method} ${path} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`,
      );
    }
    return result.body;
  }

  /** Signs `email` in (open signup creates it): code request, the test mail log, verification. */
  async login(email: string): Promise<void> {
    await this.expect('POST', '/api/v1/auth/request-code', { email, locale: 'en' }, [202]);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const mail = await this.expect<{ email: { to: string; text: string } | null }>(
        'GET',
        '/api/v1/dev/last-email',
      );
      if (mail.email !== null && mail.email.to.toLowerCase() === email.toLowerCase()) {
        const code = LOGIN_CODE.exec(mail.email.text)?.[1];
        if (code === undefined) throw new Error(`the sign-in mail to ${email} carries no code`);
        await this.expect('POST', '/api/v1/auth/verify', { email, code });
        return;
      }
      if (Date.now() > deadline) throw new Error(`no sign-in mail for ${email}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
