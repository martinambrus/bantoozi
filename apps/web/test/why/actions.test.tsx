import type { CardDto, Me } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { cardsKey } from '../../src/features/interests/queries.js';
import { WhyThisSheet } from '../../src/features/why/why-this-sheet.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { bodyOf, findToast, makeItem, makeMe, makeRule } from '../article/harness.js';
import { cardResult, gate, makeCard } from '../interests/support.js';
import { USER_A_ID, USER_B_ID } from '../session/fixtures.js';
import { FACETS, checkUnhandled, makeExplain, renderDrawer, settled } from './support.js';

checkUnhandled();

type Demote = Me['preferences']['demote'];

function meWith(demote: Partial<Demote>): Me {
  return makeMe({
    preferences: {
      demote: { clickbait: 'auto', promotional: 'auto', shallow: 'auto', stale: 'auto', ...demote },
    },
  });
}

const WITH_FACETS = makeExplain({ facets: FACETS });

/** PATCH /me as the server answers it: the demotions it was sent, the others automatic. */
function savesDemotions(request: Parameters<typeof bodyOf>[0]) {
  const { preferences } = bodyOf(request) as { preferences: { demote: Partial<Demote> } };
  return json(200, meWith(preferences.demote));
}

function ruleRow(app: Awaited<ReturnType<typeof renderDrawer>>, sentence: string) {
  return within(app.panel.getByRole('listitem', { name: sentence }));
}

describe('"Never show me …"', () => {
  it.each([
    ['clickbait', 'clickbait', 'Clickbait will be ranked lower from now on'],
    ['promotional', 'promotional', 'Promotional content will be ranked lower from now on'],
    ['time-sensitive', 'stale', 'Outdated news will be ranked lower from now on'],
  ] as const)('for %s switches demote.%s on', async (flag, key, message) => {
    const button =
      flag === 'clickbait'
        ? 'Never show me clickbait'
        : flag === 'promotional'
          ? 'Never show me promotional content'
          : 'Never show me outdated news';
    const app = await renderDrawer({
      explain: WITH_FACETS,
      routes: { 'PATCH /me': () => json(200, meWith({ [key]: 'on' })) },
    });

    await app.user.click(app.panel.getByRole('button', { name: button }));

    expect(await findToast(message)).toBeInTheDocument();
    const requests = app.calls('PATCH', '/me');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ preferences: { demote: { [key]: 'on' } } });
    expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.panel.queryByRole('button', { name: button })).toBeNull();
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));
  });

  it('takes the preference back to automatic from the toast', async () => {
    let current = meWith({});
    const app = await renderDrawer({
      explain: WITH_FACETS,
      routes: {
        'PATCH /me': (request) => {
          const { preferences } = bodyOf(request) as { preferences: { demote: Partial<Demote> } };
          current = meWith(preferences.demote);
          return json(200, current);
        },
      },
    });
    await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
    const toast = await findToast('Clickbait will be ranked lower from now on');

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(2));
    expect(bodyOf(app.calls('PATCH', '/me')[1]!)).toEqual({
      preferences: { demote: { clickbait: 'auto' } },
    });
    expect(
      await app.panel.findByRole('button', { name: 'Never show me clickbait' }),
    ).toBeInTheDocument();
  });

  it('puts back a preference that was off', async () => {
    const app = await renderDrawer({
      me: meWith({ clickbait: 'off' }),
      explain: WITH_FACETS,
      routes: { 'PATCH /me': savesDemotions },
    });
    await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
    const toast = await findToast('Clickbait will be ranked lower from now on');

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    expect(await findToast("Clickbait won't be ranked lower any more")).toBeInTheDocument();
    expect(app.calls('PATCH', '/me')).toHaveLength(2);
    expect(bodyOf(app.calls('PATCH', '/me')[1]!)).toEqual({
      preferences: { demote: { clickbait: 'off' } },
    });
  });

  it('confirms with an undo when the answer comes after the drawer has closed', async () => {
    let answer: (response: Response) => void = () => {};
    const app = await renderDrawer({
      explain: WITH_FACETS,
      routes: {
        'PATCH /me': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      },
    });
    await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
    await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    answer(json(200, meWith({ clickbait: 'on' })));

    const toast = await findToast('Clickbait will be ranked lower from now on');
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('confirms nothing when the answer comes once another account has signed in', async () => {
    let answer: (response: Response) => void = () => {};
    const app = await renderDrawer({
      explain: WITH_FACETS,
      routes: {
        'PATCH /me': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      },
    });
    await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
    await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    app.signInAgain(makeMe({ id: USER_B_ID }));
    answer(json(200, meWith({ clickbait: 'on' })));
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    await settled(app);

    expect(screen.queryByText('Clickbait will be ranked lower from now on')).toBeNull();
  });

  it('is not offered for a preference that is already on', async () => {
    const app = await renderDrawer({
      me: meWith({ promotional: 'on' }),
      explain: WITH_FACETS,
    });

    expect(app.panel.getByRole('button', { name: 'Never show me clickbait' })).toBeInTheDocument();
    expect(
      app.panel.queryByRole('button', { name: 'Never show me promotional content' }),
    ).toBeNull();
    expect(
      app.panel.getByRole('button', { name: 'Never show me outdated news' }),
    ).toBeInTheDocument();
  });

  it('says why when the preference cannot be saved and keeps the offer', async () => {
    const app = await renderDrawer({
      explain: WITH_FACETS,
      routes: { 'PATCH /me': () => failure(500, 'INTERNAL') },
    });

    await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));

    expect(await findToast('Something went wrong on our side. Try again.')).toHaveAttribute(
      'data-tone',
      'error',
    );
    expect(app.panel.getByRole('button', { name: 'Never show me clickbait' })).toBeEnabled();
  });
});

describe('the rules that were applied', () => {
  it('"Undo" deletes the rule, reloads the article and takes the rule off the list', async () => {
    const app = await renderDrawer({
      explain: makeExplain({
        rules: [{ code: 'boost_feed', ruleId: '55' }, { code: 'seen_story' }],
      }),
      routes: { 'DELETE /rules/:id': () => noContent() },
    });

    await app.user.click(ruleRow(app, 'Boosted source').getByRole('button', { name: 'Undo' }));

    expect(await findToast('Rule removed')).toBeInTheDocument();
    expect(app.calls('DELETE', '/rules/55')).toHaveLength(1);
    expect(app.calls('DELETE', '/rules/55')[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.panel.queryByRole('listitem', { name: 'Boosted source' })).toBeNull();
    expect(app.panel.getByRole('listitem', { name: 'Story already seen' })).toBeInTheDocument();
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));
  });

  it('offers "Undo" only for a rule that has an id', async () => {
    const app = await renderDrawer({
      explain: makeExplain({
        rules: [
          { code: 'boost_feed', ruleId: '55' },
          { code: 'seen_story' },
          { code: 'llm_answer' },
        ],
      }),
    });

    expect(
      within(app.panel.getByRole('list', { name: 'Rules applied' })).getAllByRole('button'),
    ).toHaveLength(1);
    expect(ruleRow(app, 'Story already seen').queryByRole('button')).toBeNull();
  });

  it('confirms nothing when the deletion is answered once another account has signed in', async () => {
    const answer = gate();
    const app = await renderDrawer({
      explain: makeExplain({ rules: [{ code: 'boost_feed', ruleId: '55' }] }),
      routes: {
        'DELETE /rules/:id': async () => {
          await answer.opened;
          return noContent();
        },
      },
    });
    await app.user.click(ruleRow(app, 'Boosted source').getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/55')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    app.signInAgain(makeMe({ id: USER_B_ID }));
    answer.release();
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    await settled(app);

    expect(screen.queryByText('Rule removed')).toBeNull();
  });

  it('keeps the rule on the list when it cannot be deleted', async () => {
    const app = await renderDrawer({
      explain: makeExplain({ rules: [{ code: 'block_feed', ruleId: '12' }] }),
      routes: { 'DELETE /rules/:id': () => failure(404, 'NOT_FOUND') },
    });

    await app.user.click(ruleRow(app, 'Blocked source').getByRole('button', { name: 'Undo' }));

    expect(await findToast("We couldn't find that.")).toHaveAttribute('data-tone', 'error');
    expect(ruleRow(app, 'Blocked source').getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('"Reset" puts a demotion back to automatic', async () => {
    const app = await renderDrawer({
      me: meWith({ clickbait: 'on' }),
      explain: makeExplain({ rules: [{ code: 'demote:clickbait' }, { code: 'demote:stale' }] }),
      routes: { 'PATCH /me': () => json(200, meWith({})) },
    });

    await app.user.click(ruleRow(app, 'Demoted: clickbait').getByRole('button', { name: 'Reset' }));

    expect(await findToast('Back to automatic')).toBeInTheDocument();
    const requests = app.calls('PATCH', '/me');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ preferences: { demote: { clickbait: 'auto' } } });
    expect(app.panel.queryByRole('listitem', { name: 'Demoted: clickbait' })).toBeNull();
    expect(app.panel.getByRole('listitem', { name: 'Demoted: outdated' })).toBeInTheDocument();
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));
  });

  it('"Turn off" stops an automatic demotion, and its undo hands it back', async () => {
    const app = await renderDrawer({
      explain: makeExplain({ rules: [{ code: 'demote:shallow' }] }),
      routes: { 'PATCH /me': savesDemotions },
    });
    expect(ruleRow(app, 'Demoted: shallow').queryByRole('button', { name: 'Reset' })).toBeNull();

    await app.user.click(
      ruleRow(app, 'Demoted: shallow').getByRole('button', { name: 'Turn off' }),
    );

    const toast = await findToast("Shallow articles won't be ranked lower any more");
    expect(bodyOf(app.calls('PATCH', '/me')[0]!)).toEqual({
      preferences: { demote: { shallow: 'off' } },
    });
    expect(app.panel.queryByRole('listitem', { name: 'Demoted: shallow' })).toBeNull();
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    expect(await findToast('Back to automatic')).toBeInTheDocument();
    expect(app.calls('PATCH', '/me')).toHaveLength(2);
    expect(bodyOf(app.calls('PATCH', '/me')[1]!)).toEqual({
      preferences: { demote: { shallow: 'auto' } },
    });
  });

  describe('and "Never show me …" for the same demotion', () => {
    function heldDrawer() {
      const held = gate();
      const app = renderDrawer({
        explain: makeExplain({ facets: FACETS, rules: [{ code: 'demote:clickbait' }] }),
        routes: {
          'PATCH /me': async (request) => {
            await held.opened;
            return savesDemotions(request);
          },
        },
      });
      return { held, app };
    }

    it('"Turn off" waits while "Never show me" is on its way', async () => {
      const { held, app: rendered } = heldDrawer();
      const app = await rendered;

      await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
      await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));

      expect(
        ruleRow(app, 'Demoted: clickbait').getByRole('button', { name: 'Turn off' }),
      ).toBeDisabled();
      held.release();
      expect(await findToast('Clickbait will be ranked lower from now on')).toBeInTheDocument();
      expect(app.calls('PATCH', '/me')).toHaveLength(1);
    });

    it('"Never show me" waits while "Turn off" is on its way', async () => {
      const { held, app: rendered } = heldDrawer();
      const app = await rendered;

      await app.user.click(
        ruleRow(app, 'Demoted: clickbait').getByRole('button', { name: 'Turn off' }),
      );
      await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(1));

      expect(app.panel.getByRole('button', { name: 'Never show me clickbait' })).toBeDisabled();
      held.release();
      expect(await findToast("Clickbait won't be ranked lower any more")).toBeInTheDocument();
      expect(app.calls('PATCH', '/me')).toHaveLength(1);
    });

    it('an undo from a toast waits while a later change is on its way', async () => {
      const held = gate();
      let patches = 0;
      const app = await renderDrawer({
        explain: makeExplain({ facets: FACETS, rules: [{ code: 'demote:clickbait' }] }),
        routes: {
          'PATCH /me': async (request) => {
            patches += 1;
            if (patches === 2) await held.opened;
            return savesDemotions(request);
          },
        },
      });
      await app.user.click(
        ruleRow(app, 'Demoted: clickbait').getByRole('button', { name: 'Turn off' }),
      );
      const turnedOff = await findToast("Clickbait won't be ranked lower any more");
      await app.user.click(app.panel.getByRole('button', { name: 'Never show me clickbait' }));
      await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(2));

      await app.user.click(within(turnedOff).getByRole('button', { name: 'Undo' }));
      await settled(app);
      expect(app.calls('PATCH', '/me')).toHaveLength(2);

      held.release();
      await waitFor(() => expect(app.calls('PATCH', '/me')).toHaveLength(3));
      expect(app.calls('PATCH', '/me').map((request) => bodyOf(request))).toEqual([
        { preferences: { demote: { clickbait: 'off' } } },
        { preferences: { demote: { clickbait: 'on' } } },
        { preferences: { demote: { clickbait: 'auto' } } },
      ]);
      expect(await findToast('Back to automatic')).toBeInTheDocument();
    });
  });

  it('offers nothing for a demotion that is already off', async () => {
    const app = await renderDrawer({
      me: meWith({ stale: 'off' }),
      explain: makeExplain({ rules: [{ code: 'demote:stale' }] }),
    });

    expect(app.panel.getByRole('listitem', { name: 'Demoted: outdated' })).toBeInTheDocument();
    expect(ruleRow(app, 'Demoted: outdated').queryByRole('button')).toBeNull();
  });
});

describe('make a card from this', () => {
  const TITLE = 'Solid-state batteries reach the pilot line';

  it('starts the editor from the title and creates the card from the article', async () => {
    const created = makeCard({
      id: '41',
      title: TITLE,
      interest: TITLE,
      origin: 'fork',
      isPrivateFork: true,
      examplesYes: [TITLE],
    });
    const app = await renderDrawer({
      routes: { 'POST /cards/from-article': () => json(201, cardResult(created)) },
    });

    await app.user.click(app.panel.getByRole('button', { name: 'Make a card from this' }));

    const editor = await screen.findByRole('dialog', { name: 'New card from this article' });
    expect(within(editor).getByLabelText('I want to read about…')).toHaveValue(TITLE);
    await app.user.click(within(editor).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('POST', '/cards/from-article')).toHaveLength(1));
    const [request] = app.calls('POST', '/cards/from-article');
    expect(bodyOf(request!)).toEqual({ articleId: '101', interest: TITLE, strength: 'like' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New card from this article' })).toBeNull(),
    );
    expect(
      app.queryClient.getQueryData<CardDto[]>(cardsKey(USER_A_ID))?.map((card) => card.id),
    ).toEqual(['31', '32', '33', '41']);
    expect(app.calls('POST', '/cards')).toHaveLength(0);
  });
});

describe('mute a keyword', () => {
  it('lists the words of the title, once each and without their punctuation', async () => {
    const app = await renderDrawer({
      item: makeItem({ title: '“Batteries”: the new batteries, the old (and cheap) cars!' }),
    });

    await app.user.click(app.panel.getByRole('button', { name: 'Mute a keyword' }));

    const words = within(await screen.findByRole('menu', { name: 'Mute a keyword' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(words).toEqual(['Batteries', 'the', 'new', 'old', 'and', 'cheap', 'cars']);
  });

  it('creates a mute_keyword rule for the chosen word and can take it back', async () => {
    const app = await renderDrawer({
      routes: {
        'POST /rules': () => json(201, { rule: makeRule('77', 'mute_keyword', 'batteries') }),
        'DELETE /rules/:id': () => noContent(),
      },
    });

    await app.user.click(app.panel.getByRole('button', { name: 'Mute a keyword' }));
    await app.user.click(await screen.findByRole('menuitem', { name: 'batteries' }));

    const toast = await findToast('Muted keyword: “batteries”');
    const [request] = app.calls('POST', '/rules');
    expect(bodyOf(request!)).toEqual({ kind: 'mute_keyword', value: 'batteries' });
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(app.calls('GET', '/articles/101')).toHaveLength(2));

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/77')).toHaveLength(1));
    expect(await findToast('Rule removed')).toBeInTheDocument();
  });

  /** `POST /rules` as the API answers a mute: the rule gets the id its word has here. */
  const RULE_IDS: Record<string, string> = { batteries: '77', pilot: '78' };
  function mutes(request: Parameters<typeof bodyOf>[0]) {
    const { value } = bodyOf(request) as { value: string };
    return json(201, { rule: makeRule(RULE_IDS[value] ?? '79', 'mute_keyword', value) });
  }

  async function mute(app: Awaited<ReturnType<typeof renderDrawer>>, word: string) {
    await app.user.click(app.panel.getByRole('button', { name: 'Mute a keyword' }));
    await app.user.click(await screen.findByRole('menuitem', { name: word }));
  }

  it('confirms two words muted in quick succession, each undo taking back its own rule', async () => {
    const first = gate();
    const app = await renderDrawer({
      routes: {
        'POST /rules': async (request) => {
          if ((bodyOf(request) as { value: string }).value === 'batteries') await first.opened;
          return mutes(request);
        },
        'DELETE /rules/:id': () => noContent(),
      },
    });

    await mute(app, 'batteries');
    await waitFor(() => expect(app.calls('POST', '/rules')).toHaveLength(1));
    await mute(app, 'pilot');
    const pilot = await findToast('Muted keyword: “pilot”');
    first.release();
    const batteries = await findToast('Muted keyword: “batteries”');

    await app.user.click(within(batteries).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/77')).toHaveLength(1));
    expect(app.calls('DELETE', '/rules/78')).toHaveLength(0);
    await app.user.click(within(pilot).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/78')).toHaveLength(1));
    expect(app.calls('DELETE', '/rules/77')).toHaveLength(1);
  });

  it('confirms with an undo when the answer comes after the drawer has closed', async () => {
    const answer = gate();
    const app = await renderDrawer({
      routes: {
        'POST /rules': async (request) => {
          await answer.opened;
          return mutes(request);
        },
        'DELETE /rules/:id': () => noContent(),
      },
    });
    await mute(app, 'batteries');
    await waitFor(() => expect(app.calls('POST', '/rules')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    answer.release();

    const toast = await findToast('Muted keyword: “batteries”');
    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/77')).toHaveLength(1));
    expect(await findToast('Rule removed')).toBeInTheDocument();
  });

  it('confirms nothing when the answer comes once another account has signed in', async () => {
    const answer = gate();
    const app = await renderDrawer({
      routes: {
        'POST /rules': async (request) => {
          await answer.opened;
          return mutes(request);
        },
      },
    });
    await mute(app, 'batteries');
    await waitFor(() => expect(app.calls('POST', '/rules')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    app.signInAgain(makeMe({ id: USER_B_ID }));
    answer.release();
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    await settled(app);

    expect(screen.queryByText('Muted keyword: “batteries”')).toBeNull();
  });

  it('reports no refusal that comes once another account has signed in', async () => {
    const answer = gate();
    const app = await renderDrawer({
      routes: {
        'POST /rules': async () => {
          await answer.opened;
          return failure(409, 'QUOTA_EXCEEDED', { limit: 'maxRules', used: 200, max: 200 });
        },
      },
    });
    await mute(app, 'pilot');
    await waitFor(() => expect(app.calls('POST', '/rules')).toHaveLength(1));

    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    app.signInAgain(makeMe({ id: USER_B_ID }));
    answer.release();
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    await settled(app);

    expect(
      screen.queryByText("You've reached your plan's limit for rules: 200 of 200."),
    ).toBeNull();
  });

  it('takes back nothing from its toast once another account has signed in', async () => {
    const app = await renderDrawer({
      routes: { 'POST /rules': mutes, 'DELETE /rules/:id': () => noContent() },
    });
    await mute(app, 'batteries');
    await findToast('Muted keyword: “batteries”');

    // The toast moves out of the drawer when it closes.
    app.rerender(<WhyThisSheet item={app.item} open={false} onClose={app.onClose} />);
    app.signInAgain(makeMe({ id: USER_B_ID }));
    const toast = await findToast('Muted keyword: “batteries”');
    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await settled(app);

    expect(app.calls('DELETE', '/rules/77')).toHaveLength(0);
  });

  it('says why when the rule cannot be created', async () => {
    const app = await renderDrawer({
      routes: {
        'POST /rules': () =>
          failure(409, 'QUOTA_EXCEEDED', { limit: 'maxRules', used: 200, max: 200 }),
      },
    });

    await app.user.click(app.panel.getByRole('button', { name: 'Mute a keyword' }));
    await app.user.click(await screen.findByRole('menuitem', { name: 'pilot' }));

    expect(
      await findToast("You've reached your plan's limit for rules: 200 of 200."),
    ).toHaveAttribute('data-tone', 'error');
  });

  it('is not offered for a title without a usable word', async () => {
    const app = await renderDrawer({ item: makeItem({ title: '? !' }) });

    expect(app.panel.queryByRole('button', { name: 'Mute a keyword' })).toBeNull();
  });
});

describe('boost and block', () => {
  it.each([
    ['Boost this feed', { kind: 'boost_feed', value: '7' }, 'Boosted source: Example Weekly'],
    ['Block this feed', { kind: 'block_feed', value: '7' }, 'Blocked source: Example Weekly'],
    ['Block this author', { kind: 'block_author', value: 'Jane Doe' }, 'Blocked author: Jane Doe'],
  ])('%s creates the rule and can take it back', async (name, body, message) => {
    const app = await renderDrawer({
      routes: {
        'POST /rules': () => json(201, { rule: makeRule('88', body.kind, body.value) }),
        'DELETE /rules/:id': () => noContent(),
      },
    });

    await app.user.click(app.panel.getByRole('button', { name }));

    const toast = await findToast(message);
    expect(bodyOf(app.calls('POST', '/rules')[0]!)).toEqual(body);
    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(app.calls('DELETE', '/rules/88')).toHaveLength(1));
  });

  it('offers neither without a feed or an author to base a rule on', async () => {
    const app = await renderDrawer({ item: makeItem({ feed: null, author: null }) });

    for (const name of ['Boost this feed', 'Block this feed', 'Block this author']) {
      expect(app.panel.queryByRole('button', { name })).toBeNull();
    }
    expect(app.panel.getByRole('button', { name: 'Make a card from this' })).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('names every control and gives it a 44 px target and a focus ring', async () => {
    const app = await renderDrawer({
      me: meWith({ promotional: 'on' }),
      explain: makeExplain({
        facets: FACETS,
        rules: [{ code: 'boost_feed', ruleId: '55' }, { code: 'demote:promotional' }],
      }),
    });

    const controls = within(app.dialog).getAllByRole('button');
    expect(controls.length).toBeGreaterThanOrEqual(12);
    for (const control of controls) {
      expect(control).toHaveAccessibleName();
      expect(control.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(control.className).toContain(token);
    }
    await app.user.click(app.panel.getByRole('button', { name: 'Mute a keyword' }));
    for (const item of await screen.findAllByRole('menuitem')) {
      expect(item).toHaveAccessibleName();
      expect(item.className).toContain('min-h-11');
    }
  });

  it('gives the buttons of a row the name of the interest or rule they belong to', async () => {
    const app = await renderDrawer({
      explain: makeExplain({ rules: [{ code: 'boost_feed', ruleId: '55' }] }),
    });

    const notThis = within(app.panel.getByRole('listitem', { name: 'EV battery tech' })).getByRole(
      'button',
      { name: 'Not really about this' },
    );
    expect(notThis).toHaveAccessibleDescription('EV battery tech');
    expect(
      within(app.panel.getByRole('listitem', { name: 'Boosted source' })).getByRole('button', {
        name: 'Undo',
      }),
    ).toHaveAccessibleDescription('Boosted source');
  });
});
