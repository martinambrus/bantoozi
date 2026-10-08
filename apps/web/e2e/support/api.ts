import type { APIRequest, APIRequestContext, APIResponse } from '@playwright/test';

import { URLS } from './env.js';

/**
 * The HTTP API as the PWA sees it: requests go to the preview server's origin, which proxies
 * `/api`, with the headers the API's CSRF and idempotency checks require (spec 08 §1).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOptions {
  /** JSON request body. */
  data?: unknown;
  params?: Record<string, string | number | boolean>;
  /** A mutation gets a fresh UUID unless one is given. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface MeResponse {
  id: string;
  email: string;
  role: 'user' | 'admin';
  [key: string]: unknown;
}

/** What the `playwright` fixture offers for HTTP-only contexts. */
export interface PlaywrightRequest {
  request: APIRequest;
}

const LOGIN_CODE = /\b(\d{6})\b/;
const LAST_EMAIL_TIMEOUT_MS = 10_000;
const LAST_EMAIL_INTERVAL_MS = 200;

/** A context without a session; relative URLs resolve against the preview origin. */
export function newApiContext(playwright: PlaywrightRequest): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: URLS.app });
}

/**
 * One API request with `Origin`, `X-Bantoozi-Client` and, for anything but a read, an
 * `Idempotency-Key`. Returns the response whatever its status.
 */
export function call(
  request: APIRequestContext,
  method: HttpMethod,
  path: string,
  options: CallOptions = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    origin: URLS.app,
    'x-bantoozi-client': 'web',
    ...(method === 'GET'
      ? {}
      : { 'idempotency-key': options.idempotencyKey ?? crypto.randomUUID() }),
    ...options.headers,
  };
  return request.fetch(path, {
    method,
    headers,
    failOnStatusCode: false,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.params === undefined ? {} : { params: options.params }),
  });
}

/** Like {@link call}, but fails unless the answer is `expected` and returns the decoded JSON body. */
export async function callJson<T>(
  request: APIRequestContext,
  method: HttpMethod,
  path: string,
  options: CallOptions & { expected?: number } = {},
): Promise<T> {
  const { expected = 200, ...rest } = options;
  const response = await call(request, method, path, rest);
  if (response.status() !== expected) {
    throw new Error(
      `${method} ${path} answered ${response.status()} instead of ${expected}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function loginCodeFor(request: APIRequestContext, email: string): Promise<string> {
  const deadline = Date.now() + LAST_EMAIL_TIMEOUT_MS;
  let seen = 'no mail yet';
  for (;;) {
    const body = await callJson<{ email: { to: string; subject: string; text: string } | null }>(
      request,
      'GET',
      '/api/v1/dev/last-email',
    );
    if (body.email !== null) {
      seen = `a mail to ${body.email.to}`;
      if (body.email.to.toLowerCase() === email.toLowerCase()) {
        const code = LOGIN_CODE.exec(body.email.text)?.[1];
        if (code === undefined) throw new Error(`the mail to ${email} carries no 6-digit code`);
        return code;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`no sign-in mail for ${email} within ${LAST_EMAIL_TIMEOUT_MS} ms (${seen})`);
    }
    await new Promise((resolve) => setTimeout(resolve, LAST_EMAIL_INTERVAL_MS));
  }
}

/**
 * Signs `email` in through the API (code request, the mail log endpoint of the test environment,
 * verification) and returns the context holding the session cookie. Open signup creates the
 * account on first use. The caller disposes the context.
 */
export async function apiLogin(
  playwright: PlaywrightRequest,
  email: string,
): Promise<APIRequestContext> {
  const request = await newApiContext(playwright);
  try {
    await callJson<unknown>(request, 'POST', '/api/v1/auth/request-code', {
      data: { email, locale: 'en' },
      expected: 202,
    });
    const code = await loginCodeFor(request, email);
    await callJson<unknown>(request, 'POST', '/api/v1/auth/verify', {
      data: { email, code },
    });
    return request;
  } catch (error) {
    await request.dispose();
    throw error;
  }
}
