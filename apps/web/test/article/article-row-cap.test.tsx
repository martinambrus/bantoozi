import type { ArticleListItem } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';

import { makeItem, renderReader } from './harness.js';

/**
 * D-251 (spec 09 §3.2): the row badge of an article whose feed stopped automatic analysis for the
 * day. The list DTO keeps `status: 'not_requested'` and adds `analysis.overDailyCap: <cap>` (the
 * build adds the field to `ArticleAnalysisSchema`); the badge reads "Not analyzed – over daily
 * budget" (en dash) with a keyboard-reachable tooltip naming the cap. The row stays selectable
 * (nothing else about it changes).
 */

const TITLE = 'Solid-state batteries reach the pilot line';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-31T10:00:00.000Z'));
});

const capped = (cap: number | null): ArticleListItem =>
  makeItem({
    analysis: {
      mode: 'active',
      status: 'not_requested',
      requestId: null,
      overDailyCap: cap,
    } as ArticleListItem['analysis'],
  });

function renderRow(item: ArticleListItem, language?: 'en' | 'sk') {
  return renderReader(
    <ArticleRow item={item} expanded={false} onToggleExpand={vi.fn()} simple={false} />,
    language === undefined ? {} : { language },
  );
}

const row = () => screen.getByRole('article', { name: TITLE });

describe('over-daily-budget badge', () => {
  it('reads "Not analyzed – over daily budget" and explains the cap in a tooltip', () => {
    renderRow(capped(1000));
    const badge = within(row()).getByText('Not analyzed – over daily budget');
    expect(badge).toBeInTheDocument();
    expect(within(row()).queryByText('Not analyzed')).toBeNull();
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent(
      'Automatic analysis of this feed stops after 1000 new articles a day. Select it to analyze it anyway.',
    );
  });

  it('names the cap in force', () => {
    renderRow(capped(500));
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(
      'stops after 500 new articles a day',
    );
  });

  it('is reachable by keyboard and shows the tooltip on focus', () => {
    renderRow(capped(1000));
    const badge = within(row()).getByText('Not analyzed – over daily budget');
    const trigger = badge.closest<HTMLElement>('[aria-describedby]');
    expect(trigger).not.toBeNull();
    expect(trigger!.tabIndex).toBeGreaterThanOrEqual(0);
    expect(trigger).toHaveAccessibleDescription(/stops after 1000 new articles a day/);
    act(() => trigger!.focus());
    expect(screen.getByRole('tooltip')).toBeVisible();
  });

  it('keeps the plain "Not analyzed" badge when the arrival is not over cap', () => {
    renderRow(capped(null));
    expect(within(row()).getByText('Not analyzed')).toBeInTheDocument();
    expect(within(row()).queryByText(/over daily budget/)).toBeNull();
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('is translated: the Slovak badge and tooltip name the cap and are not the English text', () => {
    renderRow(capped(1000), 'sk');
    expect(within(row()).queryByText('Not analyzed – over daily budget')).toBeNull();
    expect(within(row()).queryByText('Neanalyzované')).toBeNull();
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent('1000');
    expect(tip.textContent).not.toMatch(/Automatic analysis of this feed/);
  });
});
