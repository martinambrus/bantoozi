import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createI18n } from '../../src/i18n/index.js';
import { makeMe } from '../session/fixtures.js';
import { createHarness, signInServer } from './harness.js';

const { open } = createHarness();

describe('/login privacy link (spec 11 §7)', () => {
  it('links to the static /privacy page in English', async () => {
    await open({ path: '/login', server: signInServer({ account: makeMe() }) });
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  });

  it('links to the Slovak /privacy page text in Slovak', async () => {
    const sk = createI18n('sk');
    await open({
      path: '/login',
      language: 'sk',
      server: signInServer({ account: makeMe() }),
    });
    const name = sk.t('auth:login.privacy');
    expect(name).not.toBe('Privacy');
    expect(name).not.toBe('auth:login.privacy');
    const link = screen.getByRole('link', { name });
    expect(link.getAttribute('href')).toMatch(/^\/privacy(\/sk\/)?$/);
  });
});
