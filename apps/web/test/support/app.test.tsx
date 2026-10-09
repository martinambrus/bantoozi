import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, createFakeServer, renderApp } from './app.js';

describe('renderApp', () => {
  it('sends a signed-out visitor to the login screen', async () => {
    const app = await renderApp({ path: '/read/maybe', server: { me: null, routes: {} } });
    expect(app.router.state.location.pathname).toBe('/login');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders an admin screen for an admin', async () => {
    const app = await renderApp({
      path: '/admin',
      server: { me: makeMe({ role: 'admin' }), routes: {} },
    });
    expect(app.router.state.location.pathname).toBe('/admin');
    expect(app.router.state.matches.some((match) => match.status === 'notFound')).toBe(false);
  });

  it('dispatches operations by pattern and records unhandled ones', async () => {
    const fake = createFakeServer({
      me: makeMe(),
      routes: { 'POST /articles/:id/rating': (_request, params) => json(200, params) },
    });
    const answered = await fake.handler({
      url: '/api/v1/articles/42/rating',
      pathname: '/api/v1/articles/42/rating',
      query: new URLSearchParams(),
      method: 'POST',
      headers: new Headers(),
      body: '{"rating":1}',
      signal: null,
      keepalive: undefined,
      credentials: 'same-origin',
    });
    expect(await answered.json()).toEqual({ id: '42' });
    const missing = await fake.handler({
      url: '/api/v1/labels',
      pathname: '/api/v1/labels',
      query: new URLSearchParams(),
      method: 'GET',
      headers: new Headers(),
      body: null,
      signal: null,
      keepalive: undefined,
      credentials: 'same-origin',
    });
    expect(missing.status).toBe(404);
    expect(fake.unhandled).toEqual(['GET /labels']);
    expect(bodyOf({ body: '{"a":1}' } as never)).toEqual({ a: 1 });
  });
});
