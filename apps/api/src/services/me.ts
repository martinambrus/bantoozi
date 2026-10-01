import { once } from 'node:events';
import type { Writable } from 'node:stream';

import {
  exportBookmarksPage,
  exportRatings,
  exportRules,
  listFeedPreferences,
  listOpmlRows,
  listSubscriptions,
  listUserCards,
  listUserLabels,
  lockFeeds,
  quotaUsage,
  readOwnUser,
  recordRankIntents,
  refreshFeedMaterializations,
  revokeUserSessions,
  softDeleteOwnUser,
  subscriptionFeedIds,
  updateOwnUser,
  type ExportBookmark,
  type TenantTx,
} from '@bantoozi/db';
import { exportOpml } from '@bantoozi/feeds';
import {
  EXPORT_SCHEMA_VERSION,
  QUOTA_LIMIT_NAMES,
  RANKING_RELEVANT_PREFERENCES,
  effectiveImagesAllowed,
  enqueueLearn,
  mergeUserPreferences,
  planLimits,
  readUserPreferences,
  type JobSender,
  type Me,
  type MeExport,
  type MePatch,
  type QuotaLimits,
  type UserPreferences,
} from '@bantoozi/shared';

/** The `Me` DTO (spec 08 §3) of the transaction's tenant: user row, preferences and quotas. */
export async function loadMe(tx: TenantTx): Promise<Me> {
  const user = await readOwnUser(tx);
  const used = await quotaUsage(tx);
  const plan = planLimits(user.plan);
  const limits = Object.fromEntries(
    QUOTA_LIMIT_NAMES.map((name) => [name, plan[name]]),
  ) as QuotaLimits;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale,
    timezone: user.timezone,
    role: user.role,
    plan: user.plan,
    invitesLeft: user.invitesLeft,
    preferences: readUserPreferences(user.preferences),
    quotas: { used, limits },
  };
}

/** Behavioral-consent preferences (spec 06 §8.2): a change invalidates models that used them. */
export const CONSENT_PREFERENCES = ['implicitFeedback', 'implicitNegative'] as const;

/** The preference keys whose value differs between two complete preference objects. */
export function changedPreferenceKeys(
  before: UserPreferences,
  after: UserPreferences,
): (keyof UserPreferences)[] {
  return (Object.keys(after) as (keyof UserPreferences)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/**
 * `PATCH /me` (spec 08 §3, §1.1) inside `request.mutate`: under the user-row lock, deep-merge the
 * supplied preference leaves (arrays replaced), update only the supplied columns, then record the
 * invalidations the change implies in the same transaction:
 * - a ranking-relevant preference (spec 06 §7: `demote`, `implicitFeedback`, `implicitNegative`)
 *   advances `rank_revision` and records `user.rank {full: true}`;
 * - a behavioral-consent change (spec 06 §8.2, §8.4) also records `user.learn`, whose handler
 *   detects the model-context mismatch, stops the incompatible model and retrains from the
 *   remaining eligible evidence (the API has no write access to `user_models`).
 */
export async function applyMePatch(tx: TenantTx, outbox: JobSender, patch: MePatch): Promise<Me> {
  const user = await readOwnUser(tx, { lock: true });
  let preferences: UserPreferences | undefined;
  let changed: (keyof UserPreferences)[] = [];
  if (patch.preferences !== undefined) {
    const before = readUserPreferences(user.preferences);
    preferences = mergeUserPreferences(before, patch.preferences);
    changed = changedPreferenceKeys(before, preferences);
  }
  await updateOwnUser(tx, {
    ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
    ...(preferences === undefined ? {} : { preferences }),
  });
  const ranking = changed.some((key) =>
    (RANKING_RELEVANT_PREFERENCES as readonly string[]).includes(key),
  );
  if (ranking) {
    await recordRankIntents(tx, outbox, [user.id], { reason: 'preferences', full: true });
  }
  if (changed.some((key) => (CONSENT_PREFERENCES as readonly string[]).includes(key))) {
    await enqueueLearn(outbox, { userId: user.id });
  }
  return loadMe(tx);
}

/**
 * `DELETE /me` (spec 08 §3) inside `request.mutate`: lock the user row, then the user's feeds in id
 * order; set `deleted_at`, revoke every session, and refresh both feed materializations so the
 * soft-deleted user no longer counts as a subscriber or card holder. A verified login within 7 days
 * restores the account (spec 08 §2.1); `house.purge-users` hard-deletes after that.
 */
export async function softDeleteAccount(tx: TenantTx): Promise<void> {
  const user = await readOwnUser(tx, { lock: true });
  const feedIds = await subscriptionFeedIds(tx);
  await lockFeeds(tx, feedIds);
  await softDeleteOwnUser(tx);
  await revokeUserSessions(tx, user.id);
  await refreshFeedMaterializations(tx, feedIds);
}

/** Bookmarks read per page of the export (each may carry up to 10 MiB of retained text). */
const EXPORT_BOOKMARK_PAGE = 20;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function exportBookmark(
  bookmark: ExportBookmark,
  loadRemoteImages: boolean,
): MeExport['bookmarks'][number] {
  const allowed = effectiveImagesAllowed(bookmark.originImagePolicy, loadRemoteImages);
  return {
    url: bookmark.url,
    title: bookmark.title,
    bookmarkedAt: bookmark.bookmarkedAt.toISOString(),
    capture: {
      status: bookmark.capture.status,
      generation: bookmark.capture.generation,
      snapshotId: bookmark.capture.snapshotId,
      capturedAt: iso(bookmark.capture.capturedAt),
      errorCode: bookmark.capture.errorCode,
    },
    snapshot:
      bookmark.snapshot === null
        ? null
        : {
            id: bookmark.snapshot.id,
            sourceUrl: bookmark.snapshot.sourceUrl,
            title: bookmark.snapshot.title,
            author: bookmark.snapshot.author,
            publishedAt: iso(bookmark.snapshot.publishedAt),
            capturedAt: bookmark.snapshot.capturedAt.toISOString(),
            contentRevision: bookmark.snapshot.contentRevision,
            completeness: bookmark.snapshot.completeness,
            text: bookmark.snapshot.text,
            html: bookmark.snapshot.html,
            mediaPolicyFeedId: bookmark.originFeedId,
            effectiveImagesAllowed: allowed,
          },
  };
}

/** Write to `sink`, waiting for it to drain; an aborted export stops at once. */
async function write(sink: Writable, chunk: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!sink.write(chunk)) await once(sink, 'drain', { signal });
}

/**
 * Stream `GET /me/export` (spec 08 §3) into `sink` from one consistent read-only snapshot (the
 * caller runs this in a REPEATABLE READ, READ ONLY tenant transaction): `schemaVersion 2` with the
 * user's profile and preferences, subscriptions, remembered feed preferences, the OPML document,
 * held cards and labels, rules, ratings, and every bookmark with its capture state and full
 * retained snapshot text/HTML, read page by page so memory stays bounded. Only the tenant's own
 * rows are read, and no session, code, token or provider secret is part of any section. `signal`
 * cancels the export (client disconnect): the transaction then rolls back.
 */
export async function writeExport(
  tx: TenantTx,
  sink: Writable,
  input: { exportedAt: Date; signal: AbortSignal },
): Promise<void> {
  const { signal } = input;
  const user = await readOwnUser(tx);
  const preferences = readUserPreferences(user.preferences);
  const subscriptions = await listSubscriptions(tx);
  const head: Omit<MeExport, 'bookmarks'> = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      timezone: user.timezone,
      role: user.role,
      plan: user.plan,
      createdAt: user.createdAt.toISOString(),
      preferences,
    },
    subscriptions: subscriptions.map((row) => ({
      feedId: row.feed.id,
      url: row.feed.url,
      siteUrl: row.feed.siteUrl,
      title: row.feed.title,
      titleOverride: row.titleOverride,
      folder: row.folder,
      allowDuplicates: row.allowDuplicates,
      hidden: row.hidden,
      inferenceMode: row.inferenceMode,
      imagePolicy: row.imagePolicy,
      createdAt: row.createdAt.toISOString(),
    })),
    feedPreferences: (await listFeedPreferences(tx)).map((row) => ({
      feedId: row.feedId,
      imagePolicy: row.imagePolicy,
    })),
    opml: exportOpml(await listOpmlRows(tx)),
    cards: (await listUserCards(tx)).map((card) => ({
      id: card.id,
      title: card.title,
      titleOverride: card.titleOverride,
      strength: card.strength,
      scopeFeedId: card.scopeFeedId,
      interest: card.interest,
      notFor: card.notFor,
      examplesYes: card.examplesYes,
      examplesNo: card.examplesNo,
      lang: card.lang,
      visibility: card.visibility,
      createdAt: card.createdAt.toISOString(),
    })),
    labels: (await listUserLabels(tx)).map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      definition: label.definition,
      notFor: label.notFor,
      examplesYes: label.examplesYes,
      examplesNo: label.examplesNo,
      createdAt: label.createdAt.toISOString(),
    })),
    rules: (await exportRules(tx)).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      value: rule.value,
      createdAt: rule.createdAt.toISOString(),
      expiresAt: iso(rule.expiresAt),
    })),
    ratings: (await exportRatings(tx)).map((rating) => ({
      url: rating.url,
      title: rating.title,
      rating: rating.rating,
      reason: rating.reason,
      ratedAt: rating.ratedAt.toISOString(),
    })),
  };
  const opening = JSON.stringify(head);
  await write(sink, `${opening.slice(0, -1)},"bookmarks":[`, signal);
  let after: { cursorAt: string; articleId: string } | null = null;
  let first = true;
  for (;;) {
    signal.throwIfAborted();
    const page = await exportBookmarksPage(tx, { after, limit: EXPORT_BOOKMARK_PAGE });
    for (const bookmark of page) {
      const json = JSON.stringify(exportBookmark(bookmark, preferences.loadRemoteImages));
      await write(sink, first ? json : `,${json}`, signal);
      first = false;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < EXPORT_BOOKMARK_PAGE) break;
    after = { cursorAt: last.cursorAt, articleId: last.articleId };
  }
  await write(sink, ']}', signal);
}
