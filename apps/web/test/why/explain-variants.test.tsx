import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArticleDetail } from '../../src/features/article/article-detail.js';
import { WhyThisSheet } from '../../src/features/why/why-this-sheet.js';
import { failure, json } from '../api/fake-fetch.js';
import { labelRoute, makeDetail, makeMe, renderReader } from '../article/harness.js';
import { makeCard } from '../interests/support.js';
import {
  FACETS,
  ITEM,
  checkUnhandled,
  describeDrawer,
  drawerRoutes,
  makeExplain,
  makeUnscored,
  renderDrawer,
  settled,
  track,
} from './support.js';

checkUnhandled();

describe('the Why-this drawer renders every Explain variant', () => {
  it('cards with facets, every kind of rule, a translation and a cluster', async () => {
    const { dialog } = await renderDrawer({
      explain: makeExplain({
        facets: FACETS,
        rules: [
          { code: 'demote:clickbait' },
          { code: 'boost_feed', ruleId: '55' },
          { code: 'must:31', cardId: '31' },
          { code: 'never_soft:33', cardId: '33' },
          { code: 'seen_story' },
          { code: 'llm_answer' },
        ],
        translation: { engine: 'libretranslate', quality: 'ok' },
        cluster: { id: '9', size: 3 },
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      For you · 91 % · tier 5
      Scored from your interest cards.
      Scored from a machine translation of the article.
      This story is covered by 3 articles.
      ## Your interests
      - EV battery tech Strength: Love <meter "Match for EV battery tech" 91 % match> [Not really about this] [Yes, exactly this] [Edit card]
      - Solar power Strength: Like <meter "Match for Solar power" 42 % match> [Not really about this] [Yes, exactly this] [Edit card]
      ## About the article
      Type: News report
      Topic: Technology › Software development
      <img "Depth 3 of 5">
      - <meter "Clickbait" 82 %> [Never show me clickbait]
      - <meter "Promotional" 10 %> [Never show me promotional content]
      - <meter "Time-sensitive" 35 %> [Never show me outdated news]
      ## Rules applied
      - Demoted: clickbait
      - Boosted source [Undo]
      - Matches a must-see interest: EV battery tech
      - Held back by a never-show interest: Football
      - Story already seen
      - Judged by AI
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('cards without facets, rules, a translation or a cluster', async () => {
    const { dialog } = await renderDrawer({ explain: makeExplain() });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      For you · 91 % · tier 5
      Scored from your interest cards.
      ## Your interests
      - EV battery tech Strength: Love <meter "Match for EV battery tech" 91 % match> [Not really about this] [Yes, exactly this] [Edit card]
      - Solar power Strength: Like <meter "Match for Solar power" 42 % match> [Not really about this] [Yes, exactly this] [Edit card]
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('cards with preferences that are already on: no offer to switch them on, a reset to undo', async () => {
    const me = makeMe({
      preferences: {
        demote: { clickbait: 'on', promotional: 'auto', shallow: 'auto', stale: 'on' },
      },
    });
    const { dialog } = await renderDrawer({
      me,
      explain: makeExplain({
        facets: FACETS,
        rules: [{ code: 'demote:clickbait' }, { code: 'demote:stale' }],
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      For you · 91 % · tier 5
      Scored from your interest cards.
      ## Your interests
      - EV battery tech Strength: Love <meter "Match for EV battery tech" 91 % match> [Not really about this] [Yes, exactly this] [Edit card]
      - Solar power Strength: Like <meter "Match for Solar power" 42 % match> [Not really about this] [Yes, exactly this] [Edit card]
      ## About the article
      Type: News report
      Topic: Technology › Software development
      <img "Depth 3 of 5">
      - <meter "Clickbait" 82 %>
      - <meter "Promotional" 10 %> [Never show me promotional content]
      - <meter "Time-sensitive" 35 %>
      ## Rules applied
      - Demoted: clickbait [Reset]
      - Demoted: outdated [Reset]
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('a personal model, most contributing factor first', async () => {
    const { dialog } = await renderDrawer({
      explain: makeExplain({
        source: 'model',
        p: 0.74,
        tier: 4,
        cards: [],
        model: {
          version: 2,
          top: [
            { feature: 'cards.love', label: 'Matches for your Love interests', contribution: 0.2 },
            {
              feature: 'feed.7',
              label: 'You often dislike articles like this',
              contribution: -0.9,
            },
            { feature: 'card.31', label: 'Your card EV battery tech', contribution: 0.5 },
          ],
        },
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      For you · 74 % · tier 4
      Scored by your personal model, which learns from what you read and rate.
      ## Your interests
      No interest card has judged this article yet.
      ## Your personal model
      - You often dislike articles like this
      - Your card EV battery tech
      - Matches for your Love interests
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('the keyword fallback when the analysis was not available', async () => {
    const { dialog } = await renderDrawer({
      explain: makeExplain({
        source: 'degraded',
        p: 0.55,
        lane: 'maybe',
        tier: 3,
        cards: [],
        rules: [{ code: 'degraded' }],
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      Maybe · 55 % · tier 3
      Scored by keywords, because the analysis service wasn't available.
      ## Your interests
      No interest card has judged this article yet.
      ## Rules applied
      - Keyword match (model unavailable)
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('no score yet because the interests are still being matched', async () => {
    const { dialog } = await renderDrawer({
      explain: makeUnscored({ rules: [{ code: 'pending_cards' }] }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      New
      No interest card or model has scored this article.
      ## Your interests
      No interest card has judged this article yet.
      ## Rules applied
      - Interests still being matched
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('no score because no interest card applies', async () => {
    const { dialog } = await renderDrawer({ explain: makeUnscored() });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      New
      No interest card or model has scored this article.
      ## Your interests
      No interest card has judged this article yet.
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('hidden by a rule of the person, which can be taken back', async () => {
    const { dialog } = await renderDrawer({
      explain: makeUnscored({ lane: 'hidden', rules: [{ code: 'block_feed', ruleId: '12' }] }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      Hidden
      No interest card or model has scored this article.
      ## Your interests
      No interest card has judged this article yet.
      ## Rules applied
      - Blocked source [Undo]
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('hidden by a never-show interest, named by its card', async () => {
    const { dialog } = await renderDrawer({
      explain: makeUnscored({
        lane: 'hidden',
        cards: [{ id: '33', title: 'Football', strength: 'never', p: 0.8, engine: 'typesafe' }],
        rules: [{ code: 'never:33', cardId: '33' }],
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      Hidden
      No interest card or model has scored this article.
      ## Your interests
      - Football Strength: Never <meter "Match for Football" 80 % match> [Not really about this] [Yes, exactly this] [Edit card]
      ## Rules applied
      - Hidden by a never-show interest: Football
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('the neutral projection of an article whose analysis was not requested', async () => {
    const { dialog } = await renderDrawer({
      explain: makeUnscored({ rules: [{ code: 'inference_not_requested' }] }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      New
      Classification wasn't requested for this article, so it has no score.
      ## Your interests
      No interest card has judged this article yet.
      ## Rules applied
      - Not analyzed
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('an article with no stored explanation', async () => {
    const { dialog } = await renderDrawer({ explain: null });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Why this?
      Solid-state batteries reach the pilot line
      Not analyzed yet
      Bantoozi hasn't scored this article, so there is nothing to explain yet.
      ## What you can do
      [Make a card from this] [Boost this feed] [Block this feed] [Block this author]
      [Mute a keyword]
      [Close]"
    `);
  });

  it('the cards variant in Slovak', async () => {
    const { dialog } = await renderDrawer({
      language: 'sk',
      explain: makeExplain({
        facets: FACETS,
        rules: [
          { code: 'demote:clickbait' },
          { code: 'boost_feed', ruleId: '55' },
          { code: 'must:31', cardId: '31' },
        ],
        translation: { engine: 'libretranslate', quality: 'weak' },
        cluster: { id: '9', size: 3 },
      }),
    });

    expect(describeDrawer(dialog)).toMatchInlineSnapshot(`
      "## Prečo toto?
      Solid-state batteries reach the pilot line
      Pre vás · 91 % · úroveň 5
      Vyhodnotené podľa vašich kariet záujmov.
      Vyhodnotené podľa strojového prekladu, ktorý nemusí byť presný.
      O tejto udalosti informujú 3 články.
      ## Vaše záujmy
      - EV battery tech Sila: Milujem <meter "Zhoda s kartou EV battery tech" zhoda 91 %> [Nie je to celkom o tomto] [Áno, presne toto] [Upraviť kartu]
      - Solar power Sila: Páči sa mi <meter "Zhoda s kartou Solar power" zhoda 42 %> [Nie je to celkom o tomto] [Áno, presne toto] [Upraviť kartu]
      ## O článku
      Typ: Spravodajský článok
      Téma: Technológie › Vývoj softvéru
      <img "Hĺbka 3 z 5">
      - <meter "Klikbajt" 82 %> [Nikdy mi neukazovať klikbajt]
      - <meter "Reklamný obsah" 10 %> [Nikdy mi neukazovať reklamný obsah]
      - <meter "Časovo citlivé" 35 %> [Nikdy mi neukazovať zastarané správy]
      ## Použité pravidlá
      - Znížená priorita: klikbajt
      - Uprednostnený zdroj [Vrátiť späť]
      - Zhoduje sa so záujmom „musím vidieť“: EV battery tech
      ## Čo môžete urobiť
      [Vytvoriť kartu z tohto] [Uprednostniť tento zdroj] [Blokovať tento zdroj] [Blokovať tohto autora]
      [Stlmiť kľúčové slovo]
      [Zavrieť]"
    `);
  });
});

describe('the cards and the topics', () => {
  it('lists the cards by probability and shows each one as a labelled meter with its value in words', async () => {
    const { panel } = await renderDrawer({
      explain: makeExplain({
        cards: [
          { id: '32', title: 'Solar power', strength: 'like', p: 0.42, engine: 'typesafe' },
          { id: '31', title: 'EV battery tech', strength: 'love', p: 0.91, engine: 'typesafe' },
        ],
      }),
    });

    const rows = within(panel.getByRole('list', { name: 'Your interests' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName('EV battery tech');
    expect(rows[1]).toHaveAccessibleName('Solar power');
    const meter = panel.getByRole('meter', { name: 'Match for EV battery tech' });
    expect(meter).toHaveAttribute('aria-valuenow', '91');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuetext', '91 % match');
    expect(panel.getByRole('meter', { name: 'Match for Solar power' })).toHaveAttribute(
      'aria-valuetext',
      '42 % match',
    );
  });

  it('names a card as the person calls it now, and as the ranker stored it when the person no longer holds it', async () => {
    const { panel } = await renderDrawer({
      cards: [
        makeCard({ id: '31', title: 'Electric car batteries' }),
        makeCard({ id: '33', title: 'Football' }),
      ],
    });

    expect(panel.getByRole('listitem', { name: 'Electric car batteries' })).toBeInTheDocument();
    expect(panel.queryByRole('listitem', { name: 'EV battery tech' })).toBeNull();
    expect(panel.getByRole('listitem', { name: 'Solar power' })).toBeInTheDocument();
  });

  it('writes the topic in the language of the interface, the narrow topic after the broad one', async () => {
    const english = await renderDrawer({ explain: makeExplain({ facets: FACETS }) });
    expect(english.panel.getByText('Topic: Technology › Software development')).toBeInTheDocument();
    english.unmount();

    const slovak = await renderDrawer({ language: 'sk', explain: makeExplain({ facets: FACETS }) });
    expect(slovak.panel.getByText('Téma: Technológie › Vývoj softvéru')).toBeInTheDocument();
  });

  it('writes only the broad topic when the narrow one is not given or not in the taxonomy', async () => {
    const withoutNarrow = await renderDrawer({
      explain: makeExplain({
        facets: { ...FACETS, topic: { l1: 'science', p: 0.6 } },
      }),
    });
    expect(withoutNarrow.panel.getByText('Topic: Science')).toBeInTheDocument();
    withoutNarrow.unmount();

    const unknownNarrow = await renderDrawer({
      explain: makeExplain({
        facets: { ...FACETS, topic: { l1: 'science', p: 0.6, l2: 'science.unheard_of' } },
      }),
    });
    expect(unknownNarrow.panel.getByText('Topic: Science')).toBeInTheDocument();
  });

  it('says "Other" for a kind of article the interface has no word for', async () => {
    const { panel } = await renderDrawer({
      explain: makeExplain({
        facets: { ...FACETS, contentType: { choice: 'podcast_show', p: 0.5 } },
      }),
    });

    expect(panel.getByText('Type: Other')).toBeInTheDocument();
  });

  it('shows depth as five dots with the number said in words', async () => {
    const { panel } = await renderDrawer({
      explain: makeExplain({ facets: { ...FACETS, depth: 0.5 } }),
    });
    expect(panel.getByRole('img', { name: 'Depth 3 of 5' })).toBeInTheDocument();
  });

  it.each([
    [0, 'Depth 1 of 5'],
    [0.25, 'Depth 2 of 5'],
    [0.75, 'Depth 4 of 5'],
    [1, 'Depth 5 of 5'],
  ])('depth %s is %s', async (depth, name) => {
    const { panel } = await renderDrawer({
      explain: makeExplain({ facets: { ...FACETS, depth } }),
    });
    expect(panel.getByRole('img', { name })).toBeInTheDocument();
  });

  it('shows the three quality meters with their values in words', async () => {
    const { panel } = await renderDrawer({ explain: makeExplain({ facets: FACETS }) });
    expect(panel.getByRole('meter', { name: 'Clickbait' })).toHaveAttribute(
      'aria-valuetext',
      '82 %',
    );
    expect(panel.getByRole('meter', { name: 'Promotional' })).toHaveAttribute(
      'aria-valuetext',
      '10 %',
    );
    expect(panel.getByRole('meter', { name: 'Time-sensitive' })).toHaveAttribute(
      'aria-valuetext',
      '35 %',
    );
  });
});

describe('loading the explanation', () => {
  it('asks for the detail the way the article detail does and shares its cache entry', async () => {
    const { calls, queryClient } = track(
      renderReader(
        <>
          <ArticleDetail item={ITEM} sourceFeedId="7" />
          <WhyThisSheet item={ITEM} sourceFeedId="7" open onClose={() => {}} />
        </>,
        {
          routes: {
            ...drawerRoutes({ explain: makeExplain({ facets: FACETS }) }),
            ...labelRoute(),
          },
        },
      ),
    );

    expect(await screen.findByText('Type: News report')).toBeInTheDocument();
    expect(await screen.findByText('The excerpt of the article.')).toBeInTheDocument();
    await settled({ queryClient });
    const requests = calls('GET', '/articles/101');
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.query)).toEqual({ sourceFeedId: '7' });
  });

  it('asks for the saved copy in the bookmarks view', async () => {
    const { calls } = await renderDrawer({ saved: true });
    expect(Object.fromEntries(calls('GET', '/articles/101')[0]!.query)).toEqual({ view: 'saved' });
  });

  it('says it is loading, then shows the explanation', async () => {
    let answer: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { queryClient } = track(
      renderReader(<WhyThisSheet item={ITEM} open onClose={() => {}} />, {
        routes: { ...drawerRoutes(), 'GET /articles/:id': () => pending },
      }),
    );

    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    answer(json(200, makeDetail(ITEM, { explain: makeExplain() })));
    expect(await screen.findByText('For you · 91 % · tier 5')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    await settled({ queryClient });
  });

  it('offers a retry when the detail cannot be loaded and keeps the actions usable', async () => {
    let healthy = false;
    const { user } = await renderDrawer({
      routes: {
        'GET /articles/:id': () =>
          healthy
            ? json(200, makeDetail(ITEM, { explain: makeExplain() }))
            : failure(500, 'INTERNAL'),
      },
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make a card from this' })).toBeInTheDocument();

    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('For you · 91 % · tier 5')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
