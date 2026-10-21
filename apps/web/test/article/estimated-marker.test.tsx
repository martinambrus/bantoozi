import type { ArticleListItem } from '@bantoozi/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { makeItem, renderReader } from './harness.js';

const TITLE = 'Solid-state batteries reach the pilot line';

function estimated(overrides: Partial<ArticleListItem> = {}): ArticleListItem {
  return makeItem({
    lane: 'new',
    tier: 3,
    pLike: 0.7,
    topReason: null,
    analysis: { mode: 'training', status: 'not_requested', requestId: null, overDailyCap: null },
    ...overrides,
  });
}

function renderRow(item: ArticleListItem, onWhyThis?: () => void, language?: 'en' | 'sk') {
  const ui = (
    <ArticleRow
      item={item}
      expanded={false}
      onToggleExpand={vi.fn()}
      simple={false}
      onWhyThis={onWhyThis}
    />
  );
  return renderReader(ui, language === undefined ? {} : { language });
}

const row = () => screen.getByRole('article', { name: TITLE });
const dots = (root: HTMLElement) => root.querySelectorAll('[data-dot="outlined"]');

describe('Estimated marker in the article row', () => {
  it('is a button that opens Why this? and shows one hollow dot per tier', () => {
    const onWhyThis = vi.fn();
    renderRow(estimated(), onWhyThis);
    const button = within(row()).getByRole('button', {
      name: 'Estimated, tier 3 of 5, Why this?',
    });
    expect(dots(button)).toHaveLength(3);
    expect(within(button).getByText('Estimated')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onWhyThis).toHaveBeenCalledTimes(1);
  });

  it('is a plain labelled image without a Why this? handler', () => {
    renderRow(estimated());
    expect(within(row()).getByRole('img', { name: 'Estimated, tier 3 of 5' })).toBeInTheDocument();
    expect(within(row()).queryByRole('button', { name: /Estimated/ })).toBeNull();
  });

  it.each([1, 2, 3, 4, 5])('shows as many dots as the tier, tier %i', (tier) => {
    renderRow(estimated({ tier } as Partial<ArticleListItem>), vi.fn());
    expect(dots(row())).toHaveLength(tier);
  });

  it('leaves an analysed row unmarked and keeps its reason chip', () => {
    const item = makeItem();
    renderRow(item, vi.fn());
    expect(within(row()).queryByText('Estimated')).toBeNull();
    expect(dots(row())).toHaveLength(0);
    expect(within(row()).getByRole('button', { name: /Why this\?$/ })).toBeInTheDocument();
  });

  it('leaves an unscored row without marker and chip line', () => {
    renderRow(estimated({ tier: null } as Partial<ArticleListItem>), vi.fn());
    expect(within(row()).queryByText('Estimated')).toBeNull();
    expect(dots(row())).toHaveLength(0);
    expect(within(row()).queryByRole('button', { name: /Why this\?$/ })).toBeNull();
  });

  it.each(['hidden', 'everything'])('does not mark a %s-lane row with a tier', (lane) => {
    renderRow(estimated({ lane } as Partial<ArticleListItem>), vi.fn());
    expect(within(row()).queryByText('Estimated')).toBeNull();
    expect(dots(row())).toHaveLength(0);
  });

  it('is named in Slovak', () => {
    renderRow(estimated(), vi.fn(), 'sk');
    const button = within(row()).getByRole('button', {
      name: 'Odhad, úroveň 3 z 5, Prečo toto?',
    });
    expect(within(button).getByText('Odhad')).toBeInTheDocument();
  });

  it('draws the dots as rings without a fill', () => {
    renderRow(estimated(), vi.fn());
    const list = Array.from(dots(row()));
    expect(list.length).toBeGreaterThan(0);
    for (const dot of list) {
      expect(dot.className).toContain('border-2');
      expect(dot.className).not.toContain('bg-');
    }
  });
});
