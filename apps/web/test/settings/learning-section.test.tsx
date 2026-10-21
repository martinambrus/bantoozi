import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import en from '../../src/features/settings/i18n/en.json' with { type: 'json' };
import sk from '../../src/features/settings/i18n/sk.json' with { type: 'json' };
import { makeMe } from '../session/fixtures.js';
import { cardDraftRoutes } from '../interests/support.js';
import { LEARNING, makeAgreement, makeLearning } from '../learning/fixtures.js';
import { json } from '../api/fake-fetch.js';
import { bodyOf } from '../support/app.js';
import { makeSubscription, openSettings, section } from './support.js';

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

  it('explains an upgrade regression in plain words', async () => {
    await open({
      active: null,
      lastAttempt: {
        at: '2026-10-08T22:30:00.000Z',
        status: 'rejected',
        reasons: ['upgrade_regression'],
        cvAuc: 0.8,
        baselineAuc: 0.78,
      },
    });

    const reasons = within(
      learning().getByRole('list', { name: "Last attempt didn't switch it on:" }),
    );
    expect(reasons.getAllByRole('listitem')).toHaveLength(1);
    expect(
      reasons.getByText(
        'After an update to how articles are read, it predicted your newest ratings worse than your interests alone.',
      ),
    ).toBeVisible();
  });

  it('defines the upgrade regression sentence in both languages', () => {
    const reasonsOf = (bundle: unknown): Record<string, string> =>
      (bundle as { learning: { reasons: Record<string, string> } }).learning.reasons;
    expect(reasonsOf(en)['upgrade_regression']).toBe(
      'After an update to how articles are read, it predicted your newest ratings worse than your interests alone.',
    );
    expect(reasonsOf(sk)['upgrade_regression']).toBe(
      'Po aktualizácii čítania článkov predpovedal vaše najnovšie hodnotenia horšie než samotné vaše záujmy.',
    );
  });

  it('says when the model was switched off and why', async () => {
    await open({ deactivated: { at: '2026-10-08T10:00:00.000Z', reason: 'lost_evidence' } });

    expect(learning().getByText(/^Switched off on Oct 8, 2026: /)).toBeVisible();
  });
});

describe('the interests to add in the personal learning section', () => {
  const suggesting = (feedId: string, count: number, titles: string[]) =>
    makeAgreement(feedId, 'ready', {
      uncovered: {
        count,
        suggest: true,
        articles: titles.map((title, index) => ({ id: `${feedId}${index}`, title })),
      },
    });

  const subscriptions = () =>
    json(200, [
      makeSubscription('1', 'Alpha', { inferenceMode: 'training' }),
      makeSubscription('2', 'Beta', { inferenceMode: 'training' }),
      makeSubscription('3', 'Gamma', { inferenceMode: 'training' }),
    ]);

  async function openWith(feeds: ReturnType<typeof makeAgreement>[], me = makeMe()) {
    return openSettings({
      me,
      routes: {
        ...cardDraftRoutes(),
        'GET /subscriptions': subscriptions,
        [LEARNING]: () => json(200, makeLearning({}, feeds)),
      },
    });
  }

  it('lists only the feeds that suggest one, and opens the editor from one of them', async () => {
    const app = await openWith([
      suggesting('1', 3, ['Solid-state cells', 'Sodium-ion']),
      makeAgreement('2', 'ready', { uncovered: { count: 4, suggest: false, articles: [] } }),
      suggesting('9', 5, ['A feed not subscribed']),
    ]);

    const list = await learning().findByRole('list', { name: 'Interests to add' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Alpha')).toBeVisible();
    expect(learning().queryByText('Beta')).toBeNull();
    expect(learning().queryByText('A feed not subscribed')).toBeNull();

    await app.user.click(
      within(list).getByRole('button', { name: 'Make an interest from what you like in Alpha' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'New card from these articles' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(app.calls('POST /cards/drafts').map(bodyOf)).toEqual([
        { articleIds: ['10', '11'], kind: 'interest' },
      ]),
    );
  });

  it('shows no list when no feed suggests one', async () => {
    await openWith([makeAgreement('1', 'ready')]);

    await screen.findByText(/ratings$/);
    expect(learning().queryByText('Interests to add')).toBeNull();
  });

  it('counts the missed articles with Slovak plural forms', async () => {
    await openWith(
      [suggesting('1', 3, ['Solid-state cells']), suggesting('2', 5, ['Sodium-ion'])],
      makeMe({ locale: 'sk' }),
    );

    const slovak = within(section('Osobné učenie'));
    expect(await slovak.findByText(/každá karta ohodnotila nízko 3 články/)).toBeVisible();
    expect(slovak.getByText(/každá karta ohodnotila nízko 5 článkov/)).toBeVisible();
  });
});

describe('the topics to avoid in the personal learning section', () => {
  const suggesting = (feedId: string, count: number, titles: string[]) =>
    makeAgreement(feedId, 'ready', {
      unwanted: {
        count,
        suggest: true,
        articles: titles.map((title, index) => ({ id: `${feedId}${index}`, title })),
      },
    });

  async function openWith(feeds: ReturnType<typeof makeAgreement>[]) {
    return openSettings({
      me: makeMe(),
      routes: {
        ...cardDraftRoutes(),
        'GET /subscriptions': () =>
          json(200, [
            makeSubscription('1', 'Alpha', { inferenceMode: 'training' }),
            makeSubscription('2', 'Beta', { inferenceMode: 'training' }),
          ]),
        [LEARNING]: () => json(200, makeLearning({}, feeds)),
      },
    });
  }

  it('lists only the feeds that suggest one, and opens the editor on Never', async () => {
    const app = await openWith([
      suggesting('1', 3, ['Gossip', 'Royals']),
      makeAgreement('2', 'ready', { unwanted: { count: 4, suggest: false, articles: [] } }),
    ]);

    const list = await learning().findByRole('list', { name: 'Topics to avoid' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Alpha')).toBeVisible();
    expect(learning().queryByText('Beta')).toBeNull();

    await app.user.click(
      within(list).getByRole('button', {
        name: 'Make a Never card from what you dislike in Alpha',
      }),
    );
    const editor = await screen.findByRole('dialog', { name: 'New card from these articles' });
    expect(within(editor).getByRole('radio', { name: 'Never' })).toBeChecked();
    await waitFor(() =>
      expect(app.calls('POST /cards/drafts').map(bodyOf)).toEqual([
        { articleIds: ['10', '11'], kind: 'never' },
      ]),
    );
  });

  it('shows no list when no feed suggests one', async () => {
    await openWith([makeAgreement('1', 'ready')]);

    await screen.findByText(/ratings$/);
    expect(learning().queryByText('Topics to avoid')).toBeNull();
  });
});
