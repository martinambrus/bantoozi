import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { json } from '../api/fake-fetch.js';
import { bodyOf, makeItem, makeMe, renderReader } from '../article/harness.js';
import { cardResult, makeCard } from '../interests/support.js';
import { checkUnhandled, makeExplain, renderDrawer, track } from './support.js';

checkUnhandled();

const SENTENCE = 'Ranked lower: like 3 articles you disliked: EV battery tech';
const RULE = { code: 'demote:similar:31', cardId: '31', detail: '3' };
const FORK = makeCard({
  id: '35',
  title: 'EV battery tech',
  strength: 'love',
  origin: 'fork',
  isPrivateFork: true,
});

const explain = () => makeExplain({ rules: [RULE] });
const meWith = (similar: 'auto' | 'on' | 'off') =>
  makeMe({
    preferences: {
      demote: { clickbait: 'auto', promotional: 'auto', shallow: 'auto', stale: 'auto', similar },
    },
  });

describe('the similar-to-disliked rule in "Why this?"', () => {
  it('W1 says how many articles it is like, for the card', async () => {
    const app = await renderDrawer({ explain: explain() });

    expect(app.panel.getByRole('listitem', { name: SENTENCE })).toBeInTheDocument();
  });

  it.each(['auto', 'on'] as const)(
    'W2 "Don\'t lower these" turns demote.similar off while it is %s',
    async (state) => {
      const app = await renderDrawer({
        me: meWith(state),
        explain: explain(),
        routes: { 'PATCH /me': () => json(200, meWith('off')) },
      });

      await app.user.click(app.panel.getByRole('button', { name: "Don't lower these" }));

      await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));
      expect(bodyOf(app.calls('PATCH', '/me')[0]!)).toEqual({
        preferences: { demote: { similar: 'off' } },
      });
    },
  );

  it('W3 "Teach EV battery tech: not this" sends this article as a no example', async () => {
    const app = await renderDrawer({
      explain: explain(),
      routes: {
        'POST /cards/:id/examples': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
      },
    });

    await app.user.click(
      app.panel.getByRole('button', { name: 'Teach EV battery tech: not this' }),
    );

    await waitFor(() => expect(app.calls('POST', '/cards/31/examples')).toHaveLength(1));
    expect(bodyOf(app.calls('POST', '/cards/31/examples')[0]!)).toEqual({
      articleId: '101',
      side: 'no',
    });
  });

  it('W4 reads "Ranked lower: like articles you disliked" as the top reason', () => {
    const item = makeItem({ topReason: { kind: 'rule', code: 'demote:similar:31' } });
    track(
      renderReader(
        <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />,
      ),
    );

    expect(screen.getByText('Ranked lower: like articles you disliked')).toBeInTheDocument();
  });
});
