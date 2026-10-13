import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeMe } from '../session/fixtures.js';
import { LEARNING, makeLearning } from '../learning/fixtures.js';
import { json } from '../api/fake-fetch.js';
import { openSettings, section } from './support.js';

const learning = () => within(section('Personal learning'));

async function open(
  model: Parameters<typeof makeLearning>[0],
  me = makeMe({ timezone: 'Europe/Bratislava' }),
) {
  await openSettings({ me, routes: { [LEARNING]: () => json(200, makeLearning(model)) } });
  await screen.findByText(/ratings$/);
}

describe('the personal learning section', () => {
  it('says what switches the model on and how far the ratings are', async () => {
    await open({ counts: { explicit: 23, likes: 12, dislikes: 11 } });

    expect(learning().getByText(/switches on by itself/)).toBeVisible();
    expect(learning().getByText('23 of 40 ratings')).toBeVisible();
    expect(learning().getByText('12 of 10 likes')).toBeVisible();
    expect(learning().getByText('11 of 10 dislikes')).toBeVisible();
    expect(learning().queryByText(/Active since/)).toBeNull();
    expect(learning().queryByText(/Last attempt/)).toBeNull();
  });

  it('shows the active model with its version and the day it began', async () => {
    await open(
      { active: { version: 4, since: '2026-10-08T22:30:00.000Z' } },
      makeMe({ timezone: 'Europe/Bratislava' }),
    );

    expect(learning().getByText('Active since Oct 9, 2026 (version 4)')).toBeVisible();
  });

  it('explains a rejected attempt, one sentence per reason', async () => {
    await open({
      lastAttempt: {
        at: '2026-10-08T22:30:00.000Z',
        status: 'rejected',
        reasons: ['insufficient_class', 'low_auc', 'something_new'],
        cvAuc: 0.55,
        baselineAuc: 0.7,
      },
    });

    expect(learning().getByText("Last attempt didn't switch it on:")).toBeVisible();
    const reasons = within(
      learning().getByRole('list', { name: "Last attempt didn't switch it on:" }),
    );
    expect(reasons.getAllByRole('listitem')).toHaveLength(3);
    expect(reasons.getByText(/not enough likes or dislikes/i)).toBeVisible();
    expect(reasons.getByText(/did not predict your ratings well enough/i)).toBeVisible();
    expect(reasons.getByText(/not clear enough/i)).toBeVisible();
  });

  it('says when the model was switched off and why', async () => {
    await open({ deactivated: { at: '2026-10-08T10:00:00.000Z', reason: 'lost_evidence' } });

    expect(learning().getByText(/^Switched off on Oct 8, 2026: /)).toBeVisible();
  });
});
