import type { LearningHistory, LearningHistoryItem } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatDate } from '../../src/i18n/dates.js';
import { failure, json } from '../api/fake-fetch.js';
import {
  LEARNING,
  LEARNING_HISTORY,
  learningHistoryRoute,
  makeHistory,
  makeHistoryItem,
  makeLearning,
} from '../learning/fixtures.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler } from '../support/app.js';
import { openSettings, section } from './support.js';

type Language = 'en' | 'sk';

// Auckland is UTC+13 in October, so a row at 11:30Z lands on the next calendar day there.
const TIMEZONE = 'Pacific/Auckland';
const HISTORY_CALL = 'GET /me/learning/history';

const T = {
  en: {
    section: 'Personal learning',
    heading: 'Learning curve',
    model: 'Personal model',
    estimate: 'Word estimates',
    baseline: 'Your interests alone',
    chart: /Learning curve/,
    milestones: 'Milestones',
    estimatesOn: 'Estimates turned on',
    modelOn: 'Personal model switched on',
    updated: 'Analysis updated',
    show: 'Show as table',
    hide: 'Hide table',
    scrubber: 'Update',
    headers: [
      'Date',
      'Update',
      'Ratings',
      'Quality',
      'Your interests alone',
      'Switched on',
      'Reason',
    ],
    yes: 'Yes',
    no: 'No',
    noData: 'No updates recorded yet. They appear after your first ratings are processed.',
    one: 'One update recorded so far. The curve appears after the next one.',
    capped: 'Older updates are not kept.',
    rough: 'Updates from fewer than 30 ratings are rough.',
    counts: '23 of 40 ratings',
  },
  sk: {
    section: 'Osobné učenie',
    heading: 'Krivka učenia',
    model: 'Osobný model',
    estimate: 'Odhady podľa slov',
    baseline: 'Samotné vaše záujmy',
    chart: /Krivka učenia/,
    milestones: 'Medzníky',
    estimatesOn: 'Odhady zapnuté',
    modelOn: 'Osobný model zapnutý',
    updated: 'Analýza aktualizovaná',
    show: 'Zobraziť ako tabuľku',
    hide: 'Skryť tabuľku',
    scrubber: 'Aktualizácia',
    headers: [
      'Dátum',
      'Aktualizácia',
      'Hodnotenia',
      'Kvalita',
      'Samotné vaše záujmy',
      'Zapnuté',
      'Dôvod',
    ],
    yes: 'Áno',
    no: 'Nie',
    noData:
      'Zatiaľ nie sú zaznamenané žiadne aktualizácie. Objavia sa po spracovaní vašich prvých hodnotení.',
    one: 'Zatiaľ je zaznamenaná jedna aktualizácia. Krivka sa zobrazí po ďalšej.',
    capped: 'Staršie aktualizácie sa neuchovávajú.',
    rough: 'Aktualizácie z menej ako 30 hodnotení sú len hrubé.',
    counts: '23 z 40 hodnotení',
  },
} as const;

const pct = (value: number, language: Language) =>
  new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(value);
const day = (iso: string, language: Language = 'en') => formatDate(iso, language, TIMEZONE);

/** Row i is one day after row i-1, at 11:30Z. */
const at = (i: number) => `2026-10-${String(10 + i).padStart(2, '0')}T11:30:00.000Z`;
const row = (i: number, over: Partial<LearningHistoryItem> = {}) =>
  makeHistoryItem({ at: at(i), n: 40 + i, ...over });

async function open(
  history: LearningHistory,
  {
    language = 'en',
    routes = {},
  }: { language?: Language; routes?: Record<string, ApiRouteHandler> } = {},
) {
  const me = makeMe({ locale: language, timezone: TIMEZONE });
  const app = await openSettings({
    me,
    routes: {
      [LEARNING]: () =>
        json(200, makeLearning({ counts: { explicit: 23, likes: 12, dislikes: 11 } })),
      [LEARNING_HISTORY]: learningHistoryRoute(() => history),
      ...routes,
    },
  });
  const t = T[language];
  await screen.findByRole('region', { name: t.section });
  const learning = within(section(t.section));
  await learning.findByText(t.counts);
  await learning.findByRole('heading', { level: 3, name: t.heading });
  return { ...app, learning, t };
}

/** Model 0.70/0.60 baseline, estimates 0.6..0.72 with a gap, mixed. */
const mixed = () =>
  makeHistory([
    row(0, { kind: 'estimate', auc: 0.6, turnedOn: true }),
    row(1, { kind: 'estimate', auc: 0.65 }),
    row(2, { kind: 'model', auc: 0.7, baselineAuc: 0.6, activated: true, turnedOn: true }),
    row(3, { kind: 'estimate', auc: null }),
    row(4, { kind: 'estimate', auc: 0.7 }),
    row(5, { kind: 'model', auc: 0.74, baselineAuc: 0.64, activated: false }),
    row(6, { kind: 'estimate', auc: 0.72 }),
  ]);

const series = (figure: HTMLElement, name: string, tag: 'path' | 'circle') =>
  Array.from(figure.querySelectorAll(`${tag}[data-series="${name}"]`));

describe('learning curve: empty and single-row states', () => {
  it('says there are no updates and draws nothing', async () => {
    const { learning, t } = await open(makeHistory());

    expect(await learning.findByText(t.noData)).toBeVisible();
    expect(learning.queryByRole('figure')).toBeNull();
    expect(learning.queryByRole('button', { name: t.show })).toBeNull();
  });

  it('with one row shows the notice without a figure, but keeps milestones and the table', async () => {
    const { learning, t } = await open(
      makeHistory([row(0, { kind: 'estimate', turnedOn: true, auc: 0.6 })]),
    );

    expect(await learning.findByText(t.one)).toBeVisible();
    expect(learning.queryByRole('figure')).toBeNull();
    const list = learning.getByRole('list', { name: t.milestones });
    expect(within(list).getByText(new RegExp(t.estimatesOn))).toBeVisible();
    expect(learning.getByRole('button', { name: t.show })).toBeVisible();
  });
});

describe('learning curve: the chart', () => {
  it('draws a described figure with an svg named Learning curve, in the documented order', async () => {
    const { learning, t } = await open(mixed());

    const figure = await learning.findByRole('figure');
    const svg = within(figure).getByRole('img', { name: t.chart });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    const caption = figure.querySelector('figcaption');
    expect(caption?.textContent?.trim()).toBeTruthy();
    expect(caption?.textContent).toContain(day(at(0)));
    expect(caption?.textContent).toContain(day(at(6)));
    expect(caption?.textContent).toContain(pct(0.74, 'en'));
    expect(caption?.textContent).toContain(pct(0.72, 'en'));
    expect(caption?.textContent).toContain(pct(0.64, 'en'));

    const heading = learning.getByRole('heading', { level: 3, name: t.heading });
    const list = learning.getByRole('list', { name: t.milestones });
    const button = learning.getByRole('button', { name: t.show });
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(heading, figure)).toBe(true);
    expect(before(figure, list)).toBe(true);
    expect(before(list, button)).toBe(true);
  });

  it('draws one path per contiguous run and one marker per plotted point', async () => {
    const { learning } = await open(
      makeHistory([
        row(0, { kind: 'estimate', auc: 0.6 }),
        row(1, { kind: 'estimate', auc: 0.65 }),
        row(2, { kind: 'estimate', auc: null }),
        row(3, { kind: 'estimate', auc: 0.7 }),
        row(4, { kind: 'estimate', auc: 0.72 }),
      ]),
    );
    const figure = await learning.findByRole('figure');

    expect(series(figure, 'estimate', 'path')).toHaveLength(2);
    expect(series(figure, 'estimate', 'circle')).toHaveLength(4);
    expect(series(figure, 'model', 'path')).toHaveLength(0);
    expect(series(figure, 'baseline', 'path')).toHaveLength(0);
  });

  it('keeps a line across rows of the other kind, marks single points, and splits on a null baseline', async () => {
    const { learning } = await open(
      makeHistory([
        row(0, { kind: 'model', auc: 0.6, baselineAuc: 0.5 }),
        row(1, { kind: 'estimate', auc: 0.65 }),
        row(2, { kind: 'model', auc: 0.7, baselineAuc: null }),
        row(3, { kind: 'estimate', auc: 0.66 }),
        row(4, { kind: 'model', auc: 0.74, baselineAuc: 0.6 }),
      ]),
    );
    const figure = await learning.findByRole('figure');

    // The estimate rows in between do not break the model line: one run of three points.
    expect(series(figure, 'model', 'path')).toHaveLength(1);
    expect(series(figure, 'model', 'circle')).toHaveLength(3);
    // Baseline points at rows 0 and 4 are separated by a null: two single points, no line.
    expect(series(figure, 'baseline', 'path')).toHaveLength(0);
    expect(series(figure, 'baseline', 'circle')).toHaveLength(2);
    // Two estimate points separated by a model row stay one run.
    expect(series(figure, 'estimate', 'path')).toHaveLength(1);
  });

  it('places points by row order, not by time', async () => {
    const { learning } = await open(
      makeHistory([
        row(0, { kind: 'model', auc: 0.6 }),
        makeHistoryItem({ at: at(1), kind: 'model', auc: 0.65, n: 50 }),
        makeHistoryItem({ at: '2026-12-30T11:30:00.000Z', kind: 'model', auc: 0.7, n: 60 }),
        makeHistoryItem({ at: '2026-12-31T11:30:00.000Z', kind: 'model', auc: 0.7, n: 70 }),
      ]),
    );
    const figure = await learning.findByRole('figure');
    const xs = series(figure, 'model', 'circle').map((c) => Number(c.getAttribute('cx')));

    const gaps = xs.slice(1).map((x, i) => x - (xs[i] as number));
    expect(gaps).toHaveLength(3);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] as number, 3);
    expect(gaps[0]).toBeGreaterThan(0);
  });

  it('lists only series that have data, with their latest value', async () => {
    const { learning, t } = await open(
      makeHistory([
        row(0, { kind: 'estimate', auc: 0.6 }),
        row(1, { kind: 'estimate', auc: 0.68 }),
      ]),
    );
    const figure = await learning.findByRole('figure');

    expect(figure.textContent).toContain(t.estimate);
    expect(figure.textContent).toContain(pct(0.68, 'en'));
    expect(figure.textContent).not.toContain(t.model);
    expect(figure.textContent).not.toContain(t.baseline);
  });

  it('lists all three series with their latest values', async () => {
    const { learning, t } = await open(mixed());
    const figure = await learning.findByRole('figure');
    const text = figure.textContent ?? '';

    for (const name of [t.model, t.estimate, t.baseline]) expect(text).toContain(name);
    for (const value of [0.74, 0.72, 0.64]) expect(text).toContain(pct(value, 'en'));
  });

  it('notes that updates from fewer than 30 ratings are rough only when one is plotted', async () => {
    const small = await open(
      makeHistory([row(0, { kind: 'estimate', n: 12, auc: 0.6 }), row(1, { n: 45, auc: 0.7 })]),
    );
    await small.learning.findByRole('figure');
    expect(small.learning.getByText(small.t.rough)).toBeVisible();
  });

  it('shows no rough-updates note when every row has 30 ratings or more', async () => {
    const { learning, t } = await open(
      makeHistory([row(0, { n: 30, auc: 0.6 }), row(1, { n: 45, auc: 0.7 })]),
    );
    await learning.findByRole('figure');
    expect(learning.queryByText(t.rough)).toBeNull();
  });
});

describe('learning curve: milestones', () => {
  it('lists turn-ons and analysis updates in order with dates in the account time zone', async () => {
    const { learning, t } = await open(
      makeHistory([
        row(0, { kind: 'estimate', turnedOn: true, auc: 0.6 }),
        row(1, {
          kind: 'model',
          turnedOn: true,
          activated: true,
          auc: 0.7,
          engineModel: 'jev-1.13.0',
        }),
        row(2, { kind: 'estimate', auc: 0.66 }),
        row(3, { kind: 'model', activated: true, auc: 0.72, engineModel: 'jev-1.14.0' }),
        row(4, { kind: 'model', auc: 0.73, engineModel: null }),
        row(5, { kind: 'model', auc: 0.74, engineModel: 'jev-1.14.0' }),
      ]),
    );
    const list = learning.getByRole('list', { name: t.milestones });
    const items = within(list).getAllByRole('listitem');

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(t.estimatesOn);
    expect(items[0]).toHaveTextContent(day(at(0)));
    expect(items[1]).toHaveTextContent(t.modelOn);
    expect(items[1]).toHaveTextContent(day(at(1)));
    expect(items[2]).toHaveTextContent(t.updated);
    expect(items[2]).toHaveTextContent(day(at(3)));
    expect(list.textContent).not.toContain('jev-');
    // The date differs from the UTC one, so a UTC-formatted date would fail above.
    expect(day(at(0))).not.toBe(formatDate(at(0), 'en', 'UTC'));
  });

  it('makes no turn-on milestone for a first retained row that is not a turn-on', async () => {
    const { learning, t } = await open(
      makeHistory([row(0, { kind: 'model', auc: 0.7 }), row(1, { kind: 'model', auc: 0.71 })]),
    );

    expect(learning.queryByText(t.modelOn)).toBeNull();
    expect(learning.queryByText(t.estimatesOn)).toBeNull();
  });

  it('says older updates are not kept when either kind was trimmed', async () => {
    for (const truncated of [{ model: true }, { estimate: true }]) {
      const { learning, t, unmount } = await open(makeHistory([row(0), row(1)], truncated));
      expect(await learning.findByText(t.capped)).toBeVisible();
      unmount();
    }
  });

  it('does not say it when nothing was trimmed', async () => {
    const { learning, t } = await open(makeHistory([row(0), row(1)]));
    await learning.findByRole('figure');
    expect(learning.queryByText(t.capped)).toBeNull();
  });
});

describe('learning curve: the scrubber', () => {
  it('is a range named Update that starts on the latest row and steps back with ArrowLeft', async () => {
    const { learning, t, user } = await open(mixed());
    const slider = await learning.findByRole('slider', { name: t.scrubber });

    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '7');
    expect(slider).toHaveValue('7');
    expect(slider.getAttribute('aria-valuetext')).toContain(day(at(6)));
    expect(slider.getAttribute('aria-valuetext')).toContain(t.estimate);

    slider.focus();
    await user.keyboard('{ArrowLeft}');

    expect(slider).toHaveValue('6');
    const text = slider.getAttribute('aria-valuetext') ?? '';
    expect(text).toContain(t.model);
    expect(text).toContain(day(at(5)));
    expect(text).toContain(String(45));
    expect(text).toContain(pct(0.74, 'en'));
    // A visible readout says the same thing (own text of one element).
    expect(
      learning.getByText((own, el) => {
        return (
          el?.tagName.toLowerCase() !== 'input' &&
          own.includes(t.model) &&
          own.includes(day(at(5))) &&
          own.includes(pct(0.74, 'en'))
        );
      }),
    ).toBeVisible();
  });

  it('reads a null quality as a dash', async () => {
    const { learning, t, user } = await open(mixed());
    const slider = await learning.findByRole('slider', { name: t.scrubber });
    slider.focus();
    for (let i = 0; i < 4; i += 1) await user.keyboard('{ArrowLeft}');

    expect(slider).toHaveValue('3');
    const text = slider.getAttribute('aria-valuetext') ?? '';
    expect(text).toContain(day(at(2)));
    expect(text).toContain(t.model);
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveValue('4');
    expect(slider.getAttribute('aria-valuetext')).toContain('–');
    expect(slider.getAttribute('aria-valuetext')).toContain(day(at(3)));
  });
});

describe('learning curve: the table', () => {
  it.each(['en', 'sk'] as const)('shows rejection reasons in %s', async (language) => {
    const { learning, t, user } = await open(
      makeHistory([row(0, { kind: 'model', reason: 'low_auc' })]),
      { language },
    );
    await user.click(await learning.findByRole('button', { name: t.show }));
    expect(
      learning.getByRole('columnheader', { name: language === 'en' ? 'Reason' : 'Dôvod' }),
    ).toBeVisible();
    expect(
      learning.getByText(language === 'en' ? 'Quality too low' : 'Príliš nízka kvalita'),
    ).toBeVisible();
  });

  it('keeps unknown historical activation blank and translates multiple or unknown reasons', async () => {
    const { learning, t, user } = await open(
      makeHistory([
        row(0, { kind: 'model', activated: null, turnedOn: null, reason: 'low_auc,worse_logloss' }),
        row(1, { kind: 'model', reason: 'future_reason' }),
      ]),
    );
    await user.click(await learning.findByRole('button', { name: t.show }));
    expect(learning.getByText('Quality too low; Less reliable predictions')).toBeVisible();
    expect(learning.getByText('Update was not activated')).toBeVisible();
    const rows = within(learning.getByRole('table')).getAllByRole('row');
    expect(within(rows[2]!).getAllByRole('cell')[5]).toHaveTextContent('–');
    expect(learning.queryByRole('list', { name: t.milestones })).toBeNull();
  });

  it('is hidden until opened, newest first, and closes again', async () => {
    const { learning, t, user } = await open(mixed());
    const button = await learning.findByRole('button', { name: t.show });

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(learning.queryByRole('table')).toBeNull();

    await user.click(button);

    const hideButton = learning.getByRole('button', { name: t.hide });
    expect(hideButton).toHaveAttribute('aria-expanded', 'true');
    const table = learning.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([...t.headers]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    // Newest first: row 6 (estimate 72 %), row 5 (model 74 %, baseline 64 %, not switched on), ...
    expect(cells(rows[0] as HTMLElement)).toEqual([
      day(at(6)),
      t.estimate,
      '46',
      pct(0.72, 'en'),
      '–',
      '–',
      '–',
    ]);
    expect(cells(rows[1] as HTMLElement)).toEqual([
      day(at(5)),
      t.model,
      '45',
      pct(0.74, 'en'),
      pct(0.64, 'en'),
      t.no,
      '–',
    ]);
    expect(cells(rows[2] as HTMLElement)).toEqual([
      day(at(4)),
      t.estimate,
      '44',
      pct(0.7, 'en'),
      '–',
      '–',
      '–',
    ]);
    expect(cells(rows[3] as HTMLElement)[3]).toBe('–');
    expect(cells(rows[4] as HTMLElement)).toEqual([
      day(at(2)),
      t.model,
      '42',
      pct(0.7, 'en'),
      pct(0.6, 'en'),
      t.yes,
      '–',
    ]);
    expect(cells(rows[6] as HTMLElement)[0]).toBe(day(at(0)));

    await user.click(hideButton);
    expect(learning.queryByRole('table')).toBeNull();
    expect(learning.getByRole('button', { name: t.show })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('learning curve: Slovak', () => {
  it('translates names, milestones, table and the percent format', async () => {
    const { learning, t, user } = await open(
      makeHistory(
        [
          row(0, { kind: 'estimate', turnedOn: true, auc: 0.6, n: 12 }),
          row(1, {
            kind: 'model',
            turnedOn: true,
            activated: true,
            auc: 0.7,
            baselineAuc: 0.6,
            engineModel: 'jev-1.13.0',
          }),
          row(2, {
            kind: 'model',
            activated: false,
            auc: 0.74,
            baselineAuc: 0.64,
            engineModel: 'jev-1.14.0',
          }),
        ],
        { model: true },
      ),
      { language: 'sk' },
    );
    const figure = await learning.findByRole('figure');

    expect(within(figure).getByRole('img', { name: t.chart })).toBeVisible();
    for (const name of [t.model, t.estimate, t.baseline])
      expect(figure.textContent).toContain(name);
    expect(figure.textContent).toContain(pct(0.74, 'sk'));
    expect(pct(0.74, 'sk')).toContain(' ');
    const items = within(learning.getByRole('list', { name: t.milestones })).getAllByRole(
      'listitem',
    );
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining(t.estimatesOn),
      expect.stringContaining(t.modelOn),
      expect.stringContaining(t.updated),
    ]);
    expect(items[0]).toHaveTextContent(day(at(0), 'sk'));
    expect(learning.getByText(t.capped)).toBeVisible();
    expect(learning.getByText(t.rough)).toBeVisible();
    expect(learning.getByRole('slider', { name: t.scrubber })).toBeVisible();

    await user.click(learning.getByRole('button', { name: t.show }));
    const table = learning.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([...t.headers]);
    const body = within(table).getAllByRole('row').slice(1);
    const first = within(body[0] as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(first).toEqual([
      day(at(2), 'sk'),
      t.model,
      '42',
      pct(0.74, 'sk'),
      pct(0.64, 'sk'),
      t.no,
      '–',
    ]);
    const second = within(body[1] as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(second[5]).toBe(t.yes);
    await user.click(learning.getByRole('button', { name: t.hide }));
  });

  it('shows the empty and single-row notices in Slovak', async () => {
    const empty = await open(makeHistory(), { language: 'sk' });
    expect(await empty.learning.findByText(T.sk.noData)).toBeVisible();
    empty.unmount();
    const one = await open(makeHistory([row(0)]), { language: 'sk' });
    expect(await one.learning.findByText(T.sk.one)).toBeVisible();
  });
});

describe('learning curve: theming', () => {
  const COLOUR =
    /^(stroke|fill|text|bg|border)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(-\d+)?$/;
  const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

  it('gives every coloured element in the figure a dark: counterpart of the same property', async () => {
    const { learning } = await open(mixed());
    const figure = await learning.findByRole('figure');

    let coloured = 0;
    for (const el of [figure, ...Array.from(figure.querySelectorAll('*'))]) {
      const classes = classesOf(el);
      for (const cls of classes) {
        const match = COLOUR.exec(cls);
        if (match === null) continue;
        coloured += 1;
        expect(
          classes.some((c) => c.startsWith(`dark:${match[1]}-`)),
          `${el.tagName} "${classes.join(' ')}" lacks a dark:${match[1]}- utility`,
        ).toBe(true);
      }
    }
    expect(coloured).toBeGreaterThan(0);
  });

  it('draws the series in distinct hues and the estimate markers hollow', async () => {
    const { learning } = await open(mixed());
    const figure = await learning.findByRole('figure');
    const cls = (el: Element | undefined) => (el === undefined ? '' : classesOf(el).join(' '));
    const model = series(figure, 'model', 'circle')[0] as Element;
    const estimate = series(figure, 'estimate', 'circle')[0] as Element;

    const lines = {
      model: cls(series(figure, 'model', 'path')[0] ?? series(figure, 'model', 'circle')[0]),
      estimate: cls(series(figure, 'estimate', 'path')[0]),
      baseline: cls(series(figure, 'baseline', 'circle')[0]),
    };
    expect(lines.model).toMatch(/\b(stroke|fill)-indigo/);
    expect(lines.estimate).toMatch(/\bstroke-orange/);
    expect(lines.baseline).toMatch(/\b(stroke|fill)-slate/);

    const fillOf = (el: Element) =>
      `${el.getAttribute('fill') ?? ''} ${classesOf(el)
        .filter((c) => /(^|:)fill-/.test(c))
        .join(' ')}`;
    expect(fillOf(model)).toMatch(/indigo/);
    expect(fillOf(estimate)).not.toMatch(/orange|indigo/);
    expect(fillOf(estimate)).not.toBe(fillOf(model));
    expect(cls(estimate)).toMatch(/stroke-orange/);
  });
});

describe('learning curve: requests', () => {
  it('reads the history exactly once while the section is shown', async () => {
    const { learning, calls } = await open(mixed());
    await learning.findByRole('figure');

    expect(calls(HISTORY_CALL)).toHaveLength(1);
  });

  it('shows the normal error state with a retry that loads it, while the rest still renders', async () => {
    let failing = true;
    const { learning, t, user, calls } = await open(mixed(), {
      routes: {
        [LEARNING_HISTORY]: () => (failing ? failure(403, 'FORBIDDEN') : json(200, mixed())),
      },
    });

    expect(await learning.findByRole('alert')).toBeVisible();
    expect(learning.getByText(t.counts)).toBeVisible();
    expect(learning.queryByRole('figure')).toBeNull();

    failing = false;
    await user.click(learning.getByRole('button', { name: 'Retry' }));

    expect(await learning.findByRole('figure')).toBeVisible();
    expect(calls(HISTORY_CALL)).toHaveLength(2);
  });
});
