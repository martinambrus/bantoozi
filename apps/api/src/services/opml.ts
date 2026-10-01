import {
  ensureFeeds,
  insertSubscriptions,
  quotaUsage,
  readOwnUser,
  recordRankIntents,
  refreshFeedMaterializations,
  resolveFeedUrls,
  subscribedFeedIds,
  type TenantTx,
} from '@bantoozi/db';
import type { OpmlEntry, OpmlImport } from '@bantoozi/feeds';
import {
  MAX_FOLDER_NAME_LENGTH,
  QuotaExceededError,
  planLimits,
  type JobSender,
  type OpmlImportReport,
} from '@bantoozi/shared';

type ParsedOpml = Extract<OpmlImport, { ok: true }>;

/** An OPML folder label as a subscription folder (the API's folder length bound). */
function folderOf(entry: OpmlEntry): string | null {
  const folder = entry.folder?.trim() ?? '';
  return folder === '' ? null : folder.slice(0, MAX_FOLDER_NAME_LENGTH);
}

/**
 * The OPML import transaction (spec 03 §11, spec 08 §4), inside `request.mutate`, for a document
 * `parseOpml` already validated without network access. Under the user-row lock:
 *
 * 1. More valid feeds than `opmlMaxFeeds` → `409 QUOTA_EXCEEDED {limit, used, max}` (`used` is the
 *    number of feeds in the file).
 * 2. Entries whose feed the user already subscribes to are `existing`: they keep their inference
 *    mode and folder and use no quota.
 * 3. New feeds are added in document order up to the remaining `maxFeeds` quota; the rest are
 *    reported as `quota_exceeded`, never silently dropped.
 * 4. Feed rows are created or reused without a fetch (due now), subscriptions start `off`, and both
 *    refresh functions run once for all added feeds; a full rank intent follows. No inference, card
 *    backfill or provider demand is created.
 */
export async function importOpml(
  tx: TenantTx,
  outbox: JobSender,
  parsed: ParsedOpml,
): Promise<OpmlImportReport> {
  const user = await readOwnUser(tx, { lock: true });
  const limits = planLimits(user.plan);
  if (parsed.entries.length > limits.opmlMaxFeeds) {
    throw new QuotaExceededError('opmlMaxFeeds', parsed.entries.length, limits.opmlMaxFeeds);
  }
  const invalid: OpmlImportReport['invalid'] = parsed.invalid.map((entry) => ({
    index: entry.index,
    url: entry.url,
    reason: entry.reason,
  }));

  // Which entries name a feed the user already holds (a merged identity resolves to its survivor).
  const known = await resolveFeedUrls(
    tx,
    parsed.entries.map((entry) => entry.canonicalUrl),
  );
  const subscribed = await subscribedFeedIds(tx, [...new Set(known.values())]);
  let existing = 0;
  const fresh: OpmlEntry[] = [];
  const freshFeeds = new Set<string>();
  for (const entry of parsed.entries) {
    const feedId = known.get(entry.canonicalUrl);
    if (feedId !== undefined && subscribed.has(feedId)) {
      existing += 1;
    } else if (feedId === undefined || !freshFeeds.has(feedId)) {
      if (feedId !== undefined) freshFeeds.add(feedId);
      fresh.push(entry);
    } else {
      existing += 1; // two URLs of one (merged) feed: the first adds it
    }
  }

  const room = Math.max(0, limits.maxFeeds - (await quotaUsage(tx)).maxFeeds);
  const admitted = fresh.slice(0, room);
  for (const entry of fresh.slice(room)) {
    invalid.push({ index: entry.index, url: entry.url, reason: 'quota_exceeded' });
  }

  const live = await ensureFeeds(
    tx,
    admitted.map((entry) => ({ url: entry.canonicalUrl, fetchUrl: entry.url, title: entry.title })),
  );
  const rows = new Map<string, string | null>();
  for (const entry of admitted) {
    const feedId = live.get(entry.canonicalUrl);
    if (feedId !== undefined && !rows.has(feedId)) rows.set(feedId, folderOf(entry));
  }
  const added = await insertSubscriptions(
    tx,
    [...rows].map(([feedId, folder]) => ({ feedId, folder })),
  );
  if (added.length > 0) {
    await refreshFeedMaterializations(tx, added);
    await recordRankIntents(tx, outbox, [user.id], { reason: 'opml_import', full: true });
  }
  invalid.sort((a, b) => a.index - b.index);
  return { added: added.length, existing: existing + (admitted.length - added.length), invalid };
}
