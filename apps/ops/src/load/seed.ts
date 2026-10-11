import { ApiClient } from './api.js';
import { LOAD_CARDS_PER_USER, LOAD_USERS, loadFeedUrl, userFeedIndexes } from './config.js';

/** Seeds the simulated users through the real API: sign-up, 50 subscriptions, 10 library cards. */

export interface SeededUser {
  index: number;
  email: string;
  client: ApiClient;
  /** Feed ids (database ids) in subscription order. */
  feedIds: string[];
}

interface SubscriptionEnvelope {
  subscription: { feed: { id: string }; inferenceVersion: string; inferenceMode: string };
}
interface LibraryPage {
  items: { id: string; lang: string }[];
  nextCursor: string | null;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Library card ids (English first), enough for every user to hold different overlapping sets. */
async function libraryCards(client: ApiClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/api/v1/library?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page: LibraryPage = await client.expect<LibraryPage>('GET', query);
    for (const item of page.items) ids.push(item.id);
    cursor = page.nextCursor;
  } while (cursor !== null && ids.length < 400);
  return ids;
}

/** Cards of user `user`: ten consecutive library cards from `user × 4`, so neighbours share six. */
export function userCardIndexes(user: number, available: number): number[] {
  return Array.from({ length: LOAD_CARDS_PER_USER }, (_, k) => (user * 4 + k) % available);
}

export async function seedUsers(
  base: string,
  log: (message: string) => void,
): Promise<SeededUser[]> {
  const users: SeededUser[] = [];
  for (let index = 0; index < LOAD_USERS; index += 1) {
    // Sequential: the test mail endpoint shows only the last mail.
    const client = new ApiClient(base);
    const email = `load-user-${index}@example.com`;
    await client.login(email);
    users.push({ index, email, client, feedIds: [] });
  }
  log(`${users.length} users signed in`);

  const first = users[0];
  if (first === undefined) return users;
  const library = await libraryCards(first.client);
  if (library.length < LOAD_CARDS_PER_USER)
    throw new Error(`the library has only ${library.length} cards`);

  await mapLimit(users, 3, async (user) => {
    const indexes = userFeedIndexes(user.index);
    const ids = await mapLimit(indexes, 3, async (feed) => {
      const result = await user.client.expect<SubscriptionEnvelope>(
        'POST',
        '/api/v1/subscriptions',
        { url: loadFeedUrl(feed) },
        [200, 201],
      );
      if (!('subscription' in result))
        throw new Error(`subscribing to feed ${feed} offered a choice`);
      return result.subscription.feed.id;
    });
    user.feedIds = ids;
    for (const cardIndex of userCardIndexes(user.index, library.length)) {
      await user.client.expect('POST', `/api/v1/library/${library[cardIndex] as string}/adopt`, {
        strength: cardIndex % 3 === 0 ? 'love' : 'like',
      });
    }
    log(`user ${user.index}: ${ids.length} feeds, ${LOAD_CARDS_PER_USER} cards`);
  });
  return users;
}
