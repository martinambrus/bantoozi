import { MAX_ANALYZE_ARTICLES } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  MAX_SELECTED_ARTICLES,
  useArticleSelection,
  type ArticleSelection,
} from '../../src/features/training/selection.js';
import { renderReader } from '../article/harness.js';
import { articles } from '../onboarding/support.js';

function Probe({ run }: { run: (selection: ArticleSelection) => void }) {
  const selection = useArticleSelection();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          run(selection);
        }}
      >
        run
      </button>
      <ol aria-label="selected">
        {selection.items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ol>
    </>
  );
}

async function operate(run: (selection: ArticleSelection) => void) {
  const view = renderReader(<Probe run={run} />);
  const step = async () => {
    await view.user.click(screen.getByRole('button', { name: 'run' }));
  };
  return { ...view, step };
}

const shown = () =>
  within(screen.getByRole('list', { name: 'selected' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('useArticleSelection', () => {
  it('allows as many articles as the API takes at once, 20', () => {
    expect(MAX_SELECTED_ARTICLES).toBe(MAX_ANALYZE_ARTICLES);
    expect(MAX_SELECTED_ARTICLES).toBe(20);
  });

  it('keeps the articles in the order they were selected', async () => {
    const [one, two, three] = articles(1, 3);
    const { step } = await operate((selection) => {
      selection.toggle(three!, true);
      selection.toggle(one!, true);
      selection.toggle(two!, true);
    });

    await step();

    expect(shown()).toEqual(['Article 3', 'Article 1', 'Article 2']);
  });

  it('selects an article once, where it was first, and says it is selected', async () => {
    const [one, two] = articles(1, 2);
    const answers: boolean[] = [];
    const { step } = await operate((selection) => {
      answers.push(selection.toggle(one!, true), selection.toggle(two!, true));
      answers.push(selection.toggle(one!, true));
    });

    await step();

    expect(shown()).toEqual(['Article 1', 'Article 2']);
    expect(answers).toEqual([true, true, true]);
  });

  it('knows the articles it holds once it has rendered', async () => {
    const [one, two] = articles(1, 2);
    const answers: boolean[] = [];
    let phase = 0;
    const { step } = await operate((selection) => {
      phase += 1;
      if (phase === 1) selection.toggle(one!, true);
      else answers.push(selection.has('1'), selection.has('2'), selection.toggle(two!, false));
    });

    await step();
    await step();

    expect(answers).toEqual([true, false, true]);
  });

  it('deselects an article, and does not mind one that is not selected', async () => {
    const [one, two, three] = articles(1, 3);
    const { step } = await operate((selection) => {
      selection.toggle(one!, true);
      selection.toggle(two!, true);
      selection.toggle(three!, true);
      selection.toggle(two!, false);
      selection.toggle(articles(9, 9)[0]!, false);
    });

    await step();

    expect(shown()).toEqual(['Article 1', 'Article 3']);
  });

  it('refuses the 21st article in the same tick as the first twenty, and says so', async () => {
    const answers: boolean[] = [];
    const { step } = await operate((selection) => {
      for (const item of articles(1, 21)) answers.push(selection.toggle(item, true));
    });

    await step();

    expect(answers).toEqual([...Array.from({ length: 20 }, () => true), false]);
    expect(shown()).toHaveLength(20);
    expect(shown()).not.toContain('Article 21');
    expect(await screen.findByText('You can select at most 20 articles at a time.')).toBeVisible();
  });

  it('still answers yes for an article that is selected when the selection is full', async () => {
    const all = articles(1, 21);
    const answers: boolean[] = [];
    const { step } = await operate((selection) => {
      for (const item of all.slice(0, 20)) selection.toggle(item, true);
      answers.push(selection.toggle(all[3]!, true));
      selection.toggle(all[3]!, false);
      answers.push(selection.toggle(all[20]!, true));
    });

    await step();

    expect(answers).toEqual([true, true]);
    expect(shown()).toHaveLength(20);
    expect(shown().at(-1)).toBe('Article 21');
    expect(screen.queryByText('You can select at most 20 articles at a time.')).toBeNull();
  });

  it('removes articles by id and clears them all', async () => {
    let phase = 0;
    const { step } = await operate((selection) => {
      phase += 1;
      if (phase === 1) {
        for (const item of articles(1, 5)) selection.toggle(item, true);
        selection.remove(['2', '4', '99']);
      } else {
        selection.clear();
      }
    });

    await step();
    expect(shown()).toEqual(['Article 1', 'Article 3', 'Article 5']);

    await step();
    expect(shown()).toEqual([]);
  });

  it('can be filled again after a clear', async () => {
    let phase = 0;
    const { step } = await operate((selection) => {
      phase += 1;
      if (phase === 1) for (const item of articles(1, 20)) selection.toggle(item, true);
      else if (phase === 2) selection.clear();
      else selection.toggle(articles(30, 30)[0]!, true);
    });

    await step();
    await step();
    await step();

    expect(shown()).toEqual(['Article 30']);
  });
});
