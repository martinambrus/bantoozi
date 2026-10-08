import { call, callJson, type MeResponse } from './support/api.js';
import { EMAILS, URLS } from './support/env.js';
import { expect, test } from './support/test.js';

test('the preview serves the login page under the production CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });

  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");

  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});

test('the preview proxies the API', async ({ request }) => {
  const response = await request.get('/api/v1/readyz');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ready' });
});

test('API sign-in gives the reader the user role and the listed admin the admin role', async ({
  api,
}) => {
  const reader = await api.login(EMAILS.reader);
  expect(await callJson<MeResponse>(reader, 'GET', '/api/v1/me')).toMatchObject({
    email: EMAILS.reader,
    role: 'user',
  });

  const admin = await api.login(EMAILS.admin);
  expect(await callJson<MeResponse>(admin, 'GET', '/api/v1/me')).toMatchObject({
    email: EMAILS.admin,
    role: 'admin',
  });
});

test('a subscribed feed reaches New without any inference call', async ({
  api,
  control,
  request,
}) => {
  const reader = await api.login(EMAILS.reader);
  const tech = await control.feed('tech');
  const titles = tech.items.map((item) => item.title).sort();
  expect(titles).toHaveLength(3);

  await test.step('the fake TypeSafe counter counts a request and resets', async () => {
    await request.get(`${URLS.fake}/count-probe`);
    expect(await control.fakeCount()).toBe(1);
    await control.reset();
    expect(await control.fakeCount()).toBe(0);
  });

  await test.step('the reader subscribes to the tech feed', async () => {
    const response = await call(reader, 'POST', '/api/v1/subscriptions', {
      data: { url: tech.url },
    });
    expect([200, 201]).toContain(response.status());
    expect(await response.json()).toHaveProperty('subscription');
  });

  await test.step('its three items reach New', async () => {
    await expect
      .poll(
        async () => {
          const list = await callJson<{ items: Array<{ title: string }> }>(
            reader,
            'GET',
            '/api/v1/articles',
            { params: { lane: 'new' } },
          );
          return list.items.map((item) => item.title);
        },
        { timeout: 30_000, intervals: [500, 1_000] },
      )
      // The specs share the run's database: articles other specs added to this feed may be there too.
      .toEqual(expect.arrayContaining(titles));
  });

  await test.step('the worker extracts the three article pages', async () => {
    await expect
      .poll(
        async () => {
          const states = await control.articleStates(tech.url);
          return states
            .filter((state) => titles.includes(state.title))
            .map((state) => `${state.title}: ${state.pipelineState}`)
            .sort();
        },
        { timeout: 30_000, intervals: [500, 1_000] },
      )
      .toEqual(titles.map((title) => `${title}: extracted`).sort());
  });

  await test.step('nothing called the fake TypeSafe server', async () => {
    expect(await control.fakeCount()).toBe(0);
  });
});

test('a browser signed in through the API opens the reader, or the wizard before onboarding', async ({
  browse,
}) => {
  const reader = await browse.as(EMAILS.reader);
  await reader.goto('/read/new');
  await expect(reader).toHaveURL(/\/read\/new$/);
  await expect(reader.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();

  const newcomer = await browse.as('newcomer@example.com', { onboarded: false });
  await newcomer.goto('/read/new');
  await expect(newcomer).toHaveURL(/\/onboarding/);
});

// What Playwright logs when a page calls `navigator.serviceWorker.register` in a context that
// blocks service workers: the only sign that the app asked for its worker.
const BLOCKED_REGISTRATION = 'Service Worker registration blocked by Playwright';

test('the smoke contexts block service workers, and the app asks for its worker without a sound', async ({
  page,
  browse,
}) => {
  const reader = await browse.as(EMAILS.reader);
  const visits = [
    { name: 'the page fixture on /login', visitor: page, path: '/login' },
    { name: 'a browse.as page on /read/new', visitor: reader, path: '/read/new' },
  ];

  for (const { name, visitor, path } of visits) {
    await test.step(name, async () => {
      const warnings: string[] = [];
      const errors: string[] = [];
      visitor.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      visitor.on('pageerror', (error) => errors.push(error.message));

      await visitor.goto(path);
      await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
      await visitor.waitForLoadState('networkidle');

      const scopes = await visitor.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map(
          (registration) => registration.scope,
        ),
      );
      expect(scopes).toEqual([]);
      await expect
        .poll(() => warnings, { message: 'the app asks for its service worker' })
        .toContain(BLOCKED_REGISTRATION);
      expect(errors).toEqual([]);
    });
  }
});
