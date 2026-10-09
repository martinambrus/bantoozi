import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen } from '@testing-library/react';
import { vi } from 'vitest';

import type { Language } from '../../src/i18n/index.js';
import { json } from '../api/fake-fetch.js';
import { actionResponse, makeRule, ratingResponse } from '../article/harness.js';
import { createHarness } from '../auth/harness.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { acked } from './actions/fake-transport.js';
import { AS_OF, item, readerServer, type ReaderOptions } from './support.js';

export const READ = 'POST /articles/:id/read';
export const UNREAD = 'POST /articles/:id/unread';
export const OPEN = 'POST /articles/:id/open';
export const DWELL = 'POST /articles/:id/dwell';
export const RATE = 'POST /articles/:id/rating';
export const BOOKMARK = 'POST /articles/:id/bookmark';
export const UNBOOKMARK = 'DELETE /articles/:id/bookmark';
export const LABEL = 'POST /articles/:id/labels';
export const MUTE = 'POST /articles/:id/mute-story';
export const UPDATE_ME = 'PATCH /me';

export const ROWS = [item(1), item(2), item(3)];

/** The title button of the row of "Article n"; it holds the focus and says whether the row is open. */
export const title = (n: number) => screen.getByRole('button', { name: `Article ${n}` });

/** The pane beside the list that shows the expanded article. */
export const pane = () => screen.getByRole('complementary', { name: 'Article' });

/**
 * The writes of the reader, answered like the API: each article keeps what was written to it, so
 * its state version goes up with every request.
 */
export function writes(): Record<string, ApiRouteHandler> {
  const held = new Map<string, ArticleListItem>();
  const baseOf = (id: string | undefined) => held.get(id ?? '') ?? item(id ?? '0');
  const apply = (id: string | undefined, patch: Partial<ArticleListItem>) => {
    const next = acked(baseOf(id), patch);
    held.set(next.id, next);
    return next;
  };
  return {
    [READ]: (_request, params) => actionResponse(apply(params['id'], { readAt: AS_OF })),
    [UNREAD]: (_request, params) => actionResponse(apply(params['id'], { readAt: null })),
    [OPEN]: (_request, params) => actionResponse(apply(params['id'], { readAt: AS_OF })),
    [DWELL]: (_request, params) => actionResponse(apply(params['id'], {}), { prompt: false }),
    [RATE]: (request, params) => {
      const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
      return ratingResponse(apply(params['id'], { rating, readAt: AS_OF }));
    },
    [BOOKMARK]: (_request, params) => actionResponse(apply(params['id'], { bookmarkedAt: AS_OF })),
    [UNBOOKMARK]: (_request, params) => actionResponse(apply(params['id'], { bookmarkedAt: null })),
    [LABEL]: (request, params) => {
      const { labelId } = bodyOf(request) as { labelId: string };
      return actionResponse(
        apply(params['id'], { labelIds: [...baseOf(params['id']).labelIds, labelId] }),
      );
    },
    [MUTE]: () => json(201, { rule: makeRule('55', 'mute_story', '9') }),
  };
}

/** Makes `(min-width: 1024px)` match or not, and lets a test change it and tell the page. */
export function controllableScreen(desktop: boolean) {
  let wide = desktop;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        get matches() {
          return wide && /min-width:\s*1024px/.test(query);
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.delete(listener);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
  return {
    setDesktop(next: boolean) {
      wide = next;
      act(() => {
        for (const listener of [...listeners]) {
          const change = new Event('change');
          if (typeof listener === 'function') listener(change);
          else listener.handleEvent(change);
        }
      });
    },
  };
}

export interface KeysOptions extends ReaderOptions {
  language?: Language;
}

/**
 * Boots the app on a reader route against `readerServer` and `writes`, like `createReaderHarness`,
 * with the language and the width of the screen under the test's control. Call it once per file.
 */
export function createKeysHarness() {
  const harness = createHarness();
  return {
    async open(options: KeysOptions) {
      const { language, routes, ...rest } = options;
      // `routes` replaces any of the writes it names.
      const { server, state } = readerServer({ ...rest, routes: { ...writes(), ...routes } });
      const wide = controllableScreen(options.desktop ?? true);
      const app = await harness.open({
        path: options.path,
        server,
        ...(language === undefined ? {} : { language }),
      });
      return { app, state, server, setDesktop: wide.setDesktop };
    },
  };
}
