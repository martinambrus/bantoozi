import type { FeedInfo, Subscription } from '@bantoozi/shared';

export interface FolderGroup {
  /** `null` for the feeds without a folder. */
  name: string | null;
  feeds: Subscription[];
}

/** The feed's own title, or its address when it has none. */
export function feedTitle(feed: Pick<FeedInfo, 'title' | 'url'>): string {
  const title = feed.title?.trim();
  return title === undefined || title === '' ? feed.url : title;
}

/** The title the reader chose for the feed, else the feed's own. */
export function displayTitle(subscription: Pick<Subscription, 'titleOverride' | 'feed'>): string {
  const override = subscription.titleOverride?.trim();
  return override === undefined || override === '' ? feedTitle(subscription.feed) : override;
}

function collate(language: string): (a: string, b: string) => number {
  const collator = new Intl.Collator(language);
  return (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The feeds by folder, in the order they are shown: the folders of the saved order that still
 * have feeds, then the other folders alphabetically, then the feeds without a folder. The feeds of
 * a group are sorted by the title they are shown with.
 */
export function groupByFolder(
  subscriptions: readonly Subscription[],
  folderOrder: readonly string[],
  language: string,
): FolderGroup[] {
  const compare = collate(language);
  const byFolder = new Map<string | null, Subscription[]>();
  for (const subscription of subscriptions) {
    const feeds = byFolder.get(subscription.folder);
    if (feeds === undefined) byFolder.set(subscription.folder, [subscription]);
    else feeds.push(subscription);
  }

  const saved = [...new Set(folderOrder)].filter((name) => byFolder.has(name));
  const others = [...byFolder.keys()]
    .filter((name): name is string => name !== null && !saved.includes(name))
    .sort(compare);

  return [...saved, ...others, null].flatMap((name) => {
    const feeds = byFolder.get(name);
    if (feeds === undefined) return [];
    feeds.sort((a, b) => compare(displayTitle(a), displayTitle(b)));
    return [{ name, feeds }];
  });
}

/** `order` with `from` moved to the place `to` has in it. */
export function moveFolderTo(order: readonly string[], from: string, to: string): string[] {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [...order];
  const next = order.filter((_name, index) => index !== fromIndex);
  next.splice(toIndex, 0, from);
  return next;
}

/** `order` with `name` moved one place up (-1) or down (1). */
export function moveFolderBy(order: readonly string[], name: string, step: -1 | 1): string[] {
  const index = order.indexOf(name);
  const neighbour = index < 0 ? undefined : order[index + step];
  return neighbour === undefined ? [...order] : moveFolderTo(order, name, neighbour);
}
