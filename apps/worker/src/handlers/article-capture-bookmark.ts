import {
  completeBookmarkCapture,
  loadCaptureSource,
  retryTransaction,
  workerOutbox,
  type CaptureOutcome,
  type CaptureSource,
  type CapturedContent,
} from '@bantoozi/db';
import { EXTRACTOR_VERSION, extractArticle } from '@bantoozi/feeds';
import { enqueueCaptureBookmark } from '@bantoozi/shared';

import { extractDeps, type WorkerDeps } from './deps.js';
import type { JobContext, QueueHandler } from './index.js';
import { hasRetriesLeft, isTransientPageFailure, TransientPageError } from './transient.js';

/**
 * `article.capture-bookmark {articleId}` (spec 03 §8.5): retain the full available readable text
 * and sanitized HTML for the article's pending bookmark generations. Prefers a stored complete body
 * of the current revision; otherwise runs the same safe local extraction as `article.extract`
 * (robots, SSRF, size, timeout and politeness limits), once for all coalesced requests, and never
 * creates model demand. The best available content is frozen: a teaser or feed summary stays a
 * partial snapshot; no readable content keeps the bookmark as `failed`. A transient page failure
 * throws while the queue has retries left (bounded automatic retries, spec 03 §8.5 step 3), so the
 * capture stays pending until the last attempt. Completion binds only the still-pending
 * generations at the observed revision; a changed revision retries from the current source
 * instead of mislabeling stale input.
 */
export function createCaptureBookmarkHandler(
  deps: WorkerDeps,
): QueueHandler<'article.capture-bookmark'> {
  return async ({ articleId }, context) => {
    const source = await loadCaptureSource(deps.db, articleId);
    if (source === null || source.pending.length === 0) return;

    const outcome = await capture(deps, source, context);
    if (outcome === 'deferred') return;
    const done = await retryTransaction(deps.db, (tx) =>
      completeBookmarkCapture(tx, {
        articleId,
        observedRevision: source.revision,
        generations: source.pending,
        outcome,
      }),
    );
    if (done.revisionChanged) {
      await deps.db.transaction((tx) => enqueueCaptureBookmark(workerOutbox(tx), { articleId }));
    }
  };
}

async function capture(
  deps: WorkerDeps,
  source: CaptureSource,
  context: JobContext,
): Promise<CaptureOutcome | 'deferred'> {
  const body = source.body;
  const current = body !== null && body.articleRevision === source.revision ? body : null;
  if (current !== null && current.status === 'ok' && current.bodyText !== null) {
    if (current.completeness === 'complete' || source.url === null) {
      return captured(source, {
        text: current.bodyText,
        html: current.bodyHtml,
        completeness: current.completeness,
        reason: current.completenessReason,
        source: current.extractorVersion === 'feed-v1' ? 'feed' : 'page',
        extractor: current.extractorVersion,
      });
    }
  }
  if (source.url !== null) {
    const result = await extractArticle(source.url, extractDeps(deps));
    if (isTransientPageFailure(result) && hasRetriesLeft(context)) {
      throw new TransientPageError(result.error ?? 'unknown');
    }
    if (result.deferUntil !== null) {
      const until = result.deferUntil;
      await deps.db.transaction((tx) =>
        enqueueCaptureBookmark(
          workerOutbox(tx, { availableAt: until }),
          { articleId: source.articleId },
          { revision: source.revision },
        ),
      );
      return 'deferred';
    }
    if (result.status === 'ok' && result.bodyText !== null) {
      return captured(source, {
        text: result.bodyText,
        html: result.bodyHtml,
        completeness: result.completeness,
        reason: result.completenessReason,
        source: 'page',
        extractor: EXTRACTOR_VERSION,
      });
    }
  }
  // The best stored content: a partial body of this revision, then the feed excerpt.
  if (current !== null && current.bodyText !== null) {
    return captured(source, {
      text: current.bodyText,
      html: current.bodyHtml,
      completeness: 'partial',
      reason: current.completenessReason ?? 'extraction_failed',
      source: current.extractorVersion === 'feed-v1' ? 'feed' : 'page',
      extractor: current.extractorVersion,
    });
  }
  if (source.excerpt !== null && source.excerpt.trim() !== '') {
    return captured(source, {
      text: source.excerpt,
      html: source.excerptHtml,
      completeness: 'partial',
      reason: 'excerpt_only',
      source: 'feed',
      extractor: 'feed',
    });
  }
  return { status: 'failed', errorCode: 'no_content' };
}

function captured(
  source: CaptureSource,
  content: {
    text: string;
    html: string | null;
    completeness: 'complete' | 'partial';
    reason: string | null;
    source: 'feed' | 'page';
    extractor: string;
  },
): CaptureOutcome {
  const frozen: CapturedContent = {
    sourceRevision: source.revision,
    sourceUrl: source.url,
    title: source.title,
    author: source.author,
    publishedAt: source.publishedAt,
    bodyText: content.text,
    bodyHtml: content.html,
    completeness: content.completeness,
    completenessReason: content.reason,
    source: content.source,
    extractorVersion: content.extractor,
  };
  return { status: 'captured', content: frozen };
}
