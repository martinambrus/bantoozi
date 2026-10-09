import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeMe } from '../session/fixtures.js';
import { renderApp } from '../support/app.js';
import { FAR_ZONE, printed } from '../support/zones.js';
import { T1, T2, T3, adminRoutes, unhandledGuard } from './support.js';

const guard = unhandledGuard();
const admin = makeMe({ role: 'admin', timezone: FAR_ZONE });

async function open(path: string) {
  return guard(await renderApp({ path, server: { me: admin, routes: adminRoutes() } }));
}

const momentsIn = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('time'), (time) => time.textContent);

describe('moments on the admin screens (spec 02 §1: the display time zone is a preference)', () => {
  it('is checked in a time zone that this device does not share', () => {
    expect(printed(T1, FAR_ZONE)).not.toBe(printed(T1));
    expect(printed(T2, FAR_ZONE)).not.toBe(printed(T2));
    expect(printed(T3, FAR_ZONE)).not.toBe(printed(T3));
  });

  it('prints when a user was last active and joined in the time zone of the account', async () => {
    await open('/admin/users');

    const row = await screen.findByRole('row', { name: /reader@example\.com/ });
    expect(momentsIn(row)).toEqual([printed(T1, FAR_ZONE), printed(T3, FAR_ZONE)]);
  });

  it('prints when a feed was fetched and will be again in the time zone of the account', async () => {
    await open('/admin/feeds');

    const row = await screen.findByRole('row', { name: /Example News/ });
    expect(momentsIn(row)).toEqual([printed(T1, FAR_ZONE), printed(T2, FAR_ZONE)]);
  });
});
