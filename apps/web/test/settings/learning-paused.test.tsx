import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatDateTime } from '../../src/i18n/dates.js';
import { json } from '../api/fake-fetch.js';
import { LEARNING, makeLearning } from '../learning/fixtures.js';
import { makeMe } from '../session/fixtures.js';
import { openSettings, section } from './support.js';

const TIMEZONE = 'Europe/Bratislava';
const SINCE = '2026-10-17T08:30:00.000Z';

type Classification = {
  state: 'ok' | 'paused';
  since: string | null;
  reason: 'engine_unavailable' | 'model_upgrade' | null;
};

const paused = (
  reason: 'engine_unavailable' | 'model_upgrade',
  since: string | null = SINCE,
): Classification => ({ state: 'paused', since, reason });

const COUNTS = { en: '23 of 40 ratings', sk: '23 z 40 hodnotení' } as const;

async function open(response: unknown, language: 'en' | 'sk' = 'en') {
  const me = makeMe({ locale: language, timezone: TIMEZONE });
  await openSettings({ me, routes: { [LEARNING]: () => json(200, response) } });
  const name = language === 'en' ? 'Personal learning' : 'Osobné učenie';
  await screen.findByRole('region', { name });
  const learning = within(section(name));
  await learning.findByText(COUNTS[language]);
  return learning;
}

const withClassification = (classification: Classification) => ({
  ...makeLearning({ counts: { explicit: 23, likes: 12, dislikes: 11 } }),
  classification,
});

const date = (language: 'en' | 'sk') => formatDateTime(SINCE, language, TIMEZONE);

const SENTENCES = {
  en: {
    engine: (d: string) =>
      `Analysis paused since ${d}. Your ratings are kept and analysed when it resumes.`,
    engineNoDate: 'Analysis is paused. Your ratings are kept and analysed when it resumes.',
    upgrade: (d: string) =>
      `Analysis is catching up after an update (since ${d}). Your ratings are kept and analysed when it finishes.`,
    upgradeNoDate:
      'Analysis is catching up after an update. Your ratings are kept and analysed when it finishes.',
  },
  sk: {
    engine: (d: string) =>
      `Analýza je pozastavená od ${d}. Vaše hodnotenia sa uchovajú a analyzujú sa po obnovení.`,
    engineNoDate: 'Analýza je pozastavená. Vaše hodnotenia sa uchovajú a analyzujú sa po obnovení.',
    upgrade: (d: string) =>
      `Analýza po aktualizácii dobieha (od ${d}). Vaše hodnotenia sa uchovajú a analyzujú sa po dokončení.`,
    upgradeNoDate:
      'Analýza po aktualizácii dobieha. Vaše hodnotenia sa uchovajú a analyzujú sa po dokončení.',
  },
} as const;

describe('the paused-analysis notice in the personal learning section', () => {
  it('shows the English engine sentence with the date as a status element', async () => {
    const learning = await open(withClassification(paused('engine_unavailable')));

    const notice = await learning.findByRole('status');
    expect(notice).toHaveTextContent(SENTENCES.en.engine(date('en')));
    expect(notice).toBeVisible();
  });

  it('shows the Slovak engine sentence with the date in the Osobné učenie section', async () => {
    const learning = await open(withClassification(paused('engine_unavailable')), 'sk');

    const notice = await learning.findByRole('status');
    expect(notice).toHaveTextContent(SENTENCES.sk.engine(date('sk')));
    expect(notice).toBeVisible();
  });

  it('shows the English model upgrade sentence with the date', async () => {
    const learning = await open(withClassification(paused('model_upgrade')));

    expect(await learning.findByRole('status')).toHaveTextContent(SENTENCES.en.upgrade(date('en')));
  });

  it('shows the Slovak model upgrade sentence with the date', async () => {
    const learning = await open(withClassification(paused('model_upgrade')), 'sk');

    expect(await learning.findByRole('status')).toHaveTextContent(SENTENCES.sk.upgrade(date('sk')));
  });

  it.each([
    ['en', 'engine_unavailable', SENTENCES.en.engineNoDate],
    ['en', 'model_upgrade', SENTENCES.en.upgradeNoDate],
    ['sk', 'engine_unavailable', SENTENCES.sk.engineNoDate],
    ['sk', 'model_upgrade', SENTENCES.sk.upgradeNoDate],
  ] as const)(
    'shows the %s %s sentence without a date when since is null',
    async (language, reason, text) => {
      const learning = await open(withClassification(paused(reason, null)), language);

      expect(await learning.findByRole('status')).toHaveTextContent(text);
    },
  );

  it('shows no paused sentence and still shows the counts when the state is ok', async () => {
    const learning = await open(withClassification({ state: 'ok', since: null, reason: null }));

    expect(await learning.findByText('23 of 40 ratings')).toBeVisible();
    expect(learning.queryAllByRole('status')).toEqual([]);
    expect(learning.queryByText(/Analysis (is )?paused/)).toBeNull();
    expect(learning.queryByText(/catching up after an update/)).toBeNull();
  });

  it('renders the section normally when the response has no classification key', async () => {
    const response = Object.fromEntries(
      Object.entries(makeLearning({ counts: { explicit: 23, likes: 12, dislikes: 11 } })).filter(
        ([key]) => key !== 'classification',
      ),
    );
    expect(response).not.toHaveProperty('classification');
    expect(response).toHaveProperty('feeds');
    const learning = await open(response);

    expect(await learning.findByText('23 of 40 ratings')).toBeVisible();
    expect(learning.queryByRole('alert')).toBeNull();
    expect(learning.queryByText(/Analysis (is )?paused/)).toBeNull();
    expect(learning.queryByText(/catching up after an update/)).toBeNull();
    expect(learning.queryAllByRole('status')).toEqual([]);
  });

  it('places the notice above the counts in document order', async () => {
    const learning = await open(withClassification(paused('engine_unavailable')));

    const notice = await learning.findByRole('status');
    const counts = await learning.findByText('23 of 40 ratings');
    expect(notice.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
