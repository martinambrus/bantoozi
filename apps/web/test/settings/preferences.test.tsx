import {
  DEFAULT_USER_PREFERENCES,
  type Me,
  type MePatch,
  type UserPreferences,
} from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import {
  EMAIL,
  bodiesOf,
  deferred,
  makeSubscription,
  openSettings,
  patchMe,
  section,
} from './support.js';

const prefs = () => within(section('Reading preferences'));
const toggle = (name: string) => prefs().getByRole('switch', { name });
const choice = (name: string) => prefs().getByRole('radiogroup', { name });
const option = (group: string, name: string) => within(choice(group)).getByRole('radio', { name });

const leaves = (value: object, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]: [string, unknown]) =>
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? leaves(child, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );

interface Case {
  /** The control's accessible name. */
  label: string;
  kind: 'switch' | 'choice';
  /** The option to click, for a choice. */
  pick?: string;
  /** What `preferences` must hold in the one PATCH the change sends. */
  patch: NonNullable<MePatch['preferences']>;
  /** Words from the explanation next to the control. */
  explains: string;
}

const CASES: Case[] = [
  {
    label: 'Minimum tier',
    kind: 'choice',
    pick: '4',
    patch: { defaultTier: 4 },
    explains: 'tier 5 only the strongest matches',
  },
  {
    label: 'Order of For you',
    kind: 'choice',
    pick: 'Newest first',
    patch: { sort: 'date' },
    explains: 'Best match lists the articles most likely to interest you first',
  },
  {
    label: 'Hide the Everything else lane',
    kind: 'switch',
    patch: { hideEverything: true },
    explains: 'Removes the lane of articles that match none of your interests from the sidebar',
  },
  {
    label: 'Simple mode',
    kind: 'switch',
    patch: { simpleMode: true },
    explains: 'no excerpts and no thumbnails',
  },
  {
    label: 'Mark as read when I open an article',
    kind: 'switch',
    patch: { markReadOnExpand: false },
    explains: 'An article you expand in a list counts as read',
  },
  {
    label: 'Mark as read when I rate an article',
    kind: 'switch',
    patch: { markReadOnRate: false },
    explains: 'a thumbs up or down also marks it as read',
  },
  {
    label: 'Feedback prompts',
    kind: 'choice',
    pick: 'Never',
    patch: { feedbackPrompt: 'never' },
    explains: 'Did you like it?',
  },
  {
    label: 'Suggest teaching an interest after a rating',
    kind: 'switch',
    patch: { exampleSuggestions: false },
    explains: 'Nothing changes unless you accept',
  },
  {
    label: 'Learn from how I read',
    kind: 'switch',
    patch: { implicitFeedback: true },
    explains: 'Thumbs up, thumbs down and bookmarks teach Bantoozi without it',
  },
  {
    label: 'Count marking as read without opening as not interested',
    kind: 'switch',
    patch: { implicitNegative: true },
    explains: 'only while Learn from how I read is on',
  },
  {
    label: 'Clickbait',
    kind: 'choice',
    pick: 'On',
    patch: { demote: { clickbait: 'on' } },
    explains: 'headlines that promise more than the article delivers',
  },
  {
    label: 'Promotional articles',
    kind: 'choice',
    pick: 'Off',
    patch: { demote: { promotional: 'off' } },
    explains: 'adverts and sales pitches',
  },
  {
    label: 'Shallow articles',
    kind: 'choice',
    pick: 'On',
    patch: { demote: { shallow: 'on' } },
    explains: 'thin articles with little depth',
  },
  {
    label: 'Stale news',
    kind: 'choice',
    pick: 'Off',
    patch: { demote: { stale: 'off' } },
    explains: 'older than three days',
  },
  {
    label: 'Swipe left',
    kind: 'choice',
    pick: 'Mark as read',
    patch: { swipe: { left: 'read' } },
    explains: 'swipe an article to the left',
  },
  {
    label: 'Swipe right',
    kind: 'choice',
    pick: 'Bookmark',
    patch: { swipe: { right: 'bookmark' } },
    explains: 'swipe an article to the right',
  },
  {
    label: "Load images from publishers' websites",
    kind: 'switch',
    patch: { loadRemoteImages: true },
    explains: 'tells that website you are reading its article',
  },
];

const control = ({ label, kind }: Case) => (kind === 'switch' ? toggle(label) : choice(label));
const saved = /Saved/;

describe('reading preferences (spec 09 §7, spec 08 §3.1)', () => {
  describe('the controls', () => {
    it('has one control for each preference that is not the theme, the folder order or onboarding', async () => {
      await openSettings();

      const wanted = leaves(DEFAULT_USER_PREFERENCES).filter(
        (path) => !['theme', 'folderOrder', 'onboardingCompletedAt'].includes(path),
      );
      expect(CASES.flatMap((item) => leaves(item.patch)).sort()).toEqual(wanted.sort());
      expect(prefs().getAllByRole('switch')).toHaveLength(8);
      expect(prefs().getAllByRole('radiogroup')).toHaveLength(9);
      for (const item of CASES) expect(control(item)).toBeVisible();
    });

    it('groups them under headings', async () => {
      await openSettings();

      const names = ['Lists', 'Marking as read', 'Feedback and learning', 'Quality filters'];
      for (const name of [...names, 'Swipe gestures', 'Images']) {
        expect(prefs().getByRole('group', { name })).toBeVisible();
      }
      expect(
        within(prefs().getByRole('group', { name: 'Quality filters' })).getAllByRole('radiogroup'),
      ).toHaveLength(4);
    });

    it('shows the defaults of an account that never changed a preference', async () => {
      await openSettings();

      for (const name of [
        'Mark as read when I open an article',
        'Mark as read when I rate an article',
        'Suggest teaching an interest after a rating',
      ]) {
        expect(toggle(name)).toHaveAttribute('aria-checked', 'true');
      }
      for (const name of [
        'Hide the Everything else lane',
        'Simple mode',
        'Learn from how I read',
        'Count marking as read without opening as not interested',
        "Load images from publishers' websites",
      ]) {
        expect(toggle(name)).toHaveAttribute('aria-checked', 'false');
      }
      expect(option('Minimum tier', '1')).toHaveAttribute('aria-checked', 'true');
      expect(option('Order of For you', 'Best match')).toHaveAttribute('aria-checked', 'true');
      expect(option('Feedback prompts', 'Occasionally')).toHaveAttribute('aria-checked', 'true');
      for (const name of ['Clickbait', 'Promotional articles', 'Shallow articles', 'Stale news']) {
        expect(option(name, 'Auto')).toHaveAttribute('aria-checked', 'true');
      }
      expect(option('Swipe left', 'Dislike')).toHaveAttribute('aria-checked', 'true');
      expect(option('Swipe right', 'Like')).toHaveAttribute('aria-checked', 'true');
    });

    it('shows the values the account has saved', async () => {
      const changed: Partial<UserPreferences> = {
        defaultTier: 5,
        hideEverything: true,
        simpleMode: true,
        sort: 'date',
        markReadOnExpand: false,
        markReadOnRate: false,
        feedbackPrompt: 'never',
        exampleSuggestions: false,
        demote: { clickbait: 'on', promotional: 'off', shallow: 'on', stale: 'off' },
        implicitNegative: true,
        swipe: { left: 'none', right: 'bookmark' },
        loadRemoteImages: true,
        implicitFeedback: true,
      };
      await openSettings({ me: makeMe({ email: EMAIL, preferences: changed }) });

      expect(toggle('Hide the Everything else lane')).toHaveAttribute('aria-checked', 'true');
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'true');
      expect(toggle('Mark as read when I open an article')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(toggle('Mark as read when I rate an article')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(toggle('Suggest teaching an interest after a rating')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(toggle('Learn from how I read')).toHaveAttribute('aria-checked', 'true');
      expect(toggle('Count marking as read without opening as not interested')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(toggle("Load images from publishers' websites")).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(option('Minimum tier', '5')).toHaveAttribute('aria-checked', 'true');
      expect(option('Order of For you', 'Newest first')).toHaveAttribute('aria-checked', 'true');
      expect(option('Feedback prompts', 'Never')).toHaveAttribute('aria-checked', 'true');
      expect(option('Clickbait', 'On')).toHaveAttribute('aria-checked', 'true');
      expect(option('Promotional articles', 'Off')).toHaveAttribute('aria-checked', 'true');
      expect(option('Shallow articles', 'On')).toHaveAttribute('aria-checked', 'true');
      expect(option('Stale news', 'Off')).toHaveAttribute('aria-checked', 'true');
      expect(option('Swipe left', 'Nothing')).toHaveAttribute('aria-checked', 'true');
      expect(option('Swipe right', 'Bookmark')).toHaveAttribute('aria-checked', 'true');
    });

    it('offers every option of every choice', async () => {
      await openSettings();

      const optionsOf = (group: string) =>
        within(choice(group))
          .getAllByRole('radio')
          .map((radio) => radio.textContent);
      expect(optionsOf('Minimum tier')).toEqual(['1', '2', '3', '4', '5']);
      expect(optionsOf('Order of For you')).toEqual(['Best match', 'Newest first']);
      expect(optionsOf('Feedback prompts')).toEqual(['Often', 'Occasionally', 'Never']);
      for (const name of ['Clickbait', 'Promotional articles', 'Shallow articles', 'Stale news']) {
        expect(optionsOf(name)).toEqual(['Auto', 'On', 'Off']);
      }
      expect(optionsOf('Swipe left')).toEqual(['Dislike', 'Mark as read', 'Nothing']);
      expect(optionsOf('Swipe right')).toEqual(['Like', 'Bookmark', 'Nothing']);
    });
  });

  describe('explanations', () => {
    it.each(CASES)('explains "$label"', async (item) => {
      await openSettings();

      expect(control(item)).toHaveAccessibleDescription(expect.stringContaining(item.explains));
    });

    it('says what Auto, On and Off mean for the quality filters', async () => {
      await openSettings();

      expect(prefs().getByRole('group', { name: 'Quality filters' })).toHaveAccessibleDescription(
        'Auto turns a filter on after you dislike three articles for that reason within 90 days. On always applies it. Off never does.',
      );
    });

    it('says that rating works without learning from reading', async () => {
      await openSettings();

      expect(toggle('Learn from how I read')).toHaveAccessibleDescription(
        expect.stringMatching(/Off by default.*Thumbs up, thumbs down and bookmarks/),
      );
    });
  });

  describe('saving', () => {
    it.each(CASES)('changing "$label" sends only $patch', async (item) => {
      const { user, calls } = await openSettings();

      if (item.kind === 'switch') await user.click(toggle(item.label));
      else await user.click(option(item.label, item.pick as string));

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: item.patch }]);
      if (item.kind === 'switch') {
        await waitFor(() =>
          expect(toggle(item.label)).toHaveAttribute(
            'aria-checked',
            String(Object.values(item.patch)[0]),
          ),
        );
      } else {
        await waitFor(() =>
          expect(option(item.label, item.pick as string)).toHaveAttribute('aria-checked', 'true'),
        );
      }
      await waitFor(() => expect(control(item)).toHaveAccessibleDescription(saved));
    });

    it('sends the request the way every mutation of the app is sent', async () => {
      const { user, calls } = await openSettings();

      await user.click(toggle('Simple mode'));

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      const request = calls('PATCH /me')[0];
      expect(request?.headers.get('X-Bantoozi-Client')).toBe('web');
      expect(request?.headers.get('Content-Type')).toBe('application/json');
      expect(request?.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(request?.credentials).toBe('same-origin');
    });

    it('sends one setting per request, and never the theme, the folder order or onboarding', async () => {
      const { user, calls } = await openSettings();

      for (const item of CASES) {
        if (item.kind === 'switch') await user.click(toggle(item.label));
        else await user.click(option(item.label, item.pick as string));
      }

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(CASES.length));
      const paths = bodiesOf(calls('PATCH /me')).map((body) => {
        expect(Object.keys(body as object)).toEqual(['preferences']);
        return leaves((body as { preferences: object }).preferences);
      });
      expect(paths.every((path) => path.length === 1)).toBe(true);
      expect(paths.flat().sort()).toEqual(CASES.flatMap((item) => leaves(item.patch)).sort());
    });

    it('sends nothing when the option that is already selected is chosen again', async () => {
      const { user, calls } = await openSettings();

      await user.click(option('Order of For you', 'Best match'));
      await user.click(option('Clickbait', 'Auto'));

      expect(calls('PATCH /me')).toHaveLength(0);
      expect(option('Order of For you', 'Best match')).toHaveAttribute('aria-checked', 'true');
    });

    it('keeps the account in step with what the server saved', async () => {
      const { user, queryClient, calls } = await openSettings();

      await user.click(option('Order of For you', 'Newest first'));
      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));

      await waitFor(() =>
        expect(queryClient.getQueryData<Me>(meKey())?.preferences.sort).toBe('date'),
      );
      expect(queryClient.getQueryData<Me>(meKey())?.preferences.defaultTier).toBe(1);
    });

    it('shows the new value at once, before the server has answered', async () => {
      const gate = deferred();
      const { user } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });

      await user.click(option('Order of For you', 'Newest first'));

      expect(option('Order of For you', 'Newest first')).toHaveAttribute('aria-checked', 'true');
      expect(option('Order of For you', 'Best match')).toHaveAttribute('aria-checked', 'false');
      expect(choice('Order of For you')).not.toHaveAccessibleDescription(saved);
      gate.release();
      await waitFor(() => expect(choice('Order of For you')).toHaveAccessibleDescription(saved));
      expect(option('Order of For you', 'Newest first')).toHaveAttribute('aria-checked', 'true');
    });

    it('marks the setting it saved, and only that one', async () => {
      const { user } = await openSettings();
      const regions = prefs().getAllByRole('status');

      await user.click(toggle('Simple mode'));
      await waitFor(() => expect(toggle('Simple mode')).toHaveAccessibleDescription(saved));

      expect(toggle('Hide the Everything else lane')).not.toHaveAccessibleDescription(saved);
      expect(regions.filter((region) => region.textContent?.includes('Saved'))).toHaveLength(1);

      await user.click(toggle('Hide the Everything else lane'));
      await waitFor(() =>
        expect(toggle('Hide the Everything else lane')).toHaveAccessibleDescription(saved),
      );
      expect(toggle('Simple mode')).not.toHaveAccessibleDescription(saved);
    });

    it('takes the saved mark away while the next change is on its way', async () => {
      const gate = deferred();
      let sent = 0;
      const { user } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            sent += 1;
            if (sent === 2) await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });
      await user.click(toggle('Simple mode'));
      await waitFor(() => expect(toggle('Simple mode')).toHaveAccessibleDescription(saved));

      await user.click(toggle('Hide the Everything else lane'));

      expect(toggle('Simple mode')).not.toHaveAccessibleDescription(saved);
      expect(toggle('Hide the Everything else lane')).not.toHaveAccessibleDescription(saved);
      gate.release();
      await waitFor(() =>
        expect(toggle('Hide the Everything else lane')).toHaveAccessibleDescription(saved),
      );
    });
  });

  describe('when saving fails', () => {
    it('puts the old value back and says why the setting was not saved', async () => {
      const { user, calls } = await openSettings({
        routes: { 'PATCH /me': () => failure(500, 'INTERNAL') },
      });

      await user.click(option('Order of For you', 'Newest first'));

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      await waitFor(() => expect(choice('Order of For you')).toBeInvalid());
      expect(choice('Order of For you')).toHaveAccessibleDescription(
        expect.stringContaining(
          "Couldn't save this setting. Something went wrong on our side. Try again.",
        ),
      );
      expect(choice('Order of For you')).not.toHaveAccessibleDescription(saved);
      expect(option('Order of For you', 'Best match')).toHaveAttribute('aria-checked', 'true');
      expect(option('Order of For you', 'Newest first')).toHaveAttribute('aria-checked', 'false');
    });

    it('says when the server could not be reached', async () => {
      const { user } = await openSettings({
        routes: {
          'PATCH /me': () => {
            throw new TypeError('Failed to fetch');
          },
        },
      });

      await user.click(toggle('Simple mode'));

      await waitFor(() => expect(toggle('Simple mode')).toBeInvalid());
      expect(toggle('Simple mode')).toHaveAccessibleDescription(
        expect.stringContaining("You seem to be offline, or the server can't be reached."),
      );
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'false');
    });

    it('lets the person try again, and clears the message once it works', async () => {
      let failing = true;
      const { user, calls } = await openSettings({
        routes: (server) => ({
          'PATCH /me': (request, params) =>
            failing ? failure(500, 'INTERNAL') : patchMe(server)(request, params),
        }),
      });
      await user.click(toggle('Simple mode'));
      await waitFor(() => expect(toggle('Simple mode')).toBeInvalid());

      failing = false;
      await user.click(toggle('Simple mode'));

      await waitFor(() => expect(toggle('Simple mode')).toHaveAccessibleDescription(saved));
      expect(toggle('Simple mode')).not.toBeInvalid();
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'true');
      expect(calls('PATCH /me')).toHaveLength(2);
      expect(bodiesOf(calls('PATCH /me'))[1]).toEqual({ preferences: { simpleMode: true } });
    });

    it('leaves the other settings as they are', async () => {
      const { user } = await openSettings({
        routes: (server) => ({
          'PATCH /me': (request, params) => {
            const body = bodyOf(request) as { preferences: Record<string, unknown> };
            return 'simpleMode' in body.preferences
              ? failure(500, 'INTERNAL')
              : patchMe(server)(request, params);
          },
        }),
      });
      await user.click(toggle('Hide the Everything else lane'));
      await waitFor(() =>
        expect(toggle('Hide the Everything else lane')).toHaveAccessibleDescription(saved),
      );

      await user.click(toggle('Simple mode'));
      await waitFor(() => expect(toggle('Simple mode')).toBeInvalid());

      expect(toggle('Hide the Everything else lane')).toHaveAttribute('aria-checked', 'true');
      expect(toggle('Hide the Everything else lane')).not.toBeInvalid();
    });
  });

  describe('overlapping saves', () => {
    it('does not let the answer to one setting undo another, whatever order they come in', async () => {
      const gates = [deferred(), deferred()];
      let sent = 0;
      const { user, queryClient, calls } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            // The server applies the changes in the order they arrive, and answers with the account.
            const answer = patchMe(server)(request, params);
            await gates[sent++]?.promise;
            return answer;
          },
        }),
      });

      await user.click(toggle('Simple mode'));
      await user.click(toggle('Hide the Everything else lane'));
      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(2));

      gates[1]?.release();
      await waitFor(() =>
        expect(toggle('Hide the Everything else lane')).toHaveAccessibleDescription(saved),
      );
      gates[0]?.release();
      await waitFor(() => expect(toggle('Simple mode')).toHaveAccessibleDescription(saved));

      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'true');
      expect(toggle('Hide the Everything else lane')).toHaveAttribute('aria-checked', 'true');
      expect(queryClient.getQueryData<Me>(meKey())?.preferences).toMatchObject({
        simpleMode: true,
        hideEverything: true,
      });
    });

    it('sends a setting changed again only once the server has answered the change before, so the server keeps what the control shows', async () => {
      const gates = [deferred(), deferred()];
      let sent = 0;
      const { user, queryClient, calls, server } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            // The server applies a change when it answers: a request that waits applies last.
            await gates[sent++]?.promise;
            return patchMe(server)(request, params);
          },
        }),
      });

      await user.click(toggle('Simple mode'));
      await user.click(toggle('Simple mode'));
      await waitFor(() => expect(calls('PATCH /me')).not.toHaveLength(0));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { simpleMode: true } }]);
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'false');

      gates[0]?.release();
      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(2));
      expect(bodiesOf(calls('PATCH /me'))[1]).toEqual({ preferences: { simpleMode: false } });
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'false');
      gates[1]?.release();

      await waitFor(() => expect(toggle('Simple mode')).toHaveAccessibleDescription(saved));
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'false');
      expect(server.me?.preferences.simpleMode).toBe(false);
      expect(queryClient.getQueryData<Me>(meKey())?.preferences.simpleMode).toBe(false);
    });

    it('sends only the newest of the changes made while one was on its way', async () => {
      const gate = deferred();
      let sent = 0;
      const { user, calls, server } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            if (sent++ === 0) await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });

      await user.click(option('Minimum tier', '4'));
      await user.click(option('Minimum tier', '2'));
      await user.click(option('Minimum tier', '3'));
      gate.release();

      await waitFor(() => expect(choice('Minimum tier')).toHaveAccessibleDescription(saved));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([
        { preferences: { defaultTier: 4 } },
        { preferences: { defaultTier: 3 } },
      ]);
      expect(option('Minimum tier', '3')).toHaveAttribute('aria-checked', 'true');
      expect(server.me?.preferences.defaultTier).toBe(3);
    });

    it('drops a change that waits when the account signs out before it can go', async () => {
      const gate = deferred();
      let sent = 0;
      const { user, calls, session } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            if (sent++ === 0) await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });
      await user.click(option('Minimum tier', '4'));
      await user.click(option('Minimum tier', '2'));

      await act(() => session.resetAccountState());
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { defaultTier: 4 } }]);
    });

    it('keeps an earlier change that was saved when the next change of the setting fails', async () => {
      const gate = deferred();
      let sent = 0;
      const { user, queryClient, calls } = await openSettings({
        routes: (server) => ({
          'PATCH /me': async (request, params) => {
            if (sent++ > 0) return failure(500, 'INTERNAL');
            await gate.promise;
            return patchMe(server)(request, params);
          },
        }),
      });

      await user.click(toggle('Simple mode'));
      await user.click(toggle('Simple mode'));
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'false');
      gate.release();

      await waitFor(() => expect(toggle('Simple mode')).toBeInvalid());
      expect(calls('PATCH /me')).toHaveLength(2);
      expect(toggle('Simple mode')).toHaveAttribute('aria-checked', 'true');
      expect(queryClient.getQueryData<Me>(meKey())?.preferences.simpleMode).toBe(true);
    });
  });

  describe('images', () => {
    const exceptions = () =>
      prefs().findByRole('list', { name: 'Feeds with their own image setting' });
    const feedPreferences = (...items: [string, 'inherit' | 'allow' | 'block'][]) =>
      items.map(([feedId, imagePolicy]) => ({
        feedId,
        imagePolicy,
        effectiveImagesAllowed: imagePolicy === 'allow',
      }));

    it('lists the feeds that decide for themselves whether to load images, each linking to the feeds page', async () => {
      const { user, router } = await openSettings({
        routes: {
          'GET /feed-preferences': () =>
            json(
              200,
              feedPreferences(['11', 'allow'], ['12', 'block'], ['13', 'inherit'], ['14', 'allow']),
            ),
          'GET /subscriptions': () =>
            json(200, [
              makeSubscription('11', 'Daily Blog'),
              makeSubscription('12', 'Tech', { titleOverride: 'My tech news' }),
              makeSubscription('13', 'Quiet Feed'),
              makeSubscription('14', null),
            ]),
        },
      });

      const list = await exceptions();
      const items = within(list).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('Daily Blog'),
        expect.stringContaining('https://feed14.example/rss'),
        expect.stringContaining('My tech news'),
      ]);
      expect(within(items[0] as HTMLElement).getByText('Always show images')).toBeVisible();
      expect(within(items[1] as HTMLElement).getByText('Always show images')).toBeVisible();
      expect(within(items[2] as HTMLElement).getByText('Always block images')).toBeVisible();
      expect(within(list).queryByText('Quiet Feed')).toBeNull();
      for (const item of items) {
        expect(within(item).getByRole('link')).toHaveAttribute('href', '/feeds');
      }

      await user.click(within(items[2] as HTMLElement).getByRole('link', { name: 'My tech news' }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/feeds'));
    });

    it('names a source the person no longer follows', async () => {
      await openSettings({
        routes: {
          'GET /feed-preferences': () => json(200, feedPreferences(['99', 'block'])),
          'GET /subscriptions': () => json(200, [makeSubscription('11', 'Daily Blog')]),
        },
      });

      const list = await exceptions();

      expect(within(list).getByText('A feed you no longer follow')).toBeVisible();
      expect(within(list).getByText('Always block images')).toBeVisible();
    });

    it('says when no feed has a setting of its own', async () => {
      await openSettings({
        routes: {
          'GET /feed-preferences': () => json(200, feedPreferences(['13', 'inherit'])),
          'GET /subscriptions': () => json(200, [makeSubscription('13', 'Quiet Feed')]),
        },
      });

      expect(await prefs().findByText('No feed has its own image setting.')).toBeVisible();
      expect(
        prefs().queryByRole('list', { name: 'Feeds with their own image setting' }),
      ).toBeNull();
    });

    it('says what went wrong and tries again on request', async () => {
      let failing = true;
      const { user, calls } = await openSettings({
        routes: {
          'GET /feed-preferences': () =>
            failing ? failure(500, 'INTERNAL') : json(200, feedPreferences(['11', 'allow'])),
          'GET /subscriptions': () => json(200, [makeSubscription('11', 'Daily Blog')]),
        },
      });
      const group = within(prefs().getByRole('group', { name: 'Images' }));

      await group.findByRole('button', { name: 'Retry' });
      expect(group.getByRole('alert')).toHaveTextContent('Something went wrong on our side');
      failing = false;
      await user.click(group.getByRole('button', { name: 'Retry' }));

      expect(await group.findByText('Daily Blog')).toBeVisible();
      expect(calls('GET /feed-preferences')).toHaveLength(2);
    });

    it('still lets the person change the global setting while the list is unavailable', async () => {
      const { user, calls } = await openSettings({
        routes: { 'GET /feed-preferences': () => failure(500, 'INTERNAL') },
      });

      await user.click(toggle("Load images from publishers' websites"));

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { loadRemoteImages: true } }]);
    });
  });

  describe('in Slovak', () => {
    it('is written in the account language, and saves the same way', async () => {
      const { user, calls } = await openSettings({
        me: makeMe({ email: EMAIL, locale: 'sk' }),
      });

      const region = within(screen.getByRole('region', { name: 'Predvoľby čítania' }));
      const simple = region.getByRole('switch', { name: 'Jednoduchý režim' });
      expect(simple).toHaveAccessibleDescription(expect.stringContaining('bez úryvkov a miniatúr'));
      await user.click(simple);

      await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
      expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { simpleMode: true } }]);
      await waitFor(() => expect(simple).toHaveAccessibleDescription(/Uložené/));
    });
  });
});
