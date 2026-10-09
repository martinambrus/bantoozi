import type { ArticleListItem } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';

import { json } from '../api/fake-fetch.js';
import { makeSubscription } from '../feeds/support.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { acked } from './actions/fake-transport.js';
import { AS_OF, item, type createReaderHarness } from './support.js';

type Opened = Awaited<ReturnType<ReturnType<typeof createReaderHarness>['open']>>['app'];

export const VERGE = makeSubscription({ feed: { id: '7', title: 'Verge' } });

/** A receipt as the API issues them, numbered so that a test can tell which one an undo names. */
export const receipt = (n: number) => `5b0f1a54-2d1c-4a53-9d7e-${String(n).padStart(12, '0')}`;

interface Targets {
  targets: { id: string }[];
  rating: 1 | -1 | null;
}

/**
 * The writes of the reader, each answered with its own receipt. `issued` lists the receipts in the
 * order the fake API handed them out.
 */
export function writeRoutes() {
  const issued: string[] = [];
  const next = () => {
    const id = receipt(issued.length + 1);
    issued.push(id);
    return id;
  };
  const idOf = (params: Record<string, string>) => params['id'] ?? '';
  const routes: Record<string, ApiRouteHandler> = {
    'POST /articles/:id/rating': (request, params) => {
      const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
      return json(200, {
        item: acked(item(idOf(params)), { rating, readAt: AS_OF }),
        mutationId: next(),
        exampleSuggestion: null,
      });
    },
    'POST /articles/:id/bookmark': (_request, params) =>
      json(200, {
        item: acked(item(idOf(params)), { bookmarkedAt: AS_OF }),
        mutationId: next(),
      }),
    'POST /articles/rate-bulk': (request) => {
      const { targets, rating } = bodyOf(request) as Targets;
      return json(200, {
        count: targets.length,
        mutationId: next(),
        items: targets.map((target) => acked(item(target.id), { rating, readAt: AS_OF })),
      });
    },
  };
  return { routes, issued };
}

/** `POST /articles/undo` answering with these restored articles. */
export function undoRoute(...restored: ArticleListItem[]): Record<string, ApiRouteHandler> {
  return {
    'POST /articles/undo': () =>
      json(200, {
        count: restored.length,
        mutationId: receipt(900),
        items: restored,
      }),
  };
}

/** The header of the view called `title`: its group is named after the heading. */
export const headerOf = (title: string) => screen.findByRole('group', { name: title });

/** Opens the More menu of the header of the view called `title`. */
export async function openMore(app: Opened, title: string, more = 'More') {
  const header = await headerOf(title);
  await app.user.click(within(header).getByRole('button', { name: more }));
}

/** The Like button of the row called `title`. */
export const likeOf = (title: string) =>
  within(screen.getByRole('article', { name: title })).getByRole('button', { name: 'Like' });

/** The Bookmark button of the row called `title`. */
export const bookmarkOf = (title: string) =>
  within(screen.getByRole('article', { name: title })).getByRole('button', { name: 'Bookmark' });
