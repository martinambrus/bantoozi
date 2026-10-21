import type { EstimatesStatus } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatDate } from '../../src/i18n/dates.js';
import { json } from '../api/fake-fetch.js';
import { LEARNING, makeLearning } from '../learning/fixtures.js';
import { makeMe } from '../session/fixtures.js';
import { openSettings, section } from './support.js';

const TIMEZONE = 'Europe/Bratislava';
const TRAINED = '2026-10-19T09:15:00.000Z';

const estimates = (n: number): EstimatesStatus => ({
  n,
  auc: 0.7,
  trainedAt: TRAINED,
  lastRun: null,
});

async function open(
  status: EstimatesStatus | null,
  {
    language = 'en',
    preference = 'on',
  }: { language?: 'en' | 'sk'; preference?: 'on' | 'off' } = {},
) {
  const me = makeMe({
    locale: language,
    timezone: TIMEZONE,
    preferences: { estimates: preference },
  });
  const response = {
    ...makeLearning({ counts: { explicit: 23, likes: 12, dislikes: 11 } }),
    estimates: status,
  };
  await openSettings({ me, routes: { [LEARNING]: () => json(200, response) } });
  const name = language === 'en' ? 'Personal learning' : 'Osobné učenie';
  await screen.findByRole('region', { name });
  const learning = within(section(name));
  await learning.findByText(language === 'en' ? '23 of 40 ratings' : '23 z 40 hodnotení');
  return learning;
}

const date = (language: 'en' | 'sk') => formatDate(TRAINED, language, TIMEZONE);
const OFF = /switched off in Reading preferences/;

describe('the word estimates line in the personal learning section', () => {
  it('shows no estimates line and no switched-off hint without a stored model', async () => {
    const learning = await open(null);

    expect(learning.queryByText(/Word estimates/)).toBeNull();
    expect(learning.queryByText(OFF)).toBeNull();
  });

  it('shows how many ratings the estimates were trained on and when', async () => {
    const learning = await open(estimates(23));

    expect(
      await learning.findByText(
        `Word estimates are trained on 23 ratings (updated ${date('en')}).`,
      ),
    ).toBeVisible();
  });

  it('uses the singular for one rating', async () => {
    const learning = await open(estimates(1));

    expect(
      await learning.findByText(`Word estimates are trained on 1 rating (updated ${date('en')}).`),
    ).toBeVisible();
  });

  it('says the estimates are switched off when the preference is off', async () => {
    const learning = await open(estimates(23), { preference: 'off' });

    expect(await learning.findByText(OFF)).toBeVisible();
    expect(learning.getByText(/Word estimates are trained on 23 ratings/)).toBeVisible();
  });

  it('does not say they are switched off when the preference is on', async () => {
    const learning = await open(estimates(23));

    await learning.findByText(/Word estimates are trained on/);
    expect(learning.queryByText(OFF)).toBeNull();
  });

  it('shows no estimates text at all without a model when the preference is off', async () => {
    const learning = await open(null, { preference: 'off' });

    expect(learning.queryByText(/Word estimates/)).toBeNull();
    expect(learning.queryByText(OFF)).toBeNull();
  });

  it.each([
    [1, 'hodnotenie'],
    [3, 'hodnotenia'],
    [5, 'hodnotení'],
  ] as const)('declines the Slovak noun for %i ratings', async (n, noun) => {
    const learning = await open(estimates(n), { language: 'sk' });

    expect(
      await learning.findByText(
        `Odhady podľa slov sú natrénované na ${n} ${noun} (aktualizované ${date('sk')}).`,
      ),
    ).toBeVisible();
  });
});
