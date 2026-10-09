import type { CreateRuleBody, Me, RuleDto } from '@bantoozi/shared';
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { articleKeys } from '../../src/features/article/query-keys.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';

// Every test boots the whole app; on a busy machine a query can take longer than the default 1 s.
configure({ asyncUtilTimeout: 5_000 });

const { open: boot } = createHarness();

const NOW = '2026-10-08T09:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function rule(over: Partial<RuleDto> = {}): RuleDto {
  return {
    id: '1',
    kind: 'mute_keyword',
    value: 'bitcoin',
    displayValue: 'bitcoin',
    createdAt: '2026-10-01T08:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

const isLive = (item: RuleDto) =>
  item.expiresAt === null || Date.parse(item.expiresAt) > Date.now();

/** A fake rules API that remembers what was created and deleted, like the real one. */
function rulesApi(initial: RuleDto[], over: Record<string, ApiRouteHandler> = {}) {
  const state = { rules: [...initial] };
  const routes: Record<string, ApiRouteHandler> = {
    'GET /rules': () => json(200, state.rules.filter(isLive)),
    'DELETE /rules/:id': (_request, params) => {
      state.rules = state.rules.filter((item) => item.id !== params['id']);
      return noContent();
    },
    'POST /rules': (request) => {
      const body = bodyOf(request) as CreateRuleBody;
      const expiresAt =
        body.expiresInDays === undefined
          ? null
          : new Date(Date.now() + body.expiresInDays * DAY).toISOString();
      const existing = state.rules.find(
        (item) => item.kind === body.kind && item.value === body.value,
      );
      if (existing !== undefined) {
        if (existing.expiresAt !== null) {
          existing.expiresAt =
            expiresAt === null || Date.parse(expiresAt) > Date.parse(existing.expiresAt)
              ? expiresAt
              : existing.expiresAt;
        }
        return json(201, { rule: existing });
      }
      const created = rule({
        id: String(100 + state.rules.length),
        kind: body.kind,
        value: body.value,
        displayValue: body.value,
        createdAt: new Date().toISOString(),
        expiresAt,
      });
      state.rules.push(created);
      return json(201, { rule: created });
    },
    ...over,
  };
  return { state, routes };
}

async function open(
  rules: RuleDto[],
  options: { routes?: Record<string, ApiRouteHandler>; me?: Me } = {},
) {
  const api = rulesApi(rules, options.routes);
  const app = await boot({
    path: '/rules',
    server: { me: options.me ?? makeMe(), routes: api.routes },
  });
  return { ...app, state: api.state };
}

const rowOf = (displayValue: string) => {
  const row = screen.getByText(displayValue).closest('li');
  if (row === null) throw new Error(`no list item holds "${displayValue}"`);
  return within(row);
};
const form = () => within(screen.getByRole('form', { name: 'Add a rule' }));
const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
/** A clock that only the test moves: the date and the interval behind the countdown, nothing else. */
const freezeTime = () =>
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date(NOW) });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const formatted = (iso: string, timeZone = 'Europe/Bratislava', language = 'en') =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(iso),
  );

describe('the rules page (spec 09 §6)', () => {
  describe('the list', () => {
    it('groups the rules by kind under a heading in words, mutes before blocks before boosts', async () => {
      await open([
        rule({
          id: '1',
          kind: 'boost_domain',
          value: 'good.example',
          displayValue: 'good.example',
        }),
        rule({ id: '2', kind: 'block_feed', value: '41', displayValue: 'Example News' }),
        rule({ id: '3', kind: 'mute_keyword', value: 'nft', displayValue: 'nft' }),
        rule({ id: '4', kind: 'mute_story', value: '9', displayValue: 'A story about tariffs' }),
        rule({
          id: '5',
          kind: 'block_domain',
          value: 'spam.example',
          displayValue: 'spam.example',
        }),
        rule({ id: '6', kind: 'block_author', value: 'Jane Doe', displayValue: 'Jane Doe' }),
        rule({ id: '7', kind: 'boost_feed', value: '42', displayValue: 'Daily Blog' }),
        rule({ id: '8', kind: 'mute_keyword', value: 'bitcoin', displayValue: 'bitcoin' }),
      ]);

      expect(await screen.findByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
      await screen.findByRole('region', { name: 'Muted keywords' });
      expect(headings()).toEqual([
        'Muted keywords',
        'Muted stories',
        'Blocked sources',
        'Blocked domains',
        'Blocked authors',
        'Boosted sources',
        'Boosted domains',
        'Add a rule',
      ]);
      const group = (name: string) =>
        within(screen.getByRole('region', { name })).getAllByRole('listitem');
      expect(group('Muted keywords').map((item) => item.textContent)).toEqual([
        expect.stringContaining('nft'),
        expect.stringContaining('bitcoin'),
      ]);
      expect(group('Muted stories')[0]).toHaveTextContent('A story about tariffs');
      expect(group('Blocked sources')[0]).toHaveTextContent('Example News');
      expect(group('Blocked domains')[0]).toHaveTextContent('spam.example');
      expect(group('Blocked authors')[0]).toHaveTextContent('Jane Doe');
      expect(group('Boosted sources')[0]).toHaveTextContent('Daily Blog');
      expect(group('Boosted domains')[0]).toHaveTextContent('good.example');
      expect(screen.queryByText('41')).toBeNull();
    });

    it('leaves out the kinds that have no rule', async () => {
      await open([
        rule({ kind: 'block_domain', value: 'spam.example', displayValue: 'spam.example' }),
      ]);

      await screen.findByText('spam.example');
      expect(headings()).toEqual(['Blocked domains', 'Add a rule']);
    });

    it('names the groups in Slovak', async () => {
      await open(
        [
          rule({ id: '1', kind: 'mute_keyword' }),
          rule({ id: '2', kind: 'mute_story', displayValue: 'Príbeh' }),
          rule({ id: '3', kind: 'block_feed', displayValue: 'Zdroj' }),
          rule({ id: '4', kind: 'block_domain', displayValue: 'spam.example' }),
          rule({ id: '5', kind: 'block_author', displayValue: 'Jana' }),
          rule({ id: '6', kind: 'boost_feed', displayValue: 'Blog' }),
          rule({ id: '7', kind: 'boost_domain', displayValue: 'good.example' }),
        ],
        { me: makeMe({ locale: 'sk' }) },
      );

      expect(await screen.findByRole('heading', { level: 1, name: 'Pravidlá' })).toBeVisible();
      await screen.findByRole('region', { name: 'Stlmené kľúčové slová' });
      expect(headings()).toEqual([
        'Stlmené kľúčové slová',
        'Stlmené príbehy',
        'Blokované zdroje',
        'Blokované domény',
        'Blokovaní autori',
        'Uprednostnené zdroje',
        'Uprednostnené domény',
        'Pridať pravidlo',
      ]);
    });

    it('shows each rule with what it names and when it was added, in the account time zone', async () => {
      await open([rule({ createdAt: '2026-10-01T08:00:00.000Z' })], {
        me: makeMe({ timezone: 'America/New_York' }),
      });

      await screen.findByText('bitcoin');
      const row = rowOf('bitcoin');
      const time = row.getByText(formatted('2026-10-01T08:00:00.000Z', 'America/New_York'));
      expect(time.tagName.toLowerCase()).toBe('time');
      expect(time).toHaveAttribute('datetime', '2026-10-01T08:00:00.000Z');
      expect(row.getByText('Added')).toBeVisible();
    });

    it('says in words how long a rule has left and nothing about a permanent rule', async () => {
      freezeTime();
      await open([
        rule({ id: '1', displayValue: 'three days', expiresAt: at(3 * DAY) }),
        rule({ id: '2', displayValue: 'one day', expiresAt: at(DAY) }),
        rule({ id: '3', displayValue: 'five hours', expiresAt: at(5 * HOUR) }),
        rule({ id: '4', displayValue: 'twenty minutes', expiresAt: at(20 * MINUTE) }),
        rule({ id: '5', displayValue: 'half a minute', expiresAt: at(30_000) }),
        rule({ id: '6', displayValue: 'forever', expiresAt: null }),
      ]);
      await screen.findByText('forever');

      expect(rowOf('three days').getByText('Expires in 3 days')).toBeVisible();
      expect(rowOf('one day').getByText('Expires in 1 day')).toBeVisible();
      expect(rowOf('five hours').getByText('Expires in 5 hours')).toBeVisible();
      expect(rowOf('twenty minutes').getByText('Expires in 20 minutes')).toBeVisible();
      expect(rowOf('half a minute').getByText('Expires in less than a minute')).toBeVisible();
      expect(rowOf('forever').queryByText(/Expires/)).toBeNull();
    });

    it('rounds the time left up, so a new three-day rule never reads two days', async () => {
      freezeTime();
      await open([rule({ displayValue: 'fresh', expiresAt: at(3 * DAY - MINUTE) })]);

      expect(await screen.findByText('Expires in 3 days')).toBeVisible();
    });

    it('refreshes the countdown every minute', async () => {
      freezeTime();
      await open([rule({ displayValue: 'soon gone', expiresAt: at(61 * MINUTE) })]);
      expect(await screen.findByText('Expires in 2 hours')).toBeVisible();

      await wait(MINUTE);

      expect(screen.getByText('Expires in 1 hour')).toBeVisible();
      await wait(MINUTE);
      expect(screen.getByText('Expires in 59 minutes')).toBeVisible();
      await wait(58 * MINUTE);
      expect(screen.getByText('Expires in 1 minute')).toBeVisible();
    });

    it('loads the list again when a rule runs out while the page is open', async () => {
      freezeTime();
      const app = await open([
        rule({ id: '1', displayValue: 'short lived', expiresAt: at(30_000) }),
        rule({ id: '2', displayValue: 'lasting' }),
      ]);
      await screen.findByText('short lived');
      expect(app.calls('GET /rules')).toHaveLength(1);

      await wait(MINUTE);

      await waitFor(() => expect(screen.queryByText('short lived')).toBeNull());
      expect(app.calls('GET /rules')).toHaveLength(2);
      expect(screen.getByText('lasting')).toBeVisible();
    });

    it('counts down in Slovak with the right plural form', async () => {
      freezeTime();
      await open(
        [
          rule({ id: '1', displayValue: 'tri dni', expiresAt: at(3 * DAY) }),
          rule({ id: '2', displayValue: 'päť dní', expiresAt: at(5 * DAY) }),
          rule({ id: '3', displayValue: 'jeden deň', expiresAt: at(DAY) }),
          rule({ id: '4', displayValue: 'dve hodiny', expiresAt: at(61 * MINUTE) }),
          rule({ id: '5', displayValue: 'päť hodín', expiresAt: at(5 * HOUR) }),
          rule({ id: '6', displayValue: 'jedna hodina', expiresAt: at(HOUR) }),
          rule({ id: '7', displayValue: 'štyri minúty', expiresAt: at(4 * MINUTE) }),
          rule({ id: '8', displayValue: 'dvadsať minút', expiresAt: at(20 * MINUTE) }),
          rule({ id: '9', displayValue: 'pol minúty', expiresAt: at(30_000) }),
        ],
        { me: makeMe({ locale: 'sk' }) },
      );
      await screen.findByText('tri dni');

      expect(rowOf('tri dni').getByText('Vyprší za 3 dni')).toBeVisible();
      expect(rowOf('päť dní').getByText('Vyprší za 5 dní')).toBeVisible();
      expect(rowOf('jeden deň').getByText('Vyprší za 1 deň')).toBeVisible();
      expect(rowOf('dve hodiny').getByText('Vyprší za 2 hodiny')).toBeVisible();
      expect(rowOf('päť hodín').getByText('Vyprší za 5 hodín')).toBeVisible();
      expect(rowOf('jedna hodina').getByText('Vyprší za 1 hodinu')).toBeVisible();
      expect(rowOf('štyri minúty').getByText('Vyprší za 4 minúty')).toBeVisible();
      expect(rowOf('dvadsať minút').getByText('Vyprší za 20 minút')).toBeVisible();
      expect(rowOf('pol minúty').getByText('Vyprší za menej ako minútu')).toBeVisible();
    });

    it('explains an empty list and still offers the form', async () => {
      await open([]);

      expect(await screen.findByText('No rules yet')).toBeVisible();
      expect(
        screen.getByText("Mute, block or boost from an article's menu, or add a rule below."),
      ).toBeVisible();
      expect(form().getByRole('button', { name: 'Add rule' })).toBeVisible();
    });

    it('offers a retry when the rules cannot be loaded', async () => {
      let answer: () => Response = () => failure(500, 'INTERNAL');
      const app = await open([rule()], { routes: { 'GET /rules': () => answer() } });

      expect(await screen.findByText('Something went wrong on our side. Try again.')).toBeVisible();
      expect(form().getByRole('button', { name: 'Add rule' })).toBeVisible();
      answer = () => json(200, [rule()]);
      await app.user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('bitcoin')).toBeVisible();
    });
  });

  describe('deleting a rule', () => {
    it('asks first, sends DELETE /rules/:id once confirmed and loads the list again', async () => {
      const app = await open([
        rule({ id: '7', displayValue: 'bitcoin', value: 'bitcoin' }),
        rule({ id: '8', displayValue: 'nft', value: 'nft' }),
      ]);
      await app.user.click(await screen.findByRole('button', { name: 'Delete rule: bitcoin' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete this rule?' });
      expect(dialog).toHaveAccessibleDescription(
        'Muted keywords: bitcoin. Bantoozi will stop applying it and rank your articles again.',
      );
      expect(app.calls('DELETE /rules/:id')).toHaveLength(0);

      await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.calls('DELETE /rules/:id')).toHaveLength(0);
      expect(screen.getByText('bitcoin')).toBeVisible();

      await app.user.click(screen.getByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      await waitFor(() => expect(screen.queryByText('bitcoin')).toBeNull());
      const [request] = app.calls('DELETE /rules/:id');
      expect(app.calls('DELETE /rules/:id')).toHaveLength(1);
      expect(request!.url).toBe('/api/v1/rules/7');
      expect(request!.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(request!.credentials).toBe('same-origin');
      expect(app.calls('GET /rules')).toHaveLength(2);
      expect(screen.getByText('nft')).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps the rule and says why when the delete fails, and deletes on a second try', async () => {
      let answer: () => Response = () => failure(500, 'INTERNAL');
      const app = await open([rule({ id: '7' })], {
        routes: {
          'DELETE /rules/:id': () => answer(),
        },
      });
      await app.user.click(await screen.findByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(screen.getByRole('dialog', { name: 'Delete this rule?' })).toBeVisible();
      expect(screen.getByText('bitcoin')).toBeVisible();
      expect(app.calls('GET /rules')).toHaveLength(1);

      answer = () => noContent();
      await app.user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(app.calls('DELETE /rules/:id')).toHaveLength(2);
    });

    it('treats a rule that is already gone as deleted', async () => {
      const app = await open(
        [rule({ id: '7' }), rule({ id: '8', displayValue: 'nft', value: 'nft' })],
        {
          routes: {
            'DELETE /rules/:id': () => failure(404, 'NOT_FOUND'),
          },
        },
      );
      await app.user.click(await screen.findByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(app.calls('GET /rules')).toHaveLength(2);
    });

    it('moves the focus to the page title, since the button that opened the dialog is gone', async () => {
      const app = await open([
        rule({ id: '7' }),
        rule({ id: '8', displayValue: 'nft', value: 'nft' }),
      ]);
      await app.user.click(await screen.findByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1, name: 'Rules' })).toHaveFocus(),
      );
      expect(screen.getByText('nft')).toBeVisible();
    });

    it('moves the focus to the page title when the last rule is deleted, too', async () => {
      const app = await open([rule({ id: '7' })]);
      await app.user.click(await screen.findByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );

      expect(await screen.findByText('No rules yet')).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1, name: 'Rules' })).toHaveFocus(),
      );
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('the reader after a change', () => {
    it('marks the cached articles stale after a rule is added and after one is deleted', async () => {
      const me = makeMe();
      const app = await open([rule({ id: '7', displayValue: 'bitcoin', value: 'bitcoin' })], {
        me,
      });
      await screen.findByText('bitcoin');
      const probe = [...articleKeys.all(me.id), 'probe'];
      const stale = () => app.queryClient.getQueryState(probe)?.isInvalidated;

      app.queryClient.setQueryData(probe, 1);
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'nft');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      expect(await form().findByText('Rule added.')).toBeVisible();
      await waitFor(() => expect(stale()).toBe(true));

      app.queryClient.setQueryData(probe, 2);
      expect(stale()).toBe(false);
      await app.user.click(screen.getByRole('button', { name: 'Delete rule: bitcoin' }));
      await app.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
      );
      await waitFor(() => expect(screen.queryByText('bitcoin')).toBeNull());
      await waitFor(() => expect(stale()).toBe(true));
    });
  });

  describe('adding a rule', () => {
    it.each([
      [
        'Mute a keyword',
        'Keyword or phrase',
        'bitcoin',
        'Never',
        { kind: 'mute_keyword', value: 'bitcoin' },
      ],
      [
        'Mute a keyword',
        'Keyword or phrase',
        'nft drop',
        'After 1 day',
        { kind: 'mute_keyword', value: 'nft drop', expiresInDays: 1 },
      ],
      [
        'Block a domain',
        'Domain',
        'spam.example',
        'Never',
        { kind: 'block_domain', value: 'spam.example' },
      ],
      [
        'Block a domain',
        'Domain',
        'ads.example',
        'After 3 days',
        { kind: 'block_domain', value: 'ads.example', expiresInDays: 3 },
      ],
      [
        'Boost a domain',
        'Domain',
        'good.example',
        'Never',
        { kind: 'boost_domain', value: 'good.example' },
      ],
      [
        'Boost a domain',
        'Domain',
        'great.example',
        'After 7 days',
        { kind: 'boost_domain', value: 'great.example', expiresInDays: 7 },
      ],
      [
        'Block an author',
        'Author name',
        'Jane Doe',
        'Never',
        { kind: 'block_author', value: 'Jane Doe' },
      ],
      [
        'Block an author',
        'Author name',
        'John Roe',
        'After 30 days',
        { kind: 'block_author', value: 'John Roe', expiresInDays: 30 },
      ],
    ] as const)(
      'sends the %s rule %s=%s with expiry "%s" as %j',
      async (kindName, valueLabel, value, expiry, expected) => {
        const app = await open([]);
        await screen.findByText('No rules yet');

        await app.user.selectOptions(form().getByLabelText('Rule type'), kindName);
        await app.user.type(form().getByLabelText(valueLabel), value);
        await app.user.selectOptions(form().getByLabelText('Expires'), expiry);
        await app.user.click(form().getByRole('button', { name: 'Add rule' }));

        expect(await form().findByText('Rule added.')).toBeVisible();
        const [request] = app.calls('POST /rules');
        expect(app.calls('POST /rules')).toHaveLength(1);
        expect(bodyOf(request!)).toEqual(expected);
        expect(request!.headers.get('X-Bantoozi-Client')).toBe('web');
        expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
        expect(await screen.findByText(value)).toBeVisible();
        expect(form().getByLabelText(valueLabel)).toHaveValue('');
        expect(app.calls('GET /rules')).toHaveLength(2);
      },
    );

    it('puts the new rule under its kind and offers to add another', async () => {
      const app = await open([rule()]);
      await screen.findByText('bitcoin');

      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain');
      await app.user.type(form().getByLabelText('Domain'), 'spam.example');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      await screen.findByText('spam.example');
      expect(headings()).toEqual(['Muted keywords', 'Blocked domains', 'Add a rule']);
      expect(form().getByLabelText('Rule type')).toHaveValue('block_domain');
      expect(form().getByLabelText('Domain')).toHaveValue('');
    });

    it('explains what each kind does and what to type', async () => {
      const app = await open([]);
      await screen.findByText('No rules yet');

      expect(form().getByLabelText('Keyword or phrase')).toHaveAccessibleDescription(
        'Hides articles whose title or summary contains it. Use 2 to 100 characters.',
      );
      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain');
      expect(form().getByLabelText('Domain')).toHaveAccessibleDescription(
        'Hides every article from this website, for example example.com.',
      );
      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Boost a domain');
      expect(form().getByLabelText('Domain')).toHaveAccessibleDescription(
        'Always shows articles from this website in For you, for example example.com.',
      );
      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block an author');
      expect(form().getByLabelText('Author name')).toHaveAccessibleDescription(
        'Hides articles written by this author.',
      );
    });

    it('offers only the kinds that no other screen creates, and the four expiries', async () => {
      await open([]);
      await screen.findByText('No rules yet');

      expect(
        within(form().getByLabelText('Rule type'))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Mute a keyword', 'Block a domain', 'Boost a domain', 'Block an author']);
      expect(
        within(form().getByLabelText('Expires'))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Never', 'After 1 day', 'After 3 days', 'After 7 days', 'After 30 days']);
      expect(form().getByLabelText('Expires')).toHaveValue('never');
    });

    it('trims the value before sending it', async () => {
      const app = await open([]);
      await screen.findByText('No rules yet');

      await app.user.type(form().getByLabelText('Keyword or phrase'), '  spam  ');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      await form().findByText('Rule added.');
      expect(bodyOf(app.calls('POST /rules')[0]!)).toEqual({ kind: 'mute_keyword', value: 'spam' });
    });

    it('asks for a value instead of sending an empty one', async () => {
      const app = await open([]);
      await screen.findByText('No rules yet');

      await app.user.type(form().getByLabelText('Keyword or phrase'), '   ');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      const input = form().getByLabelText('Keyword or phrase');
      expect(input).toBeInvalid();
      expect(input).toHaveAccessibleDescription(expect.stringContaining('Enter a value.'));
      expect(app.calls('POST /rules')).toHaveLength(0);
    });

    it('shows the 400 on the field it names and keeps what was typed', async () => {
      const app = await open([], {
        routes: {
          'POST /rules': () =>
            failure(400, 'VALIDATION_FAILED', { field: 'value', reason: 'domain' }),
        },
      });
      await screen.findByText('No rules yet');
      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain');
      await app.user.type(form().getByLabelText('Domain'), 'https://spam.example/x');

      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      const input = await waitFor(() => {
        const field = form().getByLabelText('Domain');
        expect(field).toBeInvalid();
        return field;
      });
      expect(input).toHaveAccessibleDescription(
        expect.stringContaining(
          'Enter a website name such as example.com, without http:// or a path.',
        ),
      );
      expect(input).toHaveValue('https://spam.example/x');
      expect(form().queryByText('Rule added.')).toBeNull();
    });

    it.each([
      ['keyword', 'Keyword or phrase', 'Use 2 to 100 characters.'],
      ['id', 'Keyword or phrase', "That value isn't valid."],
    ] as const)('words the reason "%s" of a rejected value', async (reason, label, message) => {
      const app = await open([], {
        routes: {
          'POST /rules': () => failure(400, 'VALIDATION_FAILED', { field: 'value', reason }),
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText(label), 'x');

      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      await waitFor(() =>
        expect(form().getByLabelText(label)).toHaveAccessibleDescription(
          expect.stringContaining(message),
        ),
      );
    });

    it('clears a field error once the value changes and the rule goes through', async () => {
      let accept = false;
      const app = await open([], {
        routes: {
          'POST /rules': () =>
            accept
              ? json(201, { rule: rule({ id: '9', value: 'x1', displayValue: 'x1' }) })
              : failure(400, 'VALIDATION_FAILED', { field: 'value', reason: 'keyword' }),
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'x');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(form().getByLabelText('Keyword or phrase')).toBeInvalid());

      accept = true;
      await app.user.type(form().getByLabelText('Keyword or phrase'), '1');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      expect(await form().findByText('Rule added.')).toBeVisible();
      expect(form().getByLabelText('Keyword or phrase')).toBeValid();
    });

    it('shows the plan limit with how much of it is used', async () => {
      const app = await open([], {
        routes: {
          'POST /rules': () =>
            failure(409, 'QUOTA_EXCEEDED', { limit: 'maxRules', used: 200, max: 200 }),
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'bitcoin');

      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      expect(await form().findByRole('alert')).toHaveTextContent(
        "You've reached your plan's limit for rules: 200 of 200.",
      );
      expect(form().getByLabelText('Keyword or phrase')).toHaveValue('bitcoin');
      expect(form().queryByText('Rule added.')).toBeNull();
    });

    it('shows any other failure as an alert and lets the user send again', async () => {
      let answer: () => Response = () => failure(500, 'INTERNAL');
      const app = await open([], {
        routes: { 'POST /rules': () => answer() },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'bitcoin');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      expect(await form().findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );

      answer = () => json(201, { rule: rule({ id: '9' }) });
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      expect(await form().findByText('Rule added.')).toBeVisible();
      expect(form().queryByRole('alert')).toBeNull();
      expect(app.calls('POST /rules')).toHaveLength(2);
    });

    it('accepts a 201 that returns the rule it already had, now with the later expiry', async () => {
      freezeTime();
      const app = await open([rule({ id: '4', expiresAt: at(DAY) })]);
      expect(await screen.findByText('Expires in 1 day')).toBeVisible();

      await app.user.type(form().getByLabelText('Keyword or phrase'), 'bitcoin');
      await app.user.selectOptions(form().getByLabelText('Expires'), 'After 7 days');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));

      expect(await form().findByText('Rule added.')).toBeVisible();
      expect(await screen.findByText('Expires in 7 days')).toBeVisible();
      expect(screen.getAllByText('bitcoin')).toHaveLength(1);
      expect(screen.queryByText('Expires in 1 day')).toBeNull();
    });

    it('keeps a value typed while the rule was on its way, still to be added', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await open([], {
        routes: {
          'POST /rules': async () => {
            await held;
            return json(201, { rule: rule({ id: '9' }) });
          },
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'bitcoin');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(app.calls('POST /rules')).toHaveLength(1));

      await app.user.type(form().getByLabelText('Keyword or phrase'), ' cash');
      release();

      expect(await form().findByText('Rule added.')).toBeVisible();
      expect(form().getByLabelText('Keyword or phrase')).toHaveValue('bitcoin cash');
      expect(bodyOf(app.calls('POST /rules')[0]!)).toEqual({
        kind: 'mute_keyword',
        value: 'bitcoin',
      });
    });

    it.each([
      [
        'its type',
        async (app: Awaited<ReturnType<typeof open>>) =>
          app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain'),
        'Domain',
      ],
      [
        'its expiry',
        async (app: Awaited<ReturnType<typeof open>>) =>
          app.user.selectOptions(form().getByLabelText('Expires'), 'After 7 days'),
        'Keyword or phrase',
      ],
    ])(
      'keeps the text for the next rule when %s was changed while the rule was on its way',
      async (_name, change, field) => {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const app = await open([], {
          routes: {
            'POST /rules': async () => {
              await held;
              return json(201, { rule: rule({ id: '9' }) });
            },
          },
        });
        await screen.findByText('No rules yet');
        await app.user.type(form().getByLabelText('Keyword or phrase'), 'example.com');
        await app.user.click(form().getByRole('button', { name: 'Add rule' }));
        await waitFor(() => expect(app.calls('POST /rules')).toHaveLength(1));

        await change(app);
        release();

        expect(await form().findByText('Rule added.')).toBeVisible();
        expect(form().getByLabelText(field)).toHaveValue('example.com');
      },
    );

    it('shows a rejected value as a general failure when it was edited while the rule was on its way', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await open([], {
        routes: {
          'POST /rules': async () => {
            await held;
            return failure(400, 'VALIDATION_FAILED', { field: 'value', reason: 'domain' });
          },
        },
      });
      await screen.findByText('No rules yet');
      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain');
      await app.user.type(form().getByLabelText('Domain'), 'https://spam.example/x');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(app.calls('POST /rules')).toHaveLength(1));

      await app.user.clear(form().getByLabelText('Domain'));
      await app.user.type(form().getByLabelText('Domain'), 'spam.example');
      release();

      await waitFor(() => {
        expect(form().getByLabelText('Domain')).toBeValid();
        expect(form().getByRole('alert')).toHaveTextContent(
          "Some of the information isn't valid. Check it and try again.",
        );
      });
      expect(form().getByLabelText('Domain')).toHaveValue('spam.example');
    });

    it('shows a rejected expiry as a general failure when it was changed while the rule was on its way', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await open([], {
        routes: {
          'POST /rules': async () => {
            await held;
            return failure(400, 'VALIDATION_FAILED', { field: 'expiresInDays' });
          },
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'bitcoin');
      await app.user.selectOptions(form().getByLabelText('Expires'), 'After 3 days');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(app.calls('POST /rules')).toHaveLength(1));

      await app.user.selectOptions(form().getByLabelText('Expires'), 'After 7 days');
      release();

      await waitFor(() => {
        expect(form().getByLabelText('Expires')).toBeValid();
        expect(form().getByRole('alert')).toHaveTextContent(
          "Some of the information isn't valid. Check it and try again.",
        );
      });
      expect(form().getByLabelText('Expires')).toHaveValue('7');
    });

    it('shows a rejected value as a general failure when the rule type was changed while the rule was on its way', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await open([], {
        routes: {
          'POST /rules': async () => {
            await held;
            return failure(400, 'VALIDATION_FAILED', { field: 'value', reason: 'keyword' });
          },
        },
      });
      await screen.findByText('No rules yet');
      await app.user.type(form().getByLabelText('Keyword or phrase'), 'x');
      await app.user.click(form().getByRole('button', { name: 'Add rule' }));
      await waitFor(() => expect(app.calls('POST /rules')).toHaveLength(1));

      await app.user.selectOptions(form().getByLabelText('Rule type'), 'Block a domain');
      release();

      await waitFor(() => {
        expect(form().getByLabelText('Domain')).toBeValid();
        expect(form().getByRole('alert')).toHaveTextContent(
          "Some of the information isn't valid. Check it and try again.",
        );
      });
      expect(form().getByLabelText('Domain')).toHaveValue('x');
    });
  });
});
