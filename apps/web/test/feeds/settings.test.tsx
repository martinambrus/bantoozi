import type { Me, Subscription } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { subscriptionsKey } from '../../src/features/feeds/subscriptions.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { gate } from '../interests/support.js';
import { bodyOf, type FakeServer } from '../support/app.js';
import {
  DELETE_FEED,
  LIST,
  SET_INFERENCE,
  UPDATE_FEED,
  feedsServer,
  findRow,
  makeSubscription,
  rowOf,
  type SubscriptionOverrides,
} from './support.js';

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

/** 22:30 UTC is already the next day in Bratislava. */
const ACTIVATED_AT = '2026-10-08T22:30:00.000Z';

/** The parts of the API that settings use, with the checks the real one makes. */
function installFeedApi(server: FakeServer, subscriptions: () => Subscription[]) {
  const find = (id: string | undefined) => subscriptions().find((sub) => sub.feed.id === id);
  server.routes[UPDATE_FEED] = (request, params) => {
    const sub = find(params['feedId']);
    if (sub === undefined) return failure(404, 'NOT_FOUND');
    Object.assign(sub, bodyOf(request));
    return json(200, { subscription: sub });
  };
  server.routes[SET_INFERENCE] = (request, params) => {
    const sub = find(params['feedId']);
    if (sub === undefined) return failure(404, 'NOT_FOUND');
    const { mode, expectedVersion } = bodyOf(request) as {
      mode: Subscription['inferenceMode'];
      expectedVersion: string;
    };
    if (expectedVersion !== sub.inferenceVersion) {
      return failure(409, 'STALE_STATE', { currentVersion: sub.inferenceVersion });
    }
    sub.inferenceMode = mode;
    sub.inferenceVersion = String(Number(sub.inferenceVersion) + 1);
    sub.inferenceActivatedAt = mode === 'active' ? ACTIVATED_AT : null;
    return json(200, { subscription: sub });
  };
  server.routes[DELETE_FEED] = (_request, params) => {
    const index = subscriptions().findIndex((sub) => sub.feed.id === params['feedId']);
    if (index < 0) return failure(404, 'NOT_FOUND');
    subscriptions().splice(index, 1);
    return noContent();
  };
}

async function openSettings(
  options: { alpha?: SubscriptionOverrides; me?: Me; title?: string } = {},
) {
  const alpha = makeSubscription({
    feed: { id: '5', title: 'Alpha' },
    folder: 'Tech',
    inferenceMode: 'off',
    inferenceVersion: '3',
    ...options.alpha,
  });
  const { server, state } = feedsServer({
    me: options.me ?? makeMe(),
    subscriptions: [
      alpha,
      makeSubscription({ feed: { id: '6', title: 'Beta' }, folder: 'News' }),
      makeSubscription({ feed: { id: '7', title: 'Gamma' } }),
    ],
  });
  installFeedApi(server, () => state.subscriptions);
  const app = await open({ path: '/feeds', server });
  const title = options.title ?? 'Alpha';
  await app.user.click(await screen.findByRole('button', { name: `Settings for ${title}` }));
  const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
  return { app, server, state, sheet, alpha };
}

const patches = (app: App) => app.calls(UPDATE_FEED).map((request) => bodyOf(request));
const inferences = (app: App) => app.calls(SET_INFERENCE).map((request) => bodyOf(request));
const save = (sheet: HTMLElement) => within(sheet).getByRole('button', { name: 'Save' });

async function saveChange(app: App, sheet: HTMLElement) {
  await app.user.click(save(sheet));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('the feed settings', () => {
  it('opens beside the list for the feed whose button was pressed, showing the current values', async () => {
    const { sheet } = await openSettings({
      alpha: { allowDuplicates: true, hidden: false, imagePolicy: 'block' },
    });

    expect(within(sheet).getByRole('heading', { level: 2, name: 'Feed settings' })).toBeVisible();
    expect(sheet).toHaveAccessibleDescription('Alpha');
    expect(within(sheet).getByLabelText('Title')).toHaveValue('');
    expect(within(sheet).getByLabelText('Folder')).toHaveDisplayValue('Tech');
    expect(within(sheet).getByRole('switch', { name: 'Allow duplicates' })).toBeChecked();
    expect(within(sheet).getByRole('switch', { name: 'Hide from sidebar' })).not.toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Always block' })).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Always allow' })).not.toBeChecked();
    expect(save(sheet)).toBeDisabled();
  });

  it('shows the override as the title and says what clearing it brings back', async () => {
    const { sheet } = await openSettings({
      alpha: { titleOverride: 'My Alpha' },
      title: 'My Alpha',
    });

    expect(sheet).toHaveAccessibleDescription('My Alpha');
    const field = within(sheet).getByLabelText('Title');
    expect(field).toHaveValue('My Alpha');
    expect(field).toHaveAccessibleDescription("Leave empty to use the feed's own title, “Alpha”.");
  });

  it('closes without a request when cancelled', async () => {
    const { app, sheet } = await openSettings();
    await app.user.type(within(sheet).getByLabelText('Title'), 'Changed');

    await app.user.click(within(sheet).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls(UPDATE_FEED)).toHaveLength(0);
  });

  describe('saving', () => {
    it('sends the title override and nothing else', async () => {
      const { app, sheet } = await openSettings();

      await app.user.type(within(sheet).getByLabelText('Title'), '  My Alpha ');
      expect(save(sheet)).toBeEnabled();
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ titleOverride: 'My Alpha' }]);
      const request = app.calls(UPDATE_FEED)[0]!;
      expect(new URL(request.url, 'http://x').pathname).toBe('/api/v1/subscriptions/5');
      expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(await screen.findByRole('heading', { level: 3, name: 'My Alpha' })).toBeVisible();
    });

    it('takes a change saved elsewhere into the fields not edited here, and sends only the edit', async () => {
      const { app, sheet, state } = await openSettings();
      await app.user.type(within(sheet).getByLabelText('Title'), 'My Alpha');

      // Another tab moves the feed to News, and the list of this tab is loaded again meanwhile.
      state.subscriptions.find((sub) => sub.feed.id === '5')!.folder = 'News';
      await act(() => app.queryClient.refetchQueries());

      await waitFor(() =>
        expect(within(sheet).getByLabelText('Folder')).toHaveDisplayValue('News'),
      );
      expect(within(sheet).getByLabelText('Title')).toHaveValue('My Alpha');
      await saveChange(app, sheet);
      expect(patches(app)).toEqual([{ titleOverride: 'My Alpha' }]);
    });

    it('clears an override with null', async () => {
      const { app, sheet } = await openSettings({
        alpha: { titleOverride: 'My Alpha' },
        title: 'My Alpha',
      });

      await app.user.clear(within(sheet).getByLabelText('Title'));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ titleOverride: null }]);
      expect(await screen.findByRole('heading', { level: 3, name: 'Alpha' })).toBeVisible();
    });

    it('treats a title of spaces as no change when there is no override', async () => {
      const { app, sheet } = await openSettings();

      await app.user.type(within(sheet).getByLabelText('Title'), '   ');

      expect(save(sheet)).toBeDisabled();
      expect(app.calls(UPDATE_FEED)).toHaveLength(0);
    });

    it('offers the existing folders and sends the chosen one', async () => {
      const { app, sheet } = await openSettings();
      const folder = within(sheet).getByLabelText('Folder');
      expect(
        within(folder)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['No folder', 'News', 'Tech', 'New folder…']);

      await app.user.selectOptions(folder, 'News');
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ folder: 'News' }]);
    });

    it('takes a feed out of its folder with null', async () => {
      const { app, sheet } = await openSettings();

      await app.user.selectOptions(within(sheet).getByLabelText('Folder'), 'No folder');
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ folder: null }]);
    });

    it('gives the focus back to the settings button of a feed that moved to another folder', async () => {
      const { app, sheet } = await openSettings({ title: 'Beta' });

      await app.user.selectOptions(within(sheet).getByLabelText('Folder'), 'Tech');
      await saveChange(app, sheet);

      const tech = await screen.findByRole('region', { name: 'Tech' });
      await waitFor(() =>
        expect(within(tech).getByRole('button', { name: 'Settings for Beta' })).toHaveFocus(),
      );
      expect(screen.queryByRole('region', { name: 'News' })).toBeNull();
    });

    it('creates a new folder by name', async () => {
      const { app, sheet } = await openSettings();
      expect(within(sheet).queryByLabelText('New folder name')).toBeNull();

      await app.user.selectOptions(within(sheet).getByLabelText('Folder'), 'New folder…');
      const name = within(sheet).getByLabelText('New folder name');
      expect(name).toBeRequired();
      expect(name).toHaveAttribute('maxlength', '100');
      expect(save(sheet)).toBeDisabled();
      await app.user.type(name, '  Reading list ');
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ folder: 'Reading list' }]);
      expect(
        within(await screen.findByRole('region', { name: 'Reading list' })).getByRole('heading', {
          level: 3,
          name: 'Alpha',
        }),
      ).toBeVisible();
    });

    it.each([
      ['Allow duplicates', { allowDuplicates: true }],
      ['Hide from sidebar', { hidden: true }],
    ])('sends %s when it is switched on', async (name, body) => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('switch', { name }));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([body]);
    });

    it.each([
      ['Allow duplicates', { allowDuplicates: false }, { allowDuplicates: true }],
      ['Hide from sidebar', { hidden: false }, { hidden: true }],
    ])('sends %s when it is switched off', async (name, body, alpha) => {
      const { app, sheet } = await openSettings({ alpha });

      await app.user.click(within(sheet).getByRole('switch', { name }));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([body]);
    });

    it.each([
      ['Always allow', 'allow'],
      ['Always block', 'block'],
    ])('sends the image policy for "%s"', async (name, imagePolicy) => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('radio', { name }));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ imagePolicy }]);
    });

    it('goes back to the global setting with inherit', async () => {
      const { app, sheet } = await openSettings({ alpha: { imagePolicy: 'allow' } });

      await app.user.click(within(sheet).getByRole('radio', { name: 'Use my global setting' }));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ imagePolicy: 'inherit' }]);
    });

    it('sends every change in one request', async () => {
      const { app, sheet } = await openSettings();

      await app.user.type(within(sheet).getByLabelText('Title'), 'My Alpha');
      await app.user.selectOptions(within(sheet).getByLabelText('Folder'), 'News');
      await app.user.click(within(sheet).getByRole('switch', { name: 'Allow duplicates' }));
      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));
      await app.user.click(within(sheet).getByRole('radio', { name: 'Always allow' }));
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([
        {
          titleOverride: 'My Alpha',
          folder: 'News',
          allowDuplicates: true,
          hidden: true,
          imagePolicy: 'allow',
        },
      ]);
    });

    it('does not offer a save when a change is undone', async () => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));
      expect(save(sheet)).toBeEnabled();
      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));

      expect(save(sheet)).toBeDisabled();
    });

    it('confirms with a message once the sheet is closed', async () => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));
      await saveChange(app, sheet);

      expect(await screen.findByText('Saved the settings of “Alpha”.')).toBeVisible();
    });

    it('explains a failure, keeps the sheet and the typed values, and lets you try again', async () => {
      const { app, server, sheet } = await openSettings();
      const works = server.routes[UPDATE_FEED]!;
      server.routes[UPDATE_FEED] = () => failure(500, 'INTERNAL');

      await app.user.type(within(sheet).getByLabelText('Title'), 'My Alpha');
      await app.user.click(save(sheet));

      expect(await within(sheet).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(within(sheet).getByLabelText('Title')).toHaveValue('My Alpha');
      expect(save(sheet)).toBeEnabled();

      server.routes[UPDATE_FEED] = works;
      await saveChange(app, sheet);
      expect(patches(app)).toHaveLength(2);
    });

    it('sends one request even if Save is pressed again while it works', async () => {
      const { app, server, sheet } = await openSettings();
      let answer: (response: Response) => void = () => undefined;
      server.routes[UPDATE_FEED] = () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        });

      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));
      await app.user.click(save(sheet));
      await app.user.click(save(sheet));

      expect(app.calls(UPDATE_FEED)).toHaveLength(1);
      answer(json(200, { subscription: makeSubscription({ feed: { id: '5', title: 'Alpha' } }) }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('still puts the saved values in the list when the answer comes after the page was left', async () => {
      const { app, server, sheet } = await openSettings();
      const answer = server.routes[UPDATE_FEED]!;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.routes[UPDATE_FEED] = async (request, params) => {
        await held;
        return answer(request, params);
      };

      await app.user.type(within(sheet).getByLabelText('Title'), 'My Alpha');
      await app.user.click(save(sheet));
      await waitFor(() => expect(app.calls(UPDATE_FEED)).toHaveLength(1));
      server.routes['GET /labels'] = () => json(200, []);
      await act(async () => {
        await app.router.navigate({ to: '/labels' });
      });
      release();

      await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
      const cached = app.queryClient.getQueryData<Subscription[]>(subscriptionsKey(USER_A_ID));
      expect(cached?.find((sub) => sub.feed.id === '5')?.titleOverride).toBe('My Alpha');
      expect(app.queryClient.getQueryState(subscriptionsKey(USER_A_ID))?.isInvalidated).toBe(true);
    });

    it('takes no other change while the save is on its way, and takes them again after a failure', async () => {
      const { app, server, sheet } = await openSettings();
      let answer: (response: Response) => void = () => undefined;
      server.routes[UPDATE_FEED] = () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        });
      await app.user.click(within(sheet).getByRole('switch', { name: 'Hide from sidebar' }));

      await app.user.click(save(sheet));

      await waitFor(() => expect(app.calls(UPDATE_FEED)).toHaveLength(1));
      const duplicates = within(sheet).getByRole('switch', { name: 'Allow duplicates' });
      expect(duplicates).toBeDisabled();
      expect(within(sheet).getByLabelText('Title')).toBeDisabled();
      expect(within(sheet).getByLabelText('Folder')).toBeDisabled();
      expect(within(sheet).getByRole('radio', { name: 'Always block' })).toBeDisabled();

      answer(failure(500, 'INTERNAL'));

      expect(await within(sheet).findByRole('alert')).toBeVisible();
      expect(duplicates).toBeEnabled();
      expect(within(sheet).getByRole('switch', { name: 'Hide from sidebar' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });

  describe('images', () => {
    it('says Always allow works while the global setting is off', async () => {
      const { sheet } = await openSettings({
        me: makeMe({ preferences: { loadRemoteImages: false } }),
      });

      expect(
        within(sheet).getByRole('radiogroup', { name: 'Images from this feed' }),
      ).toHaveAccessibleDescription(
        'Your global setting blocks images from all feeds. “Always allow” still works for this feed.',
      );
    });

    it('says Always block overrides the global setting while it is on', async () => {
      const { sheet } = await openSettings({
        me: makeMe({ preferences: { loadRemoteImages: true } }),
      });

      expect(
        within(sheet).getByRole('radiogroup', { name: 'Images from this feed' }),
      ).toHaveAccessibleDescription(
        'Your global setting loads images from all feeds. “Always block” overrides it for this feed.',
      );
    });

    it('lets Always allow be chosen while the global setting is off', async () => {
      const { app, sheet } = await openSettings({
        me: makeMe({ preferences: { loadRemoteImages: false } }),
      });

      const allow = within(sheet).getByRole('radio', { name: 'Always allow' });
      expect(allow).toBeEnabled();
      await app.user.click(allow);
      await saveChange(app, sheet);

      expect(patches(app)).toEqual([{ imagePolicy: 'allow' }]);
    });
  });

  describe('classification', () => {
    const classification = (sheet: HTMLElement) =>
      within(sheet).getByRole('region', { name: 'Classification' });

    it('explains that Off and Training are selection only, and that nothing runs on its own', async () => {
      const { sheet } = await openSettings();

      const section = classification(sheet);
      expect(within(section).getByText('Off')).toBeVisible();
      expect(section).toHaveTextContent('selection only');
      expect(section).toHaveTextContent('nothing is analysed unless you select it');
      expect(within(section).getByRole('button', { name: 'Switch to training' })).toBeVisible();
      expect(
        within(section).queryByRole('button', { name: 'Enable automatic classification' }),
      ).toBeNull();
    });

    it('switches Off to Training with the version it knows', async () => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));

      expect(
        await within(sheet).findByText('Classification is now: Training: selected articles.'),
      ).toBeVisible();
      expect(inferences(app)).toEqual([{ mode: 'training', expectedVersion: '3' }]);
      const request = app.calls(SET_INFERENCE)[0]!;
      expect(new URL(request.url, 'http://x').pathname).toBe('/api/v1/subscriptions/5/inference');
      expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      const section = classification(sheet);
      expect(section).toHaveTextContent('selection only');
      expect(
        within(section).getByRole('button', { name: 'Enable automatic classification' }),
      ).toBeVisible();
      expect(within(rowOf('Alpha')).getByText('Training: selected articles')).toBeVisible();
    });

    it('enables automatic classification for new articles and shows when it was switched on', async () => {
      const { app, sheet } = await openSettings({
        alpha: { inferenceMode: 'training', inferenceVersion: '4' },
      });
      const section = classification(sheet);
      expect(section).not.toHaveTextContent('has been on since');

      await app.user.click(
        within(section).getByRole('button', { name: 'Enable automatic classification' }),
      );

      expect(
        await within(sheet).findByText('Classification is now: Active: new articles.'),
      ).toBeVisible();
      expect(inferences(app)).toEqual([{ mode: 'active', expectedVersion: '4' }]);
      expect(section).toHaveTextContent(/Automatic classification has been on since Oct 9, 2026/);
      expect(within(rowOf('Alpha')).getByText('Active: new articles')).toBeVisible();
    });

    it('describes what Active does and does not do', async () => {
      const { sheet } = await openSettings({
        alpha: {
          inferenceMode: 'active',
          inferenceVersion: '5',
          inferenceActivatedAt: ACTIVATED_AT,
        },
      });

      const section = classification(sheet);
      expect(section).toHaveTextContent(
        'New articles from this feed are classified automatically.',
      );
      expect(section).toHaveTextContent('Older articles stay as they are');
      expect(section).toHaveTextContent(/has been on since Oct 9, 2026/);
    });

    it.each([
      ['training', 'Back to training', { mode: 'training', expectedVersion: '5' }],
      ['off', 'Turn classification off', { mode: 'off', expectedVersion: '5' }],
    ])('goes from Active back to %s', async (_mode, button, body) => {
      const { app, sheet } = await openSettings({
        alpha: {
          inferenceMode: 'active',
          inferenceVersion: '5',
          inferenceActivatedAt: ACTIVATED_AT,
        },
      });

      await app.user.click(within(sheet).getByRole('button', { name: button }));

      await waitFor(() => expect(inferences(app)).toEqual([body]));
      expect(await within(sheet).findByText(/^Classification is now:/)).toBeVisible();
      expect(classification(sheet)).not.toHaveTextContent('has been on since');
    });

    it('turns Training off', async () => {
      const { app, sheet } = await openSettings({
        alpha: { inferenceMode: 'training', inferenceVersion: '4' },
      });

      await app.user.click(within(sheet).getByRole('button', { name: 'Turn classification off' }));

      await waitFor(() => expect(inferences(app)).toEqual([{ mode: 'off', expectedVersion: '4' }]));
      expect(await within(sheet).findByText('Classification is now: Off.')).toBeVisible();
    });

    it.each(['training', 'active'] as const)(
      'explains that work already running can finish when going back from %s',
      async (inferenceMode) => {
        const { sheet } = await openSettings({
          alpha: {
            inferenceMode,
            inferenceVersion: '5',
            inferenceActivatedAt: inferenceMode === 'active' ? ACTIVATED_AT : null,
          },
        });

        expect(classification(sheet)).toHaveTextContent(
          'Work that is already running can still finish, because other subscribers of this feed may share it.',
        );
      },
    );

    it('has no such note while the feed is Off', async () => {
      const { sheet } = await openSettings();

      expect(classification(sheet)).not.toHaveTextContent('already running');
    });

    it('says the change is stale, reloads the feed and uses the new version next time', async () => {
      const { app, state, sheet } = await openSettings();
      const listBefore = app.calls(LIST).length;
      const elsewhere = state.subscriptions[0]!;
      elsewhere.inferenceMode = 'training';
      elsewhere.inferenceVersion = '9';

      await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));

      expect(await within(sheet).findByRole('alert')).toHaveTextContent(
        "This setting was changed from another device. We've reloaded it. Check the current setting and try again.",
      );
      expect(inferences(app)).toEqual([{ mode: 'training', expectedVersion: '3' }]);
      await waitFor(() => expect(app.calls(LIST).length).toBeGreaterThan(listBefore));
      const enable = await within(sheet).findByRole('button', {
        name: 'Enable automatic classification',
      });
      expect(within(rowOf('Alpha')).getByText('Training: selected articles')).toBeVisible();

      await app.user.click(enable);

      await waitFor(() => expect(inferences(app)).toHaveLength(2));
      expect(inferences(app)[1]).toEqual({ mode: 'active', expectedVersion: '9' });
      expect(within(sheet).queryByRole('alert')).toBeNull();
    });

    it('explains any other failure and leaves the setting as it was', async () => {
      const { app, server, sheet } = await openSettings();
      server.routes[SET_INFERENCE] = () => failure(500, 'INTERNAL');

      await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));

      expect(await within(sheet).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(within(rowOf('Alpha')).getByText('Off')).toBeVisible();
      expect(within(sheet).getByRole('button', { name: 'Switch to training' })).toBeEnabled();
    });

    it('sends one request even if the button is pressed again while it works', async () => {
      const { app, server, sheet } = await openSettings({
        alpha: { inferenceMode: 'training', inferenceVersion: '4' },
      });
      let answer: (response: Response) => void = () => undefined;
      server.routes[SET_INFERENCE] = () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        });

      const enable = within(sheet).getByRole('button', { name: 'Enable automatic classification' });
      await app.user.click(enable);
      await app.user.click(enable);

      expect(app.calls(SET_INFERENCE)).toHaveLength(1);
      expect(within(sheet).getByRole('button', { name: 'Turn classification off' })).toBeDisabled();
      answer(
        json(200, {
          subscription: makeSubscription({ feed: { id: '5' }, inferenceMode: 'active' }),
        }),
      );
      await within(sheet).findByText(/^Classification is now:/);
    });

    it('uses a new idempotency key for every change', async () => {
      const { app, sheet } = await openSettings();

      await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));
      await app.user.click(
        await within(sheet).findByRole('button', { name: 'Turn classification off' }),
      );

      await waitFor(() => expect(app.calls(SET_INFERENCE)).toHaveLength(2));
      const [first, second] = app.calls(SET_INFERENCE).map((r) => r.headers.get('Idempotency-Key'));
      expect(first).toMatch(UUID_V4);
      expect(second).toMatch(UUID_V4);
      expect(second).not.toBe(first);
    });

    it('keeps the settings saved while the change was on its way', async () => {
      const { app, server, sheet } = await openSettings();
      const answer = server.routes[SET_INFERENCE]!;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.routes[SET_INFERENCE] = async (request, params) => {
        // Built now, from the feed as it is: it does not have the title saved meanwhile.
        const response = await answer(request, params);
        await held;
        return response;
      };

      await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));
      await waitFor(() => expect(app.calls(SET_INFERENCE)).toHaveLength(1));
      await app.user.type(within(sheet).getByLabelText('Title'), 'My Alpha');
      await saveChange(app, sheet);
      release();

      await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
      const cached = app.queryClient.getQueryData<Subscription[]>(subscriptionsKey(USER_A_ID));
      expect(cached?.find((sub) => sub.feed.id === '5')).toMatchObject({
        titleOverride: 'My Alpha',
        inferenceMode: 'training',
        inferenceVersion: '4',
      });
      expect(
        await within(await findRow('My Alpha')).findByText('Training: selected articles'),
      ).toBeVisible();
    });

    describe('when the sheet is closed before the answer', () => {
      /** Sends a switch to Training, closes the sheet while it is on its way, then lets it answer. */
      async function switchAndClose(app: App, server: FakeServer, sheet: HTMLElement) {
        const answer = server.routes[SET_INFERENCE]!;
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        server.routes[SET_INFERENCE] = async (request, params) => {
          await held;
          return answer(request, params);
        };
        await app.user.click(within(sheet).getByRole('button', { name: 'Switch to training' }));
        await waitFor(() => expect(app.calls(SET_INFERENCE)).toHaveLength(1));
        await app.user.click(within(sheet).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        release();
      }

      it('still shows the new mode on the feed, and the next change sends its version', async () => {
        const { app, server, sheet } = await openSettings();
        const listBefore = app.calls(LIST).length;

        await switchAndClose(app, server, sheet);

        expect(
          await within(rowOf('Alpha')).findByText('Training: selected articles'),
        ).toBeVisible();
        expect(app.calls(LIST)).toHaveLength(listBefore);
        await app.user.click(screen.getByRole('button', { name: 'Settings for Alpha' }));
        const again = await screen.findByRole('dialog', { name: 'Feed settings' });
        await app.user.click(
          within(again).getByRole('button', { name: 'Enable automatic classification' }),
        );
        await waitFor(() => expect(inferences(app)).toHaveLength(2));
        expect(inferences(app)[1]).toEqual({ mode: 'active', expectedVersion: '4' });
      });

      it('still reloads the feeds when the change was stale', async () => {
        const { app, server, state, sheet } = await openSettings();
        const elsewhere = state.subscriptions[0]!;
        elsewhere.inferenceMode = 'training';
        elsewhere.inferenceVersion = '9';
        const listBefore = app.calls(LIST).length;

        await switchAndClose(app, server, sheet);

        await waitFor(() => expect(app.calls(LIST).length).toBeGreaterThan(listBefore));
        expect(
          await within(rowOf('Alpha')).findByText('Training: selected articles'),
        ).toBeVisible();
      });
    });
  });

  describe('unsubscribing', () => {
    async function askToUnsubscribe(app: App, sheet: HTMLElement) {
      await app.user.click(within(sheet).getByRole('button', { name: 'Unsubscribe' }));
      return screen.findByRole('dialog', { name: 'Unsubscribe from “Alpha”?' });
    }

    it('asks first, and does nothing when you cancel', async () => {
      const { app, sheet } = await openSettings();

      const confirm = await askToUnsubscribe(app, sheet);
      expect(confirm).toHaveAccessibleDescription(
        "You'll stop receiving its articles. Bookmarks you saved from it and your image setting for it are kept.",
      );
      await app.user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

      expect(app.calls(DELETE_FEED)).toHaveLength(0);
      expect(screen.queryByRole('dialog', { name: 'Unsubscribe from “Alpha”?' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Feed settings' })).toBeVisible();
    });

    it('deletes the subscription once confirmed, closes the sheet and drops the feed from the list', async () => {
      const { app, sheet } = await openSettings();

      const confirm = await askToUnsubscribe(app, sheet);
      await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const deletes = app.calls(DELETE_FEED);
      expect(deletes).toHaveLength(1);
      expect(new URL(deletes[0]!.url, 'http://x').pathname).toBe('/api/v1/subscriptions/5');
      expect(deletes[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
      expect(deletes[0]!.body).toBeNull();
      await waitFor(() =>
        expect(screen.queryByRole('heading', { level: 3, name: 'Alpha' })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('heading', { level: 3, name: 'Beta' })).toBeVisible();
      expect(await screen.findByText('Unsubscribed from “Alpha”.')).toBeVisible();
    });

    it('confirms nothing when the answer comes once the sign-in has ended', async () => {
      const { app, server, sheet } = await openSettings();
      const answer = gate();
      const remove = server.routes[DELETE_FEED]!;
      server.routes[DELETE_FEED] = async (request, params) => {
        await answer.opened;
        return remove(request, params);
      };

      const confirm = await askToUnsubscribe(app, sheet);
      await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));
      await waitFor(() => expect(app.calls(DELETE_FEED)).toHaveLength(1));

      server.me = null;
      await act(() => app.session.resetAccountState());
      answer.release();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(screen.queryByText('Unsubscribed from “Alpha”.')).toBeNull();
    });

    it('names the feed by the title it is shown with', async () => {
      const { app, sheet } = await openSettings({
        alpha: { titleOverride: 'My Alpha' },
        title: 'My Alpha',
      });

      await app.user.click(within(sheet).getByRole('button', { name: 'Unsubscribe' }));

      expect(
        await screen.findByRole('dialog', { name: 'Unsubscribe from “My Alpha”?' }),
      ).toBeVisible();
    });

    it('explains a failure inside the question and keeps the feed', async () => {
      const { app, server, sheet } = await openSettings();
      server.routes[DELETE_FEED] = () => failure(500, 'INTERNAL');

      const confirm = await askToUnsubscribe(app, sheet);
      await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

      expect(await within(confirm).findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      expect(screen.getByRole('dialog', { name: 'Unsubscribe from “Alpha”?' })).toBeVisible();
      expect(screen.getByRole('heading', { level: 3, name: 'Alpha' })).toBeVisible();
    });
  });
});
