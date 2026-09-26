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
 * partial snapshot, and a partial page replaces the stored partial content (a body of this
 * revision, else the feed excerpt) only when it has more readable text, so a paywall teaser never
 * displaces a longer feed body; no readable content keeps the bookmark as `failed`. A transient
 * page failure
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

/** Snapshot content before it is frozen with the source's metadata. */
interface Content {
  text: string;
  html: string | null;
  completeness: 'complete' | 'partial';
  reason: string | null;
  source: 'feed' | 'page';
  extractor: string;
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
  const stored = storedContent(source, current);
  if (source.url !== null) {
    const result = await extractArticle(source.url, extractDeps(deps), {
      enclosureType: source.linkEnclosureType,
    });
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
      // A partial page is the best available content only when it improves on the stored
      // partial content: a paywall teaser never displaces a longer feed body (spec 03 §8.5 step 4).
      const page = result.bodyText;
      if (result.completeness === 'complete' || stored === null || moreText(page, stored.text)) {
        return captured(source, {
          text: page,
          html: result.bodyHtml,
          completeness: result.completeness,
          reason: result.completenessReason,
          source: 'page',
          extractor: EXTRACTOR_VERSION,
        });
      }
    }
  }
  return stored === null ? { status: 'failed', errorCode: 'no_content' } : captured(source, stored);
}

/** The best stored partial content: a body of this revision with text, then the feed excerpt. */
function storedContent(source: CaptureSource, current: CaptureSource['body']): Content | null {
  if (current !== null && current.bodyText !== null) {
    return {
      text: current.bodyText,
      html: current.bodyHtml,
      completeness: 'partial',
      reason: current.completenessReason ?? 'extraction_failed',
      source: current.extractorVersion === 'feed-v1' ? 'feed' : 'page',
      extractor: current.extractorVersion,
    };
  }
  if (source.excerpt !== null && source.excerpt.trim() !== '') {
    return {
      text: source.excerpt,
      html: source.excerptHtml,
      completeness: 'partial',
      reason: 'excerpt_only',
      source: 'feed',
      extractor: 'feed',
    };
  }
  return null;
}

/** Whether `text` has more readable text than `than`, ignoring surrounding whitespace. */
function moreText(text: string, than: string): boolean {
  return text.trim().length > than.trim().length;
}

function captured(source: CaptureSource, content: Content): CaptureOutcome {
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
