import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeMe } from '../session/fixtures.js';
import { openSettings, section } from './support.js';

const planInfo = {
  label: 'Beta',
  labelSk: 'Beta SK',
  releaseIntervalS: 900,
  minFetchIntervalS: 900,
  nextUpdateAt: '2026-10-16T10:45:00.000Z',
};

describe('the account plan', () => {
  it('shows its cadence and the next release in the account time zone', async () => {
    await openSettings({ me: makeMe({ timezone: 'Europe/Bratislava', planInfo }) });
    const plan = within(section('Your plan'));
    expect(plan.getByText('Beta plan')).toBeVisible();
    expect(plan.getByText('New articles every 15 minutes')).toBeVisible();
    expect(plan.getByText(/Next update at 12:45/)).toBeVisible();
  });
  it('localizes the label and interval in Slovak', async () => {
    await openSettings({ me: makeMe({ locale: 'sk', planInfo }) });
    const plan = within(section('Váš plán'));
    expect(plan.getByText('Plán Beta SK')).toBeVisible();
    expect(plan.getByText('Interval nových článkov: 15 minút')).toBeVisible();
  });
});
