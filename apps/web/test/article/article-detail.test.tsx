import type { ArticleListItem, BookmarkSnapshot } from '@bantoozi/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { ArticleDetail } from '../../src/features/article/article-detail.js';
import { failure, json, noContent } from '../api/fake-fetch.js';
import type { ApiRouteHandler } from '../support/app.js';
import { acked } from '../reader/actions/fake-transport.js';
import {
  MUTATION_ID,
  actionResponse,
  bodyOf,
  deferred,
  detailRoute,
  findToast,
  labelRoute,
  makeDetail,
  makeItem,
  makeLabel,
  makeMe,
  makeRule,
  ratingResponse,
  renderReader,
  restoreVisibility,
  setVisibility,
  type ReaderHarnessOptions,
} from './harness.js';

const URL_101 = 'https://example.test/articles/101';
const ITEM = makeItem({ author: 'Jane Doe' });

function renderDetail(
  item: ArticleListItem = ITEM,
  props: Partial<ComponentProps<typeof ArticleDetail>> = {},
  options: ReaderHarnessOptions = {},
) {
  return renderReader(<ArticleDetail item={item} {...props} />, {
    ...options,
    routes: { ...detailRoute(item), ...options.routes },
  });
}

const implicit = () => makeMe({ preferences: { implicitFeedback: true } });

afterEach(() => {
  restoreVisibility();
  vi.restoreAllMocks();
});

describe('ArticleDetail loading', () => {
  it('asks for the detail of the article and shows its excerpt', async () => {
    const { calls } = renderDetail();
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(await screen.findByText('The excerpt of the article.')).toBeInTheDocument();
    const [request] = calls('GET', '/articles/101');
    expect(calls('GET', '/articles/101')).toHaveLength(1);
    expect([...request!.query]).toEqual([]);
  });

  it('projects the detail like the feed view it is opened from', async () => {
    const { calls } = renderDetail(ITEM, { sourceFeedId: '7' });
    await screen.findByText('The excerpt of the article.');
    expect(Object.fromEntries(calls('GET', '/articles/101')[0]!.query)).toEqual({
      sourceFeedId: '7',
    });
  });

  it('asks for the saved copy in the bookmarks view', async () => {
    const item = makeItem({ bookmarkedAt: '2026-05-30T09:00:00.000Z' });
    const { calls } = renderDetail(item, { saved: true });
    await waitFor(() => expect(calls('GET', '/articles/101')).toHaveLength(1));
    expect(Object.fromEntries(calls('GET', '/articles/101')[0]!.query)).toEqual({ view: 'saved' });
  });

  it('names the author when there is one', async () => {
    const withAuthor = renderDetail();
    expect(await screen.findByText('By Jane Doe')).toBeInTheDocument();
    withAuthor.unmount();

    renderDetail(makeItem({ author: null }));
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByText(/^By /)).toBeNull();
  });

  it('keeps the actions usable and offers a retry when the detail cannot be loaded', async () => {
    let healthy = false;
    const { user } = renderDetail(
      ITEM,
      {},
      {
        routes: {
          'GET /articles/:id': () =>
            healthy ? json(200, makeDetail(ITEM)) : failure(500, 'INTERNAL'),
        },
      },
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument();

    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The excerpt of the article.')).toBeInTheDocument();
  });
});

describe('ArticleDetail body', () => {
  it('renders the excerpt through the sanitizer', async () => {
    renderDetail(
      ITEM,
      {},
      {
        routes: detailRoute(ITEM, {
          excerptHtml:
            '<p onclick="x()">Safe <b>bold</b></p><script>window.hacked = 1</script>' +
            '<a href="javascript:alert(1)">bad link</a> <a href="https://example.test/x">good link</a>',
        }),
      },
    );
    const good = await screen.findByText('good link');
    expect(good).toHaveAttribute('href', 'https://example.test/x');
    expect(good).toHaveAttribute('target', '_blank');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('bad link')).not.toHaveAttribute('href');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[onclick]')).toBeNull();
  });

  it('keeps remote images out of the excerpt while images are not allowed', async () => {
    renderDetail(
      ITEM,
      {},
      {
        routes: detailRoute(ITEM, {
          excerptHtml: '<p>Text</p><img src="https://cdn.test/a.png" alt="A cat">',
        }),
      },
    );
    expect(await screen.findByText('A cat')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[src]')).toBeNull();
  });

  it('loads the images of the excerpt once they are allowed', async () => {
    const item = makeItem({ effectiveImagesAllowed: true, mediaPolicyFeedId: '7' });
    renderDetail(
      item,
      {},
      {
        routes: detailRoute(item, {
          excerptHtml: '<p>Text</p><img src="https://cdn.test/a.png" alt="A cat">',
        }),
      },
    );
    await screen.findByText('Text');
    const image = document.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://cdn.test/a.png');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('falls back to the plain-text lead and escapes it', async () => {
    renderDetail(
      ITEM,
      {},
      {
        routes: detailRoute(ITEM, {
          excerptHtml: null,
          bodyLead: 'First paragraph.\n\nSecond <b>paragraph</b> & more.',
        }),
      },
    );
    expect(await screen.findByText('First paragraph.')).toBeInTheDocument();
    expect(screen.getByText('Second <b>paragraph</b> & more.')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('says so when there is nothing to preview', async () => {
    renderDetail(ITEM, {}, { routes: detailRoute(ITEM, { excerptHtml: null, bodyLead: null }) });
    expect(
      await screen.findByText('No preview is available for this article.'),
    ).toBeInTheDocument();
  });

  it('offers the English translation of the title and excerpt as a toggle', async () => {
    const withTranslation = renderDetail(
      ITEM,
      {},
      {
        routes: detailRoute(ITEM, {
          translation: {
            title: 'Translated title',
            excerpt: 'Translated excerpt',
            engine: 'libretranslate',
            quality: 'ok',
          },
        }),
      },
    );
    expect(await screen.findByText('The excerpt of the article.')).toBeInTheDocument();
    expect(screen.queryByText('Translated title')).toBeNull();

    await withTranslation.user.click(
      screen.getByRole('button', { name: 'Show English translation' }),
    );
    expect(screen.getByText('Translated title')).toBeInTheDocument();
    expect(screen.getByText('Translated excerpt')).toBeInTheDocument();
    expect(screen.queryByText('The excerpt of the article.')).toBeNull();

    await withTranslation.user.click(screen.getByRole('button', { name: 'Show original' }));
    expect(screen.getByText('The excerpt of the article.')).toBeInTheDocument();
    expect(screen.queryByText('Translated title')).toBeNull();
  });

  it('offers no toggle when the article has no translation', async () => {
    renderDetail();
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByRole('button', { name: 'Show English translation' })).toBeNull();
  });
});

describe('ArticleDetail "Read original"', () => {
  let open: MockInstance<typeof window.open>;
  beforeEach(() => {
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });

  it.each([
    ['no address', null],
    ['a relative address', '/articles/101'],
    ['a javascript address', 'javascript:alert(1)'],
    ['an ftp address', 'ftp://example.test/file'],
    ['a malformed address', 'not a url'],
  ])('is not offered with %s', async (_name, url) => {
    renderDetail(makeItem({ url }));
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByRole('button', { name: 'Read original' })).toBeNull();
  });

  it('opens the address in a new tab before it reports the open', async () => {
    const item = makeItem();
    const answer = deferred<Response>();
    const { user, calls } = renderDetail(
      item,
      {},
      {
        routes: { 'POST /articles/:id/open': () => answer.promise },
      },
    );
    const requestsWhenOpened: number[] = [];
    open.mockImplementation(() => {
      requestsWhenOpened.push(calls('POST', '/articles/101/open').length);
      return null;
    });

    await user.click(await screen.findByRole('button', { name: 'Read original' }));

    expect(open).toHaveBeenCalledExactlyOnceWith(URL_101, '_blank', 'noopener,noreferrer');
    expect(requestsWhenOpened).toEqual([0]);
    await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/articles/101/open')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
    });
    expect(screen.getByRole('group', { name: 'Article actions' })).toBeInTheDocument();
    answer.resolve(actionResponse(acked(item, { readAt: '2026-05-31T10:00:00.000Z' })));
  });

  it('still opens the address when the open cannot be reported', async () => {
    const { user, calls } = renderDetail(
      ITEM,
      {},
      {
        routes: { 'POST /articles/:id/open': () => failure(400, 'VALIDATION_FAILED') },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Read original' }));
    await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByText("Couldn't save — retry")).toBeNull();
  });

  describe('dwell', () => {
    const OPENED = acked(ITEM, { readAt: '2026-05-31T10:00:00.000Z' });
    const routes = {
      'POST /articles/:id/open': () => actionResponse(OPENED),
      'POST /articles/:id/dwell': () => actionResponse(acked(OPENED), { prompt: false }),
    };

    function leaveAndReturn(awayMs: number) {
      const start = Date.now();
      setVisibility('hidden');
      vi.setSystemTime(start + awayMs);
      setVisibility('visible');
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-31T10:00:00.000Z'));
    });

    it('is sent once when the page is visible again, with the time spent away', async () => {
      const { user, calls } = renderDetail(ITEM, {}, { me: implicit(), routes });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));

      leaveAndReturn(90_000);

      await waitFor(() => expect(calls('POST', '/articles/101/dwell')).toHaveLength(1));
      expect(bodyOf(calls('POST', '/articles/101/dwell')[0]!)).toEqual({
        stateVersion: '5',
        contentRevision: '2',
        ms: 90_000,
      });

      leaveAndReturn(60_000);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls('POST', '/articles/101/dwell')).toHaveLength(1);
    });

    it('is clamped to 30 minutes', async () => {
      const { user, calls } = renderDetail(ITEM, {}, { me: implicit(), routes });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));

      leaveAndReturn(3 * 60 * 60_000);

      await waitFor(() => expect(calls('POST', '/articles/101/dwell')).toHaveLength(1));
      expect(bodyOf(calls('POST', '/articles/101/dwell')[0]!)).toMatchObject({ ms: 1_800_000 });
    });

    it('is not sent when implicit feedback is off', async () => {
      const { user, calls } = renderDetail(ITEM, {}, { routes });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));

      leaveAndReturn(90_000);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(calls('POST', '/articles/101/dwell')).toHaveLength(0);
    });

    it('is not sent when the page was never left', async () => {
      const { user, calls } = renderDetail(ITEM, {}, { me: implicit(), routes });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));

      setVisibility('visible');
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(calls('POST', '/articles/101/dwell')).toHaveLength(0);
    });

    it('is not sent when the page was left long after the original was opened', async () => {
      const { user, calls } = renderDetail(ITEM, {}, { me: implicit(), routes });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));

      vi.setSystemTime(Date.now() + 60_000);
      leaveAndReturn(90_000);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(calls('POST', '/articles/101/dwell')).toHaveLength(0);
    });

    it('is sent even when the article was closed in the meantime', async () => {
      function Host() {
        const [shown, setShown] = useState(true);
        return (
          <>
            {shown ? <ArticleDetail item={ITEM} /> : null}
            <button type="button" onClick={() => setShown(false)}>
              Collapse
            </button>
          </>
        );
      }
      const { user, calls } = renderReader(<Host />, {
        me: implicit(),
        routes: { ...detailRoute(ITEM), ...routes },
      });
      await user.click(await screen.findByRole('button', { name: 'Read original' }));
      await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));
      await user.click(screen.getByRole('button', { name: 'Collapse' }));
      expect(screen.queryByRole('button', { name: 'Read original' })).toBeNull();

      leaveAndReturn(45_000);

      await waitFor(() => expect(calls('POST', '/articles/101/dwell')).toHaveLength(1));
    });
  });
});

describe('ArticleDetail action bar', () => {
  it('names every control and gives it a 44 px target and a focus ring', async () => {
    const { user } = renderDetail(
      makeItem({ author: 'Jane Doe' }),
      { onWhyThis: vi.fn() },
      {
        routes: labelRoute(makeLabel('11', 'Politics')),
      },
    );
    await screen.findByText('The excerpt of the article.');
    const controls = screen.getAllByRole('button');
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const control of controls) {
      expect(control).toHaveAccessibleName();
      expect(control.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(control.className).toContain(token);
    }
    await user.click(screen.getByRole('button', { name: 'Labels' }));
    for (const item of screen.getAllByRole('menuitem')) expect(item).toHaveAccessibleName();
  });

  it('rates and bookmarks with the fence, the request of the analysis and the feed', async () => {
    const requestId = '3f1c2b64-8a5e-4c63-9f0e-5d7a9b1c2e30';
    const item = makeItem({ analysis: { mode: 'training', status: 'pending', requestId } });
    const { user, calls } = renderDetail(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: -1 })),
          'POST /articles/:id/bookmark': () =>
            actionResponse(
              acked(acked(item, { rating: -1 }), { bookmarkedAt: '2026-05-31T10:00:00Z' }),
            ),
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Dislike' }));
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    await user.click(
      within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
        name: 'Seen it',
      }),
    );
    await waitFor(() => expect(calls('POST', '/articles/101/rating')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
      reason: 'seen',
      analysisRequestId: requestId,
    });
    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(calls('POST', '/articles/101/bookmark')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/articles/101/bookmark')[0]!)).toMatchObject({
      contentRevision: '2',
      mediaPolicyFeedId: '7',
    });
  });

  it('hides with a Shift+click on the like, as the row does', async () => {
    const item = makeItem();
    const { calls } = renderDetail(
      item,
      {},
      {
        routes: {
          'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: 1 })),
        },
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Like' }), { shiftKey: true });

    await waitFor(() => expect(calls('POST', '/articles/101/rating')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
      hide: true,
    });
  });

  it('adds a label from the menu', async () => {
    const item = makeItem({ labelIds: ['11'] });
    const { user, calls } = renderDetail(
      item,
      {},
      {
        routes: {
          ...labelRoute(makeLabel('11', 'Politics'), makeLabel('12', 'Sports')),
          'POST /articles/:id/labels': () =>
            actionResponse(acked(item, { labelIds: ['11', '12'] })),
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Labels' }));
    const menu = await screen.findByRole('menu');
    expect(
      await within(menu).findByRole('menuitem', { name: 'Remove label Politics' }),
    ).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Add label Sports' }));

    expect(bodyOf(calls('POST', '/articles/101/labels')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      labelId: '12',
    });
    await user.click(screen.getByRole('button', { name: 'Labels' }));
    expect(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: 'Remove label Sports',
      }),
    ).toBeInTheDocument();
  });

  it('removes a label from the menu, with the fence in the query string', async () => {
    const item = makeItem({ labelIds: ['11', '12'] });
    const { user, calls } = renderDetail(
      item,
      {},
      {
        routes: {
          ...labelRoute(makeLabel('11', 'Politics'), makeLabel('12', 'Sports')),
          'DELETE /articles/:id/labels/:labelId': () =>
            actionResponse(acked(item, { labelIds: ['12'] })),
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Labels' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove label Politics' }));

    const [request] = calls('DELETE', '/articles/101/labels/11');
    expect(Object.fromEntries(request!.query)).toEqual({ stateVersion: '4', contentRevision: '2' });
  });

  it('says there are no labels to choose from', async () => {
    const { user } = renderDetail(ITEM, {}, { routes: labelRoute() });
    await user.click(await screen.findByRole('button', { name: 'Labels' }));
    expect(await screen.findByRole('menuitem', { name: 'You have no labels yet' })).toBeDisabled();
  });

  it('opens "Why this?" when a handler is given', async () => {
    const without = renderDetail();
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByRole('button', { name: 'Why this?' })).toBeNull();
    without.unmount();

    const onWhyThis = vi.fn();
    const { user } = renderDetail(ITEM, { onWhyThis });
    await user.click(await screen.findByRole('button', { name: 'Why this?' }));
    expect(onWhyThis).toHaveBeenCalledOnce();
  });
});

describe('ArticleDetail rules', () => {
  const ruleRoutes = (kind: string, value: string) => ({
    'POST /rules': () => json(201, { rule: makeRule('55', kind, value) }),
    'POST /articles/:id/mute-story': () => json(201, { rule: makeRule('55', 'mute_story', '9') }),
    'DELETE /rules/:id': () => noContent(),
  });

  async function undoToast(user: ReturnType<typeof renderDetail>['user'], message: string) {
    const toast = await findToast(message);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  }

  it.each([
    [1, 'Mute for 1 day', 'Story muted for 1 day'],
    [3, 'Mute for 3 days', 'Story muted for 3 days'],
    [7, 'Mute for 7 days', 'Story muted for 7 days'],
    [30, 'Mute for 30 days', 'Story muted for 30 days'],
  ])('mutes the story for %s days and can take it back', async (days, item, message) => {
    const { user, calls } = renderDetail(ITEM, {}, { routes: ruleRoutes('mute_story', '9') });
    await user.click(await screen.findByRole('button', { name: 'Mute story' }));
    await user.click(await screen.findByRole('menuitem', { name: item }));

    expect(bodyOf(calls('POST', '/articles/101/mute-story')[0]!)).toEqual({ days });
    await undoToast(user, message);

    await waitFor(() => expect(calls('DELETE', '/rules/55')).toHaveLength(1));
    expect(await screen.findByText('Rule removed')).toBeInTheDocument();
  });

  it.each([
    ['Block this feed', { kind: 'block_feed', value: '7' }, 'Blocked source: Example Weekly'],
    [
      'Block this website',
      { kind: 'block_domain', value: 'example.test' },
      'Blocked website: example.test',
    ],
    ['Block this author', { kind: 'block_author', value: 'Jane Doe' }, 'Blocked author: Jane Doe'],
    ['Boost this feed', { kind: 'boost_feed', value: '7' }, 'Boosted source: Example Weekly'],
  ])('%s creates a rule and can take it back', async (name, body, message) => {
    const { user, calls } = renderDetail(ITEM, {}, { routes: ruleRoutes(body.kind, body.value) });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name }));

    expect(bodyOf(calls('POST', '/rules')[0]!)).toEqual(body);
    await undoToast(user, message);

    await waitFor(() => expect(calls('DELETE', '/rules/55')).toHaveLength(1));
    expect(await screen.findByText('Rule removed')).toBeInTheDocument();
  });

  it('leaves out the actions that need data the article does not have', async () => {
    const { user } = renderDetail(makeItem({ url: null, author: null }));
    await user.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Block this feed' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Boost this feed' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Block this website' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Block this author' })).toBeNull();
  });

  it('has no "More" menu when none of its actions is possible', async () => {
    renderDetail(makeItem({ url: null, author: null, feed: null }));
    await screen.findByRole('button', { name: 'Mute story' });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('reports a rule the server refused', async () => {
    const { user } = renderDetail(
      ITEM,
      {},
      {
        routes: {
          'POST /rules': () =>
            failure(409, 'QUOTA_EXCEEDED', { limit: 'maxRules', used: 200, max: 200 }),
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Block this feed' }));
    expect(
      await findToast("You've reached your plan's limit for rules: 200 of 200."),
    ).toBeInTheDocument();
  });

  it('reports a rule that could not be taken back', async () => {
    const { user } = renderDetail(
      ITEM,
      {},
      {
        routes: {
          ...ruleRoutes('block_feed', '7'),
          'DELETE /rules/:id': () => failure(404, 'NOT_FOUND'),
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Block this feed' }));
    await undoToast(user, 'Blocked source: Example Weekly');
    expect(await findToast("We couldn't find that.")).toBeInTheDocument();
  });
});

describe('ArticleDetail capture', () => {
  const BOOKMARKED = '2026-05-30T09:00:00.000Z';
  const capture = (status: 'pending' | 'saved' | 'partial' | 'failed') => ({
    status,
    generation: '3',
    snapshotId: status === 'saved' || status === 'partial' ? '900' : null,
    capturedAt: status === 'saved' || status === 'partial' ? '2026-05-30T09:05:00.000Z' : null,
    errorCode: status === 'failed' ? 'paywall' : null,
  });

  it.each([
    ['pending', 'Saving article'],
    ['saved', 'Full text saved'],
    ['partial', 'Partial text saved'],
    ['failed', 'Could not capture article'],
  ] as const)('labels a %s capture', async (status, label) => {
    renderDetail(makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture(status) }));
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('offers a retry only for partial and failed captures', async () => {
    for (const status of ['pending', 'saved'] as const) {
      const view = renderDetail(
        makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture(status) }),
      );
      await screen.findByText(/text saved|Saving article/);
      expect(screen.queryByRole('button', { name: 'Retry capture' })).toBeNull();
      view.unmount();
    }
    for (const status of ['partial', 'failed'] as const) {
      const view = renderDetail(
        makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture(status) }),
      );
      expect(await screen.findByRole('button', { name: 'Retry capture' })).toBeInTheDocument();
      expect(
        screen.getByText(
          'The site may have shown only a teaser, required a subscription or been unavailable.',
        ),
      ).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says that only text and formatting are archived', async () => {
    for (const status of ['saved', 'partial'] as const) {
      const view = renderDetail(
        makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture(status) }),
      );
      expect(
        await screen.findByText(
          'Text and formatting saved; images and other media are not archived',
        ),
      ).toBeInTheDocument();
      view.unmount();
    }
    for (const status of ['pending', 'failed'] as const) {
      const view = renderDetail(
        makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture(status) }),
      );
      await screen.findByText(/Saving article|Could not capture article/);
      expect(screen.queryByText(/images and other media/)).toBeNull();
      view.unmount();
    }
  });

  it('shows no capture status for an article that is not bookmarked', async () => {
    renderDetail(makeItem());
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByText(/Saving article|text saved|Could not capture/)).toBeNull();
  });

  it('retries with the generation of the capture and shows it as pending at once', async () => {
    const item = makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture('failed') });
    const answer = deferred<Response>();
    const { user, calls } = renderDetail(
      item,
      {},
      {
        routes: { 'POST /articles/:id/bookmark/retry-capture': () => answer.promise },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Retry capture' }));

    expect(bodyOf(calls('POST', '/articles/101/bookmark/retry-capture')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      captureGeneration: '3',
    });
    expect(screen.getByText('Saving article')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry capture' })).toBeNull();
    answer.resolve(
      json(202, {
        item: acked(item, { bookmarkCapture: { ...capture('pending'), generation: '4' } }),
        mutationId: '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10',
      }),
    );
    await waitFor(() => expect(screen.getByText('Saving article')).toBeInTheDocument());
  });

  describe('while the capture is pending', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('asks again every 5 seconds until it is done', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const item = makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture('pending') });
      let answers = 0;
      const { calls } = renderDetail(
        item,
        {},
        {
          routes: {
            'GET /articles/:id': () => {
              answers += 1;
              return json(
                200,
                makeDetail(
                  answers < 2
                    ? item
                    : makeItem({ bookmarkedAt: BOOKMARKED, bookmarkCapture: capture('saved') }),
                ),
              );
            },
          },
        },
      );
      expect(await screen.findByText('Saving article')).toBeInTheDocument();
      expect(calls('GET', '/articles/101')).toHaveLength(1);

      await act(() => vi.advanceTimersByTimeAsync(4_000));
      expect(calls('GET', '/articles/101')).toHaveLength(1);
      await act(() => vi.advanceTimersByTimeAsync(1_500));

      expect(await screen.findByText('Full text saved')).toBeInTheDocument();
      expect(calls('GET', '/articles/101')).toHaveLength(2);

      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(calls('GET', '/articles/101')).toHaveLength(2);
    });
  });
});

describe('ArticleDetail saved copy', () => {
  const SNAPSHOT: BookmarkSnapshot = {
    id: '900',
    sourceUrl: 'https://example.test/original',
    title: 'Solid-state batteries reach the pilot line',
    author: 'Jane Doe',
    publishedAt: '2026-05-30T12:00:00.000Z',
    capturedAt: '2026-06-01T12:00:00.000Z',
    contentRevision: '1',
    completeness: 'complete',
    text: 'First saved line.\n\nSecond saved line.',
    html: '<p>The saved version of the article.</p>',
    mediaPolicyFeedId: '7',
    effectiveImagesAllowed: false,
  };
  const SAVED = makeItem({
    bookmarkedAt: '2026-05-31T09:00:00.000Z',
    contentRevision: '3',
    bookmarkCapture: {
      status: 'saved',
      generation: '2',
      snapshotId: '900',
      capturedAt: '2026-06-01T12:00:00.000Z',
      errorCode: null,
    },
  });

  function renderSaved(
    snapshot: Partial<BookmarkSnapshot> = {},
    item = SAVED,
    routes: Record<string, ApiRouteHandler> = {},
  ) {
    return renderDetail(
      item,
      { saved: true },
      {
        routes: {
          ...detailRoute(item, {
            excerptHtml: '<p>The live version of the article.</p>',
            bookmarkSnapshot: { ...SNAPSHOT, ...snapshot },
          }),
          ...routes,
        },
      },
    );
  }

  it('shows the saved version, when it was saved and a link to the original source', async () => {
    renderSaved();
    expect(await screen.findByText('The saved version of the article.')).toBeInTheDocument();
    expect(screen.queryByText('The live version of the article.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Saved copy' })).toBeInTheDocument();
    expect(screen.getByText('Saved on Jun 1, 2026')).toBeInTheDocument();
    const source = screen.getByRole('link', { name: 'Original source' });
    expect(source).toHaveAttribute('href', 'https://example.test/original');
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has no source link when the source address was lost', async () => {
    renderSaved({ sourceUrl: null });
    await screen.findByText('The saved version of the article.');
    expect(screen.queryByRole('link', { name: 'Original source' })).toBeNull();
  });

  it('shows the saved text as paragraphs when there is no saved markup', async () => {
    renderSaved({ html: null });
    expect(await screen.findByText('First saved line.')).toBeInTheDocument();
    expect(screen.getByText('Second saved line.')).toBeInTheDocument();
  });

  it('follows the image setting of the saved copy', async () => {
    const first = renderSaved({
      html: '<p>Text</p><img src="https://cdn.test/a.png" alt="A cat">',
      effectiveImagesAllowed: false,
    });
    expect(await screen.findByText('A cat')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    first.unmount();

    renderSaved({
      html: '<p>Text</p><img src="https://cdn.test/a.png" alt="A cat">',
      effectiveImagesAllowed: true,
    });
    await screen.findByText('Text');
    expect(document.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/a.png');
  });

  it('fences actions against the saved copy', async () => {
    const { user, calls } = renderSaved({}, SAVED, {
      'POST /articles/:id/rating': () => ratingResponse(acked(SAVED, { rating: 1 })),
      'DELETE /articles/:id/bookmark': () =>
        actionResponse(acked(acked(SAVED, { rating: 1 }), { bookmarkedAt: null })),
    });
    await screen.findByText('The saved version of the article.');

    await user.click(screen.getByRole('button', { name: 'Like' }));
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '1',
      snapshotId: '900',
      rating: 1,
    });

    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(calls('DELETE', '/articles/101/bookmark')).toHaveLength(1));
    expect(Object.fromEntries(calls('DELETE', '/articles/101/bookmark')[0]!.query)).toMatchObject({
      contentRevision: '1',
      snapshotId: '900',
    });
  });

  it('waits for the saved copy before it offers actions', () => {
    renderSaved();
    expect(screen.queryByRole('group', { name: 'Article actions' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });

  it('fences "Read original" and "Retry capture" against the saved copy too', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const partial = makeItem({
      bookmarkedAt: '2026-05-31T09:00:00.000Z',
      contentRevision: '3',
      bookmarkCapture: {
        status: 'partial',
        generation: '2',
        snapshotId: '900',
        capturedAt: '2026-06-01T12:00:00.000Z',
        errorCode: null,
      },
    });
    const { user, calls } = renderSaved({}, partial, {
      'POST /articles/:id/open': () => actionResponse(acked(partial)),
      'POST /articles/:id/bookmark/retry-capture': () =>
        json(202, { item: acked(acked(partial)), mutationId: MUTATION_ID }),
    });
    await screen.findByText('The saved version of the article.');

    await user.click(screen.getByRole('button', { name: 'Read original' }));
    await waitFor(() => expect(calls('POST', '/articles/101/open')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/articles/101/open')[0]!)).toMatchObject({
      contentRevision: '1',
      snapshotId: '900',
    });

    await user.click(screen.getByRole('button', { name: 'Retry capture' }));
    await waitFor(() =>
      expect(calls('POST', '/articles/101/bookmark/retry-capture')).toHaveLength(1),
    );
    expect(bodyOf(calls('POST', '/articles/101/bookmark/retry-capture')[0]!)).toMatchObject({
      contentRevision: '1',
      snapshotId: '900',
      captureGeneration: '2',
    });
  });
});

describe('ArticleDetail image setting', () => {
  const BLOCKED = makeItem({ effectiveImagesAllowed: false, mediaPolicyFeedId: '7' });

  const savePreference: ApiRouteHandler = (request, params) => {
    const { imagePolicy } = bodyOf(request) as { imagePolicy: string };
    return json(200, {
      feedId: params['feedId'],
      imagePolicy,
      effectiveImagesAllowed: imagePolicy === 'allow',
    });
  };

  it.each([
    ['Always show images from this feed', 'allow'],
    ['Always block', 'block'],
    ['Use global setting', 'inherit'],
  ])('"%s" saves the %s policy of the feed and reloads the articles', async (name, imagePolicy) => {
    const { user, calls } = renderDetail(
      BLOCKED,
      {},
      {
        routes: { 'PUT /feed-preferences/:feedId': savePreference },
      },
    );
    expect(await screen.findByText("Images from this feed aren't loaded.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name }));

    await waitFor(() => expect(calls('PUT', '/feed-preferences/7')).toHaveLength(1));
    expect(bodyOf(calls('PUT', '/feed-preferences/7')[0]!)).toEqual({ imagePolicy });
    expect(await findToast('Image setting saved')).toBeInTheDocument();
    await waitFor(() => expect(calls('GET', '/articles/101')).toHaveLength(2));
  });

  it('is not offered while images are allowed', async () => {
    renderDetail(makeItem({ effectiveImagesAllowed: true, mediaPolicyFeedId: '7' }));
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByText("Images from this feed aren't loaded.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always block' })).toBeNull();
  });

  it('is not offered without a feed to remember the setting for', async () => {
    renderDetail(makeItem({ effectiveImagesAllowed: false, mediaPolicyFeedId: null }));
    await screen.findByText('The excerpt of the article.');
    expect(screen.queryByRole('button', { name: 'Always show images from this feed' })).toBeNull();
  });

  it('reports a setting that could not be saved', async () => {
    const { user } = renderDetail(
      BLOCKED,
      {},
      {
        routes: { 'PUT /feed-preferences/:feedId': () => failure(500, 'INTERNAL') },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Always block' }));
    expect(await findToast('Something went wrong on our side. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Always block' })).toBeEnabled();
  });
});

describe('ArticleDetail in Slovak', () => {
  it('speaks Slovak', async () => {
    const item = makeItem({
      url: URL_101,
      effectiveImagesAllowed: false,
      mediaPolicyFeedId: '7',
      bookmarkedAt: '2026-05-30T09:00:00.000Z',
      bookmarkCapture: {
        status: 'partial',
        generation: '3',
        snapshotId: '900',
        capturedAt: '2026-05-30T09:05:00.000Z',
        errorCode: null,
      },
    });
    renderDetail(item, { onWhyThis: vi.fn() }, { language: 'sk' });
    expect(await screen.findByRole('button', { name: 'Čítať originál' })).toBeInTheDocument();
    for (const name of ['Prečo toto?', 'Stlmiť príbeh', 'Viac', 'Štítky', 'Skúsiť uložiť znova']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Uložený je len čiastočný text')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Akcie článku' })).toBeInTheDocument();
  });
});
