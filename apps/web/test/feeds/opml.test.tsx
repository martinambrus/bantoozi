import { OPML_INVALID_REASONS } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { subscriptionsKey } from '../../src/features/feeds/subscriptions.js';
import { UUID_V4, failure, json, text } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { USER_A_ID } from '../session/fixtures.js';
import { IMPORT_OPML, LIST, feedsServer, makeSubscription } from './support.js';

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

async function openFeeds() {
  const { server, state } = feedsServer({
    subscriptions: [makeSubscription({ feed: { id: '1', title: 'Old' } })],
  });
  const app = await open({ path: '/feeds', server });
  await screen.findByRole('heading', { level: 1, name: 'Feeds' });
  return { app, server, state };
}

const OPML = '<?xml version="1.0"?><opml version="2.0"><body><outline xmlUrl="x"/></body></opml>';

function opmlFile(name = 'subscriptions.opml') {
  return new File([OPML], name, { type: 'text/x-opml' });
}

const fileField = () => screen.getByLabelText('OPML file');

async function chooseFile(app: App, file = opmlFile()) {
  await app.user.upload(fileField(), file);
}

const importButton = () => screen.getByRole('button', { name: 'Import' });

const REASONS: Record<(typeof OPML_INVALID_REASONS)[number], string> = {
  invalid_url: "This isn't a valid web address.",
  unsupported_scheme: 'Only http and https addresses are supported.',
  credentials: "The address contains a username or password, which isn't allowed.",
  credential_param: "The address contains a secret key or token, which isn't allowed.",
  blocked_address: "The address points to a network that can't be used for feeds.",
  too_long: 'The address is too long.',
  missing_url: 'The entry has no feed address.',
  quota_exceeded: "Your plan's feed limit was reached before this entry.",
};

describe('importing OPML', () => {
  it('offers a file field and waits for a file before it allows the import', async () => {
    await openFeeds();

    expect(screen.getByRole('heading', { level: 2, name: 'Import and export' })).toBeVisible();
    expect(fileField()).toHaveAttribute('type', 'file');
    expect(fileField()).toHaveAttribute('accept', expect.stringContaining('.opml'));
    expect(importButton()).toBeDisabled();
  });

  it('uploads nothing until you press Import', async () => {
    const { app } = await openFeeds();

    await chooseFile(app);

    expect(importButton()).toBeEnabled();
    expect(app.calls(IMPORT_OPML)).toHaveLength(0);
  });

  it('sends the file as the one multipart part "file", leaving the content type to the browser', async () => {
    const { app, server } = await openFeeds();
    server.routes[IMPORT_OPML] = () => json(200, { added: 1, existing: 0, invalid: [] });

    await chooseFile(app, opmlFile('mine.opml'));
    await app.user.click(importButton());

    await waitFor(() => expect(app.calls(IMPORT_OPML)).toHaveLength(1));
    const request = app.calls(IMPORT_OPML)[0]!;
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    const part = form.get('file');
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe('mine.opml');
    expect((part as File).size).toBe(OPML.length);
    expect(request.headers.has('Content-Type')).toBe(false);
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
  });

  it('reports what was added, what existed and each entry that was not imported', async () => {
    const { app, server } = await openFeeds();
    server.routes[IMPORT_OPML] = () =>
      json(200, {
        added: 12,
        existing: 1,
        invalid: [
          { index: 2, url: 'ftp://files.example/feed', reason: 'unsupported_scheme' },
          { index: 4, url: '', reason: 'missing_url' },
        ],
      });

    await chooseFile(app);
    await app.user.click(importButton());

    const report = await screen.findByRole('region', { name: 'Import finished' });
    expect(within(report).getByText('Added 12 feeds.')).toBeVisible();
    expect(within(report).getByText('1 feed was already in your list.')).toBeVisible();
    expect(within(report).getByText("2 entries couldn't be imported")).toBeVisible();
    const entries = within(report).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Entry 3');
    expect(entries[0]).toHaveTextContent('ftp://files.example/feed');
    expect(entries[0]).toHaveTextContent('Only http and https addresses are supported.');
    expect(entries[1]).toHaveTextContent('Entry 5');
    expect(entries[1]).toHaveTextContent('no address');
    expect(entries[1]).toHaveTextContent('The entry has no feed address.');
  });

  it('keeps the plural forms right and leaves out the list when every entry was imported', async () => {
    const { app, server } = await openFeeds();
    server.routes[IMPORT_OPML] = () => json(200, { added: 1, existing: 2, invalid: [] });

    await chooseFile(app);
    await app.user.click(importButton());

    const report = await screen.findByRole('region', { name: 'Import finished' });
    expect(within(report).getByText('Added 1 feed.')).toBeVisible();
    expect(within(report).getByText('2 feeds were already in your list.')).toBeVisible();
    expect(within(report).queryByRole('list')).toBeNull();
    expect(within(report).queryByText(/couldn't be imported/)).toBeNull();
  });

  it.each(OPML_INVALID_REASONS)('explains the reason %s in words', async (reason) => {
    const { app, server } = await openFeeds();
    server.routes[IMPORT_OPML] = () =>
      json(200, {
        added: 0,
        existing: 0,
        invalid: [{ index: 0, url: 'http://x.example/', reason }],
      });

    await chooseFile(app);
    await app.user.click(importButton());

    const report = await screen.findByRole('region', { name: 'Import finished' });
    expect(within(report).getByRole('listitem')).toHaveTextContent(REASONS[reason]);
  });

  it('shows the imported feeds in the list and clears the file field', async () => {
    const { app, server, state } = await openFeeds();
    server.routes[IMPORT_OPML] = () => {
      state.subscriptions.push(makeSubscription({ feed: { id: '2', title: 'Imported' } }));
      return json(200, { added: 1, existing: 0, invalid: [] });
    };
    const listBefore = app.calls(LIST).length;

    await chooseFile(app);
    await app.user.click(importButton());

    expect(await screen.findByRole('heading', { level: 3, name: 'Imported' })).toBeVisible();
    expect(app.calls(LIST).length).toBeGreaterThan(listBefore);
    expect((fileField() as HTMLInputElement).files).toHaveLength(0);
    expect(importButton()).toBeDisabled();
  });

  it('sends one request even if the button is pressed again while it works', async () => {
    const { app, server } = await openFeeds();
    let answer: (response: Response) => void = () => undefined;
    server.routes[IMPORT_OPML] = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });

    await chooseFile(app);
    await app.user.click(importButton());
    await app.user.click(importButton());

    expect(importButton()).toBeDisabled();
    expect(app.calls(IMPORT_OPML)).toHaveLength(1);
    answer(json(200, { added: 0, existing: 0, invalid: [] }));
    expect(await screen.findByRole('region', { name: 'Import finished' })).toBeVisible();
  });

  it('keeps a file chosen while the import was on its way for the next import', async () => {
    const { app, server } = await openFeeds();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.routes[IMPORT_OPML] = async () => {
      await held;
      return json(200, { added: 1, existing: 0, invalid: [] });
    };

    await chooseFile(app, opmlFile('one.opml'));
    await app.user.click(importButton());
    await waitFor(() => expect(app.calls(IMPORT_OPML)).toHaveLength(1));
    await chooseFile(app, opmlFile('two.opml'));
    release();

    expect(await screen.findByRole('region', { name: 'Import finished' })).toBeVisible();
    expect(importButton()).toBeEnabled();
    expect((fileField() as HTMLInputElement).files?.[0]?.name).toBe('two.opml');
    await app.user.click(importButton());
    await waitFor(() => expect(app.calls(IMPORT_OPML)).toHaveLength(2));
    const next = (app.calls(IMPORT_OPML)[1]!.body as FormData).get('file');
    expect((next as File).name).toBe('two.opml');
  });

  it('still refreshes the list when the answer comes after the page was left', async () => {
    const { app, server } = await openFeeds();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.routes[IMPORT_OPML] = async () => {
      await held;
      return json(200, { added: 1, existing: 0, invalid: [] });
    };

    await chooseFile(app);
    await app.user.click(importButton());
    await waitFor(() => expect(app.calls(IMPORT_OPML)).toHaveLength(1));
    server.routes['GET /labels'] = () => json(200, []);
    await act(async () => {
      await app.router.navigate({ to: '/labels' });
    });
    release();

    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    expect(app.queryClient.getQueryState(subscriptionsKey(USER_A_ID))?.isInvalidated).toBe(true);
  });

  describe('when it fails', () => {
    it.each([
      [
        'OPML_INVALID',
        "That file isn't a valid OPML file. Export it again from your other reader and try once more.",
      ],
      [
        'OPML_TOO_LARGE',
        'That OPML file is too large. Split it into smaller files and import them one at a time.',
      ],
    ])('explains %s', async (code, message) => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () => failure(400, 'VALIDATION_FAILED', { code });

      await chooseFile(app);
      await app.user.click(importButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
    });

    it('explains the limit of feeds per import with the numbers', async () => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'opmlMaxFeeds', used: 450, max: 300 });

      await chooseFile(app);
      await app.user.click(importButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This file lists 450 feeds, but your plan allows importing 300 at a time. Split the file and import it in parts.',
      );
    });

    it('explains a validation error that names no OPML problem in general words', async () => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () => failure(400, 'VALIDATION_FAILED');

      await chooseFile(app);
      await app.user.click(importButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Some of the information isn't valid. Check it and try again.",
      );
    });

    it('explains any other plan limit with its numbers', async () => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxFeeds', used: 200, max: 200 });

      await chooseFile(app);
      await app.user.click(importButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "You've reached your plan's limit for feeds: 200 of 200.",
      );
    });

    it('says to wait when the daily limit of imports is used up', async () => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () => failure(429, 'RATE_LIMITED');

      await chooseFile(app);
      await app.user.click(importButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many requests. Wait a moment and try again.',
      );
    });

    it('keeps the file for another try, and the error goes when it works', async () => {
      const { app, server } = await openFeeds();
      server.routes[IMPORT_OPML] = () => failure(500, 'INTERNAL');
      await chooseFile(app);
      await app.user.click(importButton());
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(importButton()).toBeEnabled();

      server.routes[IMPORT_OPML] = () => json(200, { added: 3, existing: 0, invalid: [] });
      await app.user.click(importButton());

      expect(await screen.findByText('Added 3 feeds.')).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(app.calls(IMPORT_OPML)).toHaveLength(2);
    });
  });
});

describe('exporting OPML', () => {
  const EXPORT_OPML = 'GET /subscriptions/export-opml';
  const exportButton = () => screen.getByRole('button', { name: 'Export OPML' });

  const blobs: Blob[] = [];
  const saved: { href: string; download: string }[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;

  beforeAll(() => {
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return `blob:test-${blobs.length}`;
    });
    URL.revokeObjectURL = vi.fn();
  });

  afterAll(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  beforeEach(() => {
    blobs.length = 0;
    saved.length = 0;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      saved.push({ href: this.href, download: this.download });
    });
  });

  it('downloads the subscriptions through the API and saves them as an OPML file', async () => {
    const { app, server } = await openFeeds();
    server.routes[EXPORT_OPML] = () => text(200, OPML, { 'content-type': 'text/x-opml' });

    await app.user.click(exportButton());

    await waitFor(() =>
      expect(saved).toEqual([{ href: 'blob:test-1', download: 'bantoozi-subscriptions.opml' }]),
    );
    expect(app.calls(EXPORT_OPML)).toHaveLength(1);
    expect(app.calls(EXPORT_OPML)[0]?.credentials).toBe('same-origin');
    expect(blobs[0]?.type).toBe('text/x-opml');
    expect(await blobs[0]?.text()).toBe(OPML);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves nothing and says why when the server cannot export', async () => {
    const { app, server } = await openFeeds();
    server.routes[EXPORT_OPML] = () => failure(503, 'UNAVAILABLE');

    await app.user.click(exportButton());

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(saved).toHaveLength(0);
    expect(exportButton()).toBeEnabled();
  });

  it('ends the session when the server answers 401, as every other call does', async () => {
    const { app, server } = await openFeeds();
    server.routes[EXPORT_OPML] = () => failure(401, 'UNAUTHORIZED');

    await app.user.click(exportButton());

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(app.router.state.location.pathname).toBe('/login');
    expect(app.queryClient.getQueryData(meKey())).toBeNull();
    expect(saved).toHaveLength(0);
  });
});
