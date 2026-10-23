import { within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ITEM, checkUnhandled, makeExplain, renderDrawer } from './support.js';

checkUnhandled();

type Word = { feature: string; label: string; contribution: number };

const estimateExplain = (top: Word[] | undefined) =>
  makeExplain({
    source: 'estimate',
    p: 0.74,
    lane: 'new',
    tier: 4,
    cards: [],
    rules: [{ code: 'inference_not_requested' }, { code: 'estimate' }],
    ...(top === undefined ? {} : { estimate: { version: 1, top } }),
  });

const MIXED: Word[] = [
  { feature: 't:gossip', label: 'gossip', contribution: -0.4 },
  { feature: 't:solar', label: 'solar', contribution: 0.5 },
  { feature: 't:celebrity', label: 'celebrity', contribution: -0.7 },
  { feature: 't:grid', label: 'grid', contribution: 0.2 },
  { feature: 't:battery', label: 'battery', contribution: 0.8 },
];

const TEXT = {
  en: {
    heading: 'Words behind this estimate',
    raised: 'Raised the estimate',
    lowered: 'Lowered the estimate',
  },
  sk: {
    heading: 'Slová za týmto odhadom',
    raised: 'Zvýšili odhad',
    lowered: 'Znížili odhad',
  },
} as const;

const words = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('the estimate words in the Why sheet', () => {
  it('lists the words in both directions, strongest first, without feature keys', async () => {
    const { panel, dialog } = await renderDrawer({ explain: estimateExplain(MIXED) });
    expect(panel.getByRole('heading', { name: TEXT.en.heading })).toBeInTheDocument();
    expect(words(panel.getByRole('list', { name: TEXT.en.raised }))).toEqual([
      'battery',
      'solar',
      'grid',
    ]);
    expect(words(panel.getByRole('list', { name: TEXT.en.lowered }))).toEqual([
      'celebrity',
      'gossip',
    ]);
    expect(dialog.textContent).not.toMatch(/\b[tbe]:|t:battery|t:gossip/);
  });

  it('shows only the direction that has words', async () => {
    const up = await renderDrawer({
      explain: estimateExplain(MIXED.filter((w) => w.contribution > 0)),
    });
    expect(up.panel.getByRole('list', { name: TEXT.en.raised })).toBeInTheDocument();
    expect(up.panel.queryByRole('list', { name: TEXT.en.lowered })).toBeNull();
    expect(up.dialog.textContent).not.toContain(TEXT.en.lowered);
    up.unmount();

    const down = await renderDrawer({
      explain: estimateExplain(MIXED.filter((w) => w.contribution < 0)),
    });
    expect(down.panel.getByRole('list', { name: TEXT.en.lowered })).toBeInTheDocument();
    expect(down.panel.queryByRole('list', { name: TEXT.en.raised })).toBeNull();
    expect(down.dialog.textContent).not.toContain(TEXT.en.raised);
  });

  it.each([
    ['no estimate field', undefined],
    ['an empty top', []],
  ])('shows no section for %s and keeps the verdict', async (_name, top) => {
    const { panel, dialog } = await renderDrawer({ explain: estimateExplain(top) });
    expect(panel.queryByRole('heading', { name: TEXT.en.heading })).toBeNull();
    expect(dialog).toHaveTextContent('Estimated from the words of articles you rated.');
  });

  it('shows no section for a card-scored article', async () => {
    const { panel } = await renderDrawer({ explain: makeExplain() });
    expect(panel.queryByRole('heading', { name: TEXT.en.heading })).toBeNull();
  });

  it('lists a repeated word once, the stronger first, and skips zero contributions', async () => {
    const { panel } = await renderDrawer({
      explain: estimateExplain([
        { feature: 'e:batteri', label: 'Battery ', contribution: 0.3 },
        { feature: 't:battery', label: 'battery', contribution: 0.8 },
        { feature: 't:zero', label: 'zero', contribution: 0 },
      ]),
    });
    expect(words(panel.getByRole('list', { name: TEXT.en.raised }))).toEqual(['battery']);
    expect(panel.queryByText('zero')).toBeNull();
    expect(panel.queryByRole('list', { name: TEXT.en.lowered })).toBeNull();
  });

  it('shows a label with markup as text', async () => {
    const { panel, dialog } = await renderDrawer({
      explain: estimateExplain([{ feature: 't:x', label: '<b>x</b>', contribution: 0.5 }]),
    });
    expect(words(panel.getByRole('list', { name: TEXT.en.raised }))).toEqual(['<b>x</b>']);
    expect(dialog.querySelector('li b')).toBeNull();
  });

  it('marks both lists with the language of the article, or with none', async () => {
    const sk = await renderDrawer({
      explain: estimateExplain(MIXED),
      item: { ...ITEM, lang: 'sk' },
    });
    expect(sk.panel.getByRole('list', { name: TEXT.en.raised })).toHaveAttribute('lang', 'sk');
    expect(sk.panel.getByRole('list', { name: TEXT.en.lowered })).toHaveAttribute('lang', 'sk');
    sk.unmount();

    const none = await renderDrawer({
      explain: estimateExplain(MIXED),
      item: { ...ITEM, lang: null },
    });
    expect(none.panel.getByRole('list', { name: TEXT.en.raised })).not.toHaveAttribute('lang');
    expect(none.panel.getByRole('list', { name: TEXT.en.lowered })).not.toHaveAttribute('lang');
  });

  it('speaks Slovak in a Slovak interface', async () => {
    const { panel } = await renderDrawer({ language: 'sk', explain: estimateExplain(MIXED) });
    expect(panel.getByRole('heading', { name: TEXT.sk.heading })).toBeInTheDocument();
    expect(panel.getByRole('list', { name: TEXT.sk.raised })).toBeInTheDocument();
    expect(panel.getByRole('list', { name: TEXT.sk.lowered })).toBeInTheDocument();
    expect(panel.getByText(TEXT.sk.raised)).toBeInTheDocument();
    expect(panel.getByText(TEXT.sk.lowered)).toBeInTheDocument();
  });
});
