import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeFetch, json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main.tsx', () => {
  // The module runs when imported and the history it patches is global, so it boots once per file.
  it('boots into the screen of the signed-in account, in its language', async () => {
    const me = makeMe({ locale: 'sk', preferences: { onboardingCompletedAt: null } });
    const api = fakeFetch(() => json(200, me));
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, '', '/onboarding');
    vi.stubGlobal('fetch', api.fetch);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await import('../../src/main.js');

    expect(await screen.findByRole('heading')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/onboarding');
    expect(api.requests.map((request) => request.url)).toContain('/api/v1/me');
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('sk'));
  });
});
