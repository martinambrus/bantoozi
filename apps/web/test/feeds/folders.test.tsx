import type { Me, Subscription } from '@bantoozi/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import {
  LIST,
  RENAME,
  UPDATE_ME,
  feedIn,
  feedsServer,
  folderNames,
  makeSubscription,
  patchMeLikeTheApi,
} from './support.js';

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

async function openFolders(options: { folderOrder?: string[]; subscriptions: Subscription[] }) {
  const { server, state } = feedsServer({
    me: makeMe({ preferences: { folderOrder: options.folderOrder ?? [] } }),
    subscriptions: options.subscriptions,
  });
  server.routes[UPDATE_ME] = patchMeLikeTheApi(server);
  const app = await open({ path: '/feeds', server });
  await screen.findAllByRole('heading', { level: 3 });
  return { app, server, state };
}

const threeFolders = [
  feedIn('A', 'Alpha', '1'),
  feedIn('B', 'Beta', '2'),
  feedIn('C', 'Gamma', '3'),
];

const folder = (name: string) => screen.getByRole('region', { name });

function dragHandle(name: string): HTMLElement {
  const source = screen
    .getByRole('heading', { level: 2, name })
    .closest<HTMLElement>('[draggable="true"]');
  if (source === null) throw new Error(`folder ${name} cannot be dragged`);
  return source;
}

const patches = (app: App) => app.calls(UPDATE_ME).map((request) => bodyOf(request));

describe('the folders', () => {
  it('lists them in the saved order, then unknown ones alphabetically, then loose feeds', async () => {
    await openFolders({
      folderOrder: ['News', 'Gone', 'Tech'],
      subscriptions: [
        feedIn('Tech', 'T2', '1'),
        feedIn('Tech', 'T1', '2'),
        feedIn('News', 'N1', '3'),
        feedIn('Zeta', 'Z1', '4'),
        feedIn('alpha', 'A1', '5'),
        feedIn(null, 'Loose', '6'),
      ],
    });

    expect(folderNames()).toEqual(['News', 'Tech', 'alpha', 'Zeta']);
    const loose = screen.getByRole('region', { name: 'No folder' });
    expect(within(loose).getByRole('heading', { level: 3, name: 'Loose' })).toBeVisible();
    const list = screen.getByRole('list', { name: 'Folders' });
    expect(list.compareDocumentPosition(loose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(folder('Tech'))
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['T1', 'T2']);
  });

  it('counts the feeds of each folder', async () => {
    await openFolders({
      subscriptions: [feedIn('A', 'One', '1'), feedIn('B', 'Two', '2'), feedIn('B', 'Three', '3')],
    });

    expect(within(folder('A')).getByText('1 feed')).toBeVisible();
    expect(within(folder('B')).getByText('2 feeds')).toBeVisible();
  });

  it('has no move or rename controls and no drag handle for feeds without a folder', async () => {
    await openFolders({ subscriptions: [feedIn('A', 'One', '1'), feedIn(null, 'Loose', '2')] });

    const loose = screen.getByRole('region', { name: 'No folder' });
    expect(within(loose).queryByRole('button', { name: /^(Move|Rename)/ })).toBeNull();
    expect(loose.querySelector('[draggable="true"]')).toBeNull();
  });

  it('calls the group "All feeds" when no feed has a folder', async () => {
    await openFolders({ subscriptions: [feedIn(null, 'One', '1')] });

    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();
    expect(screen.getByRole('region', { name: 'All feeds' })).toBeVisible();
  });
});

describe('dragging a folder', () => {
  it('moves it to the place of the folder it is dropped on and saves the whole order', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    fireEvent.dragStart(dragHandle('A'));
    fireEvent.dragOver(folder('C'));
    fireEvent.drop(folder('C'));

    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]).toEqual({ preferences: { folderOrder: ['B', 'C', 'A'] } });
    expect(app.calls(UPDATE_ME)[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(folderNames()).toEqual(['B', 'C', 'A']));
  });

  it('moves a folder up the list the same way', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    fireEvent.dragStart(dragHandle('C'));
    fireEvent.dragOver(folder('A'));
    fireEvent.drop(folder('A'));

    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]).toEqual({ preferences: { folderOrder: ['C', 'A', 'B'] } });
  });

  it('saves the shown order, unknown folders included, without folders that have no feeds', async () => {
    const { app } = await openFolders({
      folderOrder: ['Gone', 'B'],
      subscriptions: [feedIn('B', 'Beta', '1'), feedIn('Z', 'Zed', '2'), feedIn('A', 'Alpha', '3')],
    });
    expect(folderNames()).toEqual(['B', 'A', 'Z']);

    fireEvent.dragStart(dragHandle('Z'));
    fireEvent.dragOver(folder('B'));
    fireEvent.drop(folder('B'));

    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]).toEqual({ preferences: { folderOrder: ['Z', 'B', 'A'] } });
  });

  it('allows a drop only while a folder is being dragged', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    expect(fireEvent.dragOver(folder('B'))).toBe(true);
    fireEvent.dragStart(dragHandle('A'));
    expect(fireEvent.dragOver(folder('B'))).toBe(false);
    fireEvent.dragEnd(dragHandle('A'));
    expect(fireEvent.dragOver(folder('B'))).toBe(true);
    fireEvent.drop(folder('B'));

    expect(patches(app)).toHaveLength(0);
  });

  it('saves nothing when a folder is dropped on itself', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    fireEvent.dragStart(dragHandle('B'));
    fireEvent.dragOver(folder('B'));
    fireEvent.drop(folder('B'));

    expect(patches(app)).toHaveLength(0);
  });

  it('marks the drag as a move for the browser', async () => {
    await openFolders({ folderOrder: ['A', 'B', 'C'], subscriptions: threeFolders });
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'uninitialized', dropEffect: 'none' };

    fireEvent.dragStart(dragHandle('A'), { dataTransfer });
    fireEvent.dragOver(folder('B'), { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'A');
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.dropEffect).toBe('move');
  });

  it('shows the new order at once, then keeps it when the server confirms', async () => {
    const { app, server } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });
    const save = patchMeLikeTheApi(server);
    let confirm: () => void = () => undefined;
    server.routes[UPDATE_ME] = (request, params) =>
      new Promise<Response>((resolve) => {
        confirm = () => void Promise.resolve(save(request, params)).then(resolve);
      });

    fireEvent.dragStart(dragHandle('A'));
    fireEvent.dragOver(folder('C'));
    fireEvent.drop(folder('C'));

    await waitFor(() => expect(folderNames()).toEqual(['B', 'C', 'A']));
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Move C up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    confirm();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move C up' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(folderNames()).toEqual(['B', 'C', 'A']);
  });

  it('goes back to the saved order and says so when the save fails', async () => {
    const { server } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });
    server.routes[UPDATE_ME] = () => failure(500, 'INTERNAL');

    fireEvent.dragStart(dragHandle('A'));
    fireEvent.dragOver(folder('C'));
    fireEvent.drop(folder('C'));

    expect(await screen.findByText('Something went wrong on our side. Try again.')).toBeVisible();
    expect(folderNames()).toEqual(['A', 'B', 'C']);
  });
});

describe('the move buttons', () => {
  it('move a folder one place and save the whole order', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    await app.user.click(screen.getByRole('button', { name: 'Move B up' }));

    await waitFor(() => expect(folderNames()).toEqual(['B', 'A', 'C']));
    expect(patches(app)).toEqual([{ preferences: { folderOrder: ['B', 'A', 'C'] } }]);
    expect(app.calls(UPDATE_ME)[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);

    await app.user.click(screen.getByRole('button', { name: 'Move A down' }));

    await waitFor(() => expect(folderNames()).toEqual(['B', 'C', 'A']));
    expect(patches(app)[1]).toEqual({ preferences: { folderOrder: ['B', 'C', 'A'] } });
  });

  it('cannot move the first folder up or the last one down', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });
    const unavailable = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-disabled') === 'true';

    expect(unavailable('Move A up')).toBe(true);
    expect(unavailable('Move A down')).toBe(false);
    expect(unavailable('Move C up')).toBe(false);
    expect(unavailable('Move C down')).toBe(true);

    await app.user.click(screen.getByRole('button', { name: 'Move A up' }));
    await app.user.click(screen.getByRole('button', { name: 'Move C down' }));

    expect(patches(app)).toHaveLength(0);
  });

  it('can move a folder that is not in the saved order yet, and saves the order as shown', async () => {
    const { app } = await openFolders({
      folderOrder: ['A'],
      subscriptions: threeFolders,
    });
    expect(folderNames()).toEqual(['A', 'B', 'C']);

    await app.user.click(screen.getByRole('button', { name: 'Move C up' }));

    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]).toEqual({ preferences: { folderOrder: ['A', 'C', 'B'] } });
  });

  it('announces where the folder went and keeps the focus on its button', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    await app.user.click(screen.getByRole('button', { name: 'Move B down' }));

    expect(await screen.findByText('Moved B to position 3 of 3.')).toBeInTheDocument();
    await waitFor(() => expect(folderNames()).toEqual(['A', 'C', 'B']));
    expect(screen.getByRole('button', { name: 'Move B down' })).toHaveFocus();
  });

  it('can be used from the keyboard', async () => {
    const { app } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });

    screen.getByRole('button', { name: 'Move C up' }).focus();
    await app.user.keyboard('{Enter}');

    await waitFor(() => expect(folderNames()).toEqual(['A', 'C', 'B']));
  });

  it('still keeps the saved order in the account when the answer comes after the page was left', async () => {
    const { app, server } = await openFolders({
      folderOrder: ['A', 'B', 'C'],
      subscriptions: threeFolders,
    });
    const save = patchMeLikeTheApi(server);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.routes[UPDATE_ME] = async (request, params) => {
      await held;
      return save(request, params);
    };

    await app.user.click(screen.getByRole('button', { name: 'Move B up' }));
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    server.routes['GET /labels'] = () => json(200, []);
    await act(async () => {
      await app.router.navigate({ to: '/labels' });
    });
    release();

    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    expect(app.queryClient.getQueryData<Me>(meKey())?.preferences.folderOrder).toEqual([
      'B',
      'A',
      'C',
    ]);
  });
});

describe('renaming a folder', () => {
  function renameServer(
    server: Awaited<ReturnType<typeof openFolders>>['server'],
    state: Awaited<ReturnType<typeof openFolders>>['state'],
  ) {
    server.routes[RENAME] = (request) => {
      const { from, to } = bodyOf(request) as { from: string; to: string };
      let count = 0;
      for (const subscription of state.subscriptions) {
        if (subscription.folder === from) {
          subscription.folder = to;
          count += 1;
        }
      }
      if (server.me !== null) {
        const renamed = server.me.preferences.folderOrder.map((name) =>
          name === from ? to : name,
        );
        server.me = {
          ...server.me,
          preferences: { ...server.me.preferences, folderOrder: [...new Set(renamed)] },
        };
      }
      return json(200, { count });
    };
  }

  async function openRename(name = 'Tech') {
    const opened = await openFolders({
      folderOrder: ['Tech', 'News'],
      subscriptions: [feedIn('Tech', 'Alpha', '1'), feedIn('News', 'Beta', '2')],
    });
    renameServer(opened.server, opened.state);
    await opened.app.user.click(screen.getByRole('button', { name: `Rename folder ${name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    return { ...opened, dialog };
  }

  it('asks for the new name, starting from the current one', async () => {
    const { dialog } = await openRename();

    const field = within(dialog).getByLabelText('Folder name');
    expect(field).toHaveValue('Tech');
    expect(field).toHaveAttribute('maxlength', '100');
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('posts the old and the new name, then refetches the feeds and the account', async () => {
    const { app, dialog } = await openRename();
    const listBefore = app.calls(LIST).length;
    const meBefore = app.calls('GET /me').length;

    const field = within(dialog).getByLabelText('Folder name');
    await app.user.clear(field);
    await app.user.type(field, 'Technology');
    await app.user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = app.calls(RENAME);
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({ from: 'Tech', to: 'Technology' });
    expect(posts[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.calls(LIST).length).toBeGreaterThan(listBefore);
    expect(app.calls('GET /me').length).toBeGreaterThan(meBefore);
    expect(folderNames()).toEqual(['Technology', 'News']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rename folder Technology' })).toHaveFocus(),
    );
  });

  it('sends the name without the spaces around it', async () => {
    const { app, dialog } = await openRename();

    const field = within(dialog).getByLabelText('Folder name');
    await app.user.clear(field);
    await app.user.type(field, '  Reading  ');
    await app.user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(app.calls(RENAME)).toHaveLength(1));
    expect(bodyOf(app.calls(RENAME)[0]!)).toEqual({ from: 'Tech', to: 'Reading' });
  });

  it('does not allow an empty or an unchanged name', async () => {
    const { app, dialog } = await openRename();
    const field = within(dialog).getByLabelText('Folder name');
    const submit = within(dialog).getByRole('button', { name: 'Rename' });

    await app.user.clear(field);
    expect(submit).toBeDisabled();
    await app.user.type(field, '   ');
    expect(submit).toBeDisabled();
    await app.user.clear(field);
    await app.user.type(field, ' Tech ');
    expect(submit).toBeDisabled();
    await app.user.type(field, 'x');
    expect(submit).toBeEnabled();
    expect(app.calls(RENAME)).toHaveLength(0);
  });

  it('warns that renaming to an existing folder merges the two', async () => {
    const { app, dialog } = await openRename();

    const field = within(dialog).getByLabelText('Folder name');
    expect(within(dialog).queryByText(/already exists/)).toBeNull();
    await app.user.clear(field);
    await app.user.type(field, 'News');

    expect(
      within(dialog).getByText(
        'A folder with this name already exists. Its feeds will be merged with this one.',
      ),
    ).toBeVisible();
  });

  it('explains a failure and stays open with the name that was typed', async () => {
    const { app, server, dialog } = await openRename();
    server.routes[RENAME] = () => failure(500, 'INTERNAL');

    const field = within(dialog).getByLabelText('Folder name');
    await app.user.clear(field);
    await app.user.type(field, 'Technology');
    await app.user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(screen.getByRole('dialog', { name: 'Rename folder' })).toBeVisible();
    expect(field).toHaveValue('Technology');
    expect(folderNames()).toEqual(['Tech', 'News']);
  });

  it('closes without a request when cancelled', async () => {
    const { app, dialog } = await openRename();

    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls(RENAME)).toHaveLength(0);
  });

  it('is offered for every folder under its own name', async () => {
    await openFolders({
      subscriptions: [
        feedIn('Tech', 'Alpha', '1'),
        feedIn('News', 'Beta', '2'),
        makeSubscription({ feed: { id: '3', title: 'Loose' } }),
      ],
    });

    expect(screen.getByRole('button', { name: 'Rename folder Tech' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename folder News' })).toBeVisible();
  });
});
