import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { makeItem, renderReader } from '../article/harness.js';
import { checkUnhandled, makeExplain, renderDrawer, track } from './support.js';

checkUnhandled();

const ESTIMATE_RULES = [{ code: 'inference_not_requested' }, { code: 'estimate' }];

const estimateExplain = () =>
  makeExplain({
    source: 'estimate',
    p: 0.74,
    lane: 'new',
    tier: 4,
    cards: [],
    rules: ESTIMATE_RULES,
    estimate: { version: 1, top: [{ feature: 't:battery', label: 'battery', contribution: 0.8 }] },
  });

const VERDICT = {
  en: 'Estimated from the words of articles you rated.',
  sk: 'Odhad podľa slov článkov, ktoré ste hodnotili.',
} as const;
const NOT_REQUESTED = {
  en: "Classification wasn't requested for this article, so it has no score.",
  sk: 'Klasifikácia sa pre tento článok nevyžiadala, preto nemá skóre.',
} as const;
const RULE_TEXT = { en: 'Estimated from words', sk: 'Odhad podľa slov' } as const;

describe.each(['en', 'sk'] as const)('estimate strings in %s', (language) => {
  it('the Why sheet verdict says the score was estimated from words', async () => {
    const { dialog } = await renderDrawer({ language, explain: estimateExplain() });
    expect(dialog).toHaveTextContent(VERDICT[language]);
  });

  it('the Why sheet verdict never shows the raw source key or the not-requested sentence', async () => {
    const { dialog } = await renderDrawer({ language, explain: estimateExplain() });
    expect(dialog.textContent).not.toContain('source.estimate');
    expect(dialog.textContent).not.toContain(NOT_REQUESTED[language]);
  });

  it('the Why sheet names the estimate rule in words, not as an unknown rule', async () => {
    const app = await renderDrawer({ language, explain: estimateExplain() });
    expect(app.panel.getAllByText(RULE_TEXT[language]).length).toBeGreaterThan(0);
    expect(app.dialog.textContent).not.toContain('reason.rule.estimate');
    expect(app.dialog.textContent).not.toMatch(/Ranking rule|Pravidlo zoradenia/);
  });

  it('the row reason chip for rule estimate prints the words text', () => {
    track(
      renderReader(
        <ArticleRow
          item={makeItem({
            topReason: { kind: 'rule', code: 'estimate' },
            analysis: { mode: 'active', status: 'complete', requestId: null, overDailyCap: null },
          })}
          expanded={false}
          onToggleExpand={() => undefined}
          simple={false}
        />,
        { language },
      ),
    );
    expect(screen.getByText(RULE_TEXT[language])).toBeInTheDocument();
  });
});
