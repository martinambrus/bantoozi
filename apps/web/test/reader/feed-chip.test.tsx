import type { LearningFeedEntry, LearningStatus, Subscription } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatDateTime } from '../../src/i18n/dates.js';
import { json } from '../api/fake-fetch.js';
import {
  LEARNING,
  learningRoute,
  makeAgreement,
  makeEstimates,
  makeFeedEstimate,
  makeLearning,
  readyAgreement,
} from '../learning/fixtures.js';
import { SET_INFERENCE, makeSubscription } from '../feeds/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { createReaderHarness } from './support.js';

const { open } = createReaderHarness();

type Lang = 'en' | 'sk';
type Mode = 'training' | 'off' | 'active';

const TIMEZONE = 'Europe/Bratislava';
const SINCE = '2026-10-17T08:30:00.000Z';
const NAME: Record<Lang, string> = {
  en: 'Estimate learning for this feed',
  sk: 'Učenie odhadov pre tento zdroj',
};
const QUALITY_HELP = {
  en: 'Quality is how often the estimates put an article you liked above one you disliked, checked against your earlier ratings. Guessing would score 50%.',
  sk: 'Kvalita je to, ako často odhady zaradia článok, ktorý sa vám páčil, nad taký, ktorý sa vám nepáčil, overené na vašich skorších hodnoteniach. Náhodný tip by dosiahol 50 %.',
} as const;
const HELP_LABEL: Record<Lang, string> = {
  en: 'What does quality mean?',
  sk: 'Čo znamená kvalita?',
};

/** Text as the DOM matcher sees it: runs of white space (U+00A0 too) are one space. */
const norm = (text: string) => text.replace(/\s+/g, ' ');
const percent = (value: number, lang: Lang) =>
  new Intl.NumberFormat(lang, { style: 'percent' }).format(value);
const decimals = (value: number, lang: Lang) =>
  new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 60)));

const sub = (mode: Mode, version = '3'): Subscription =>
  makeSubscription({
    feed: { id: '1', title: 'Verge' },
    inferenceMode: mode,
    inferenceVersion: version,
  });

interface Setup {
  mode?: Mode;
  lang?: Lang;
  /** The reader's preference. */
  estimatesPreference?: 'on' | 'off';
  feeds?: LearningFeedEntry[];
  over?: Partial<LearningStatus>;
  path?: string;
}

async function openChip(setup: Setup = {}) {
  const lang = setup.lang ?? 'en';
  const mode = setup.mode ?? 'training';
  const me = makeMe({
    locale: lang,
    timezone: TIMEZONE,
    preferences: { estimates: setup.estimatesPreference ?? 'on' },
  });
  const status = makeLearning({}, setup.feeds ?? [], {
    estimates: makeEstimates({ n: 120 }),
    ...setup.over,
  });
  const opened = await open({
    path: setup.path ?? '/read/feed/1',
    me,
    subscriptions: [sub(mode)],
    routes: { [LEARNING]: learningRoute(() => status) },
  });
  const chip = () => screen.findByRole('group', { name: NAME[lang] });
  return { ...opened, chip, lang };
}

/** The chip once it shows `text`. */
async function chipShowing(setup: Setup, text: string | RegExp) {
  const opened = await openChip(setup);
  const group = await opened.chip();
  await waitFor(() =>
    expect(group).toHaveTextContent(typeof text === 'string' ? norm(text) : text),
  );
  return { ...opened, group };
}

const MODES: Mode[] = ['training', 'off'];

/** A per-feed estimate placed where the API puts it for the mode. */
const withEstimate = (mode: Mode, n: number, auc: number | null): LearningFeedEntry[] =>
  mode === 'training'
    ? [makeAgreement('1', 'collecting', { estimate: { n, auc } })]
    : [makeFeedEstimate('1', n, auc)];

describe.each(MODES)('the feed header chip of a %s feed', (mode) => {
  describe('paused analysis', () => {
    it.each(['engine_unavailable'] as const)('shows only the paused text (%s)', async (reason) => {
      const date = formatDateTime(SINCE, 'en', TIMEZONE);
      const { group } = await chipShowing(
        {
          mode,
          feeds: mode === 'training' ? [readyAgreement('1')] : [makeFeedEstimate('1', 23, 0.71)],
          over: { classification: { state: 'paused', since: SINCE, reason } },
        },
        `Analysis paused since ${date}`,
      );

      expect(group).not.toHaveTextContent(/Estimates/);
      expect(group).not.toHaveTextContent(/Ready for automatic/);
      expect(within(group).queryByRole('button', { name: /^Enable/ })).toBeNull();
    });
  });

  describe('below the estimate gate', () => {
    it.each([
      [7, 'Rate 7 more articles to turn on estimates'],
      [1, 'Rate 1 more article to turn on estimates'],
    ])('asks for %i more ratings', async (needed, words) => {
      const { group } = await chipShowing(
        { mode, over: { estimates: null, estimateGate: { needed } } },
        words,
      );

      expect(group).not.toHaveTextContent('Estimates on');
    });

    it('says the estimates are starting once the gate is open', async () => {
      await chipShowing(
        { mode, over: { estimates: null, estimateGate: { needed: 0 } } },
        'Estimates are starting',
      );
    });
  });

  describe('the estimates preference', () => {
    it('says the estimates are off, not on', async () => {
      const { group } = await chipShowing(
        { mode, estimatesPreference: 'off', feeds: withEstimate(mode, 23, 0.71) },
        'Estimates are off',
      );

      expect(group).not.toHaveTextContent('Estimates on');
    });
  });

  describe('estimates on', () => {
    it('shows the ratings of the feed and no quality below 30 scored ratings', async () => {
      const { group } = await chipShowing(
        { mode, feeds: withEstimate(mode, 23, 0.71) },
        'Estimates on',
      );

      expect(group).toHaveTextContent('23 rated in this feed');
      expect(group).not.toHaveTextContent('quality');
      expect(within(group).queryByRole('button', { name: HELP_LABEL.en })).toBeNull();
    });

    it('shows the quality from 30 scored ratings', async () => {
      const { group } = await chipShowing(
        { mode, feeds: withEstimate(mode, 30, 0.714) },
        'Estimates on',
      );

      expect(group).toHaveTextContent('30 rated in this feed');
      expect(group).toHaveTextContent(`quality ${percent(0.714, 'en')}`);
    });

    it.each([
      ['29 ratings', 29, 0.9],
      ['no AUC', 40, null],
    ])('shows no quality with %s', async (_name, n, auc) => {
      const { group } = await chipShowing(
        { mode, feeds: withEstimate(mode, n, auc) },
        `${n} rated in this feed`,
      );

      expect(group).not.toHaveTextContent('quality');
    });

    it('falls back to the ratings of the account without an estimate for the feed', async () => {
      const { group } = await chipShowing({ mode, feeds: [] }, 'Estimates on');

      expect(group).toHaveTextContent('from 120 ratings');
      expect(group).not.toHaveTextContent('rated in this feed');
      expect(group).not.toHaveTextContent('quality');
    });

    it('explains the quality in a tooltip on hover, on focus and until Escape', async () => {
      const { app, group } = await chipShowing(
        { mode, feeds: withEstimate(mode, 30, 0.714) },
        'quality',
      );
      const help = within(group).getByRole('button', { name: HELP_LABEL.en });
      const tip = () =>
        screen
          .getAllByRole('tooltip', { hidden: true })
          .find((candidate) => candidate.textContent === QUALITY_HELP.en);
      expect(help).toHaveAccessibleDescription(QUALITY_HELP.en);
      expect(tip()).not.toBeVisible();

      await app.user.hover(help);
      expect(tip()).toBeVisible();
      await app.user.unhover(help);
      expect(tip()).not.toBeVisible();

      help.focus();
      await app.user.keyboard('{Escape}');
      expect(tip()).not.toBeVisible();
      await app.user.tab({ shift: true });
      await app.user.tab();
      expect(help).toHaveFocus();
      expect(tip()).toBeVisible();
      await app.user.keyboard('{Escape}');
      expect(tip()).not.toBeVisible();
      expect(help).toHaveFocus();
    });
  });
});

describe('the chip of a training feed only', () => {
  const ENABLE = 'Enable automatic classification for Verge';

  it('offers Enable when the interests agree, and drops the chip once confirmed', async () => {
    const training = sub('training', '3');
    const { app, state, server, chip } = await openChip({ feeds: [readyAgreement('1')] });
    const group = await chip();
    await waitFor(() => expect(group).toHaveTextContent('Ready for automatic classification'));
    expect(within(group).getByRole('button', { name: ENABLE })).toHaveTextContent('Enable');
    expect(app.calls(SET_INFERENCE)).toHaveLength(0);
    server.routes[SET_INFERENCE] = () => {
      const saved = { ...training, inferenceMode: 'active' as const, inferenceVersion: '4' };
      state.subscriptions = [saved];
      return json(200, { subscription: saved });
    };

    await app.user.click(within(group).getByRole('button', { name: ENABLE }));
    const dialog = await screen.findByRole('dialog', { name: `${ENABLE}?` });
    expect(app.calls(SET_INFERENCE)).toHaveLength(0);
    await app.user.click(
      within(dialog).getByRole('button', { name: 'Enable automatic classification' }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(SET_INFERENCE).map(bodyOf)).toEqual([
      { mode: 'active', expectedVersion: '3' },
    ]);
    await waitFor(() => expect(screen.queryByRole('group', { name: NAME.en })).toBeNull());
    const before = app.calls(LEARNING).length;
    await settle();
    expect(app.calls(LEARNING)).toHaveLength(before);
  });

  it.each([
    ['not_yet', 0.52, 'Interests agree 0.52 · ready at 0.60'],
    ['not_yet', null, 'Not enough agreement yet'],
  ] as const)('says how far %s goes (aucLow %s)', async (status, aucLow, words) => {
    const { group } = await chipShowing(
      { feeds: [makeAgreement('1', status, { aucLow, auc: aucLow })] },
      words,
    );

    expect(group).toHaveTextContent('Estimates on');
    expect(group).not.toHaveTextContent('Ready for automatic');
    expect(within(group).queryByRole('button', { name: /^Enable/ })).toBeNull();
  });

  it.each(['collecting', 'one_sided'] as const)('adds no cards text while %s', async (status) => {
    const { group } = await chipShowing({ feeds: [makeAgreement('1', status)] }, 'Estimates on');

    expect(group).not.toHaveTextContent(/Interests agree|Ready for|Not enough agreement/);
    expect(group).not.toHaveTextContent(/Collecting ratings|one-sided/);
    expect(within(group).queryByRole('button', { name: /^Enable/ })).toBeNull();
  });

  it('shows the estimate next to the cards text', async () => {
    const { group } = await chipShowing(
      { feeds: [makeAgreement('1', 'not_yet', { aucLow: 0.52, estimate: { n: 31, auc: 0.8 } })] },
      'Interests agree 0.52',
    );

    expect(group).toHaveTextContent('Estimates on');
    expect(group).toHaveTextContent('31 rated in this feed');
    expect(group).toHaveTextContent(`quality ${percent(0.8, 'en')}`);
  });
});

describe('where the chip is not shown', () => {
  it('never shows interests text for an Off feed, even from a stale agreement entry', async () => {
    const { group } = await chipShowing(
      { mode: 'off', feeds: [readyAgreement('1'), makeFeedEstimate('2', 30, 0.7)] },
      'Estimates on',
    );

    expect(group).not.toHaveTextContent(/Interests agree|Ready for|Not enough agreement/);
    expect(within(group).queryByRole('button', { name: /^Enable/ })).toBeNull();
  });

  it('never shows interests text for an Off feed with a not-yet entry', async () => {
    const { group } = await chipShowing(
      { mode: 'off', feeds: [makeAgreement('1', 'not_yet', { aucLow: 0.52 })] },
      'Estimates on',
    );

    expect(group).not.toHaveTextContent(/Interests agree|Not enough agreement/);
  });

  it('shows no chip for an active feed and asks nothing', async () => {
    const { app } = await openChip({ mode: 'active', feeds: [readyAgreement('1')] });

    await screen.findByRole('heading', { level: 1, name: 'Verge' });
    await settle();
    expect(screen.queryByRole('group', { name: NAME.en })).toBeNull();
    expect(app.calls(LEARNING)).toHaveLength(0);
  });

  it.each([
    ['a folder', '/read/folder/Tech'],
    ['a label', '/read/label/12'],
    ['the For you lane', '/read/for_you'],
    ['the New lane', '/read/new'],
  ])('shows no chip in %s and asks nothing', async (_name, path) => {
    const { app } = await openChip({ mode: 'off', path, feeds: [makeFeedEstimate('1', 23, 0.7)] });

    await screen.findByRole('link', { name: 'Verge' });
    await settle();
    expect(screen.queryByRole('group', { name: NAME.en })).toBeNull();
    expect(app.calls(LEARNING)).toHaveLength(0);
  });
});

describe('switching the classification mode of the feed', () => {
  it('loads the learning data again and adds the interests text to the chip', async () => {
    let training = false;
    const off = sub('off', '3');
    const { app, state } = await open({
      path: '/read/feed/1',
      me: makeMe({ timezone: TIMEZONE }),
      subscriptions: [off],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning(
            {},
            training
              ? [makeAgreement('1', 'not_yet', { aucLow: 0.52 })]
              : [makeFeedEstimate('1', 23, 0.71)],
            { estimates: makeEstimates({ n: 120 }) },
          ),
        ),
        [SET_INFERENCE]: () => {
          training = true;
          const saved = { ...off, inferenceMode: 'training' as const, inferenceVersion: '4' };
          state.subscriptions = [saved];
          return json(200, { subscription: saved });
        },
      },
    });
    const group = await screen.findByRole('group', { name: NAME.en });
    await waitFor(() => expect(group).toHaveTextContent('23 rated in this feed'));
    expect(group).not.toHaveTextContent('Interests agree');
    const before = app.calls(LEARNING).length;

    await app.user.click(await screen.findByRole('button', { name: 'Settings for Verge' }));
    const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
    await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));
    await within(sheet).findByText('Classification is now: Training: selected articles.');
    await app.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() =>
      expect(screen.getByRole('group', { name: NAME.en })).toHaveTextContent(
        'Interests agree 0.52 · ready at 0.60',
      ),
    );
    expect(app.calls(LEARNING).length).toBeGreaterThan(before);
  });
});

describe('the chip in Slovak', () => {
  const sk = (setup: Setup) => ({ ...setup, lang: 'sk' as const });

  it.each([
    [1, 'článok'],
    [3, 'články'],
    [5, 'článkov'],
  ])('declines the gate for %i (%s)', async (needed, word) => {
    const { group } = await chipShowing(
      sk({ over: { estimates: null, estimateGate: { needed } } }),
      `Ohodnoťte ešte ${needed} ${word}, aby sa zapli odhady`,
    );

    expect(group).not.toHaveTextContent('Odhady zapnuté');
  });

  it('shows the estimates on with a Slovak percent and decimal commas', async () => {
    const { group } = await chipShowing(
      sk({
        feeds: [makeAgreement('1', 'not_yet', { aucLow: 0.52, estimate: { n: 30, auc: 0.714 } })],
      }),
      'Odhady zapnuté',
    );

    expect(group).toHaveTextContent('30 hodnotení v tomto zdroji');
    expect(group).toHaveTextContent(`kvalita ${norm(percent(0.714, 'sk'))}`);
    expect(group).toHaveTextContent(
      `Záujmy sa zhodujú na ${decimals(0.52, 'sk')} · pripravené od ${decimals(0.6, 'sk')}`,
    );
    expect(decimals(0.52, 'sk')).toBe('0,52');
  });

  it('declines the ratings of the account', async () => {
    const { group } = await chipShowing(sk({ mode: 'off', feeds: [] }), 'Odhady zapnuté');

    expect(group).toHaveTextContent('z 120 hodnotení');
  });

  it('says the estimates are off and starting', async () => {
    await chipShowing(
      sk({ estimatesPreference: 'off', mode: 'off', feeds: [] }),
      'Odhady sú vypnuté',
    );
  });

  it('explains the quality in Slovak', async () => {
    const { group } = await chipShowing(
      sk({ mode: 'off', feeds: [makeFeedEstimate('1', 30, 0.714)] }),
      'kvalita',
    );

    expect(within(group).getByRole('button', { name: HELP_LABEL.sk })).toHaveAccessibleDescription(
      QUALITY_HELP.sk,
    );
  });
});

describe('the chip for assistive technology', () => {
  it('is a named group whose help control is reachable by keyboard and named', async () => {
    const { app, group } = await chipShowing(
      { mode: 'off', feeds: [makeFeedEstimate('1', 30, 0.714)] },
      'quality',
    );
    expect(group).toHaveAttribute('role', 'group');
    expect(group).toHaveAccessibleName(NAME.en);
    const help = within(group).getByRole('button', { name: HELP_LABEL.en });
    expect(help).toHaveAccessibleName(HELP_LABEL.en);

    let tabs = 0;
    while (document.activeElement !== help && tabs < 80) {
      await app.user.tab();
      tabs += 1;
    }

    expect(help).toHaveFocus();
  });

  it.each([
    ['paused', { classification: { state: 'paused', since: SINCE, reason: 'engine_unavailable' } }],
    ['gated', { estimates: null, estimateGate: { needed: 4 } }],
    ['starting', { estimates: null, estimateGate: { needed: 0 } }],
  ] as const)('states the %s state in words', async (_name, over) => {
    const { group } = await chipShowing({ mode: 'off', over }, /\S/);

    expect(group.textContent?.trim().length).toBeGreaterThan(10);
    expect(group).toHaveTextContent(/paused|Rate 4 more|starting/);
  });
});
