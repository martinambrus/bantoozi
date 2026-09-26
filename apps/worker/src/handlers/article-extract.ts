import {
  addArticleAlias,
  loadArticleForExtraction,
  mergeArticles,
  retryTransaction,
  saveExtractionResult,
  workerOutbox,
  type ArticleBodyInput,
  type ArticleForExtraction,
  type ExtractionMediaSignals,
  type Transaction,
} from '@bantoozi/db';
import {
  EXTRACTOR_VERSION,
  bodyLead,
  canonicalizeUrl,
  countWords,
  extractArticle,
  urlKey,
  type ExtractResult,
} from '@bantoozi/feeds';
import { enqueueExtract, type JobSender } from '@bantoozi/shared';
import { detectLanguage } from '@bantoozi/shared/server';

import { after, afterNewCarrier } from '../pipeline.js';
import { extractDeps, pipelineContext, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';
import { hasRetriesLeft, isTransientPageFailure, TransientPageError } from './transient.js';

/**
 * `article.extract {articleId}` (spec 03 §8.1). Re-reads the article: a missing (merged or purged)
 * article, one no longer awaiting extraction for its revision, or a stale one is a successful
 * no-op. Linked articles are fetched through the safe client under robots and the origin limiter;
 * linkless ones use their feed text. A redirect or same-site `rel=canonical` adds an alias, or
 * merges into the article that already owns that URL. Every terminal status (skipped, blocked,
 * not_html, failed, …) stores its body row, detects the language on the available text and
 * advances through `pipeline.after('extract')` in the same transaction; an origin cooldown defers
 * the job with a delayed outbox intent instead of failing it (spec 03 §8.2), and a transient page
 * failure throws while the queue has retries left, so only the last attempt stores it.
 */
export function createArticleExtractHandler(deps: WorkerDeps): QueueHandler<'article.extract'> {
  return async ({ articleId }, context) => {
    const article = await loadArticleForExtraction(deps.db, articleId);
    if (article === null || article.pipelineState !== 'ingested') return;

    const result =
      article.url === null ? null : await extractArticle(article.url, extractDeps(deps));
    if (result !== null && isTransientPageFailure(result) && hasRetriesLeft(context)) {
      throw new TransientPageError(result.error ?? 'unknown');
    }
    if (result?.deferUntil) {
      const until = result.deferUntil;
      await deps.db.transaction((tx) =>
        enqueueExtract(
          workerOutbox(tx, { availableAt: until }),
          { articleId },
          { revision: article.revision },
        ),
      );
      return;
    }

    await retryTransaction(deps.db, async (tx) => {
      const sender = workerOutbox(tx);
      // A merge ends this article's job; so does a revision replaced while the page was fetched,
      // whose evidence is dropped like its result (the new revision has its own extraction job).
      if (
        result !== null &&
        (await applyIdentityEvidence(deps, tx, sender, article, result)) !== 'kept'
      ) {
        return;
      }
      const body = bodyInput(article, result);
      const text = body.bodyText;
      // A result without text keeps the stored body (feed text or an earlier extraction), which
      // then stays the article's text for language detection (spec 03 §8.1 step 8).
      const lead = body.bodyLead ?? article.body?.bodyLead ?? '';
      const lang = detectLanguage(
        `${article.title} ${article.excerpt ?? ''} ${lead.slice(0, 1000)}`,
        article.carrierLangHints[0] === undefined ? {} : { hint: article.carrierLangHints[0] },
      );
      const saved = await saveExtractionResult(tx, sender, {
        articleId,
        expectedRevision: article.revision,
        body,
        lang: { lang: lang.lang, confidence: lang.confidence },
        wordCount: countWords(text ?? article.excerpt ?? ''),
        media: extractionMedia(result),
      });
      if (saved.status === 'saved' && saved.advanced) {
        await after(
          'extract',
          articleId,
          { status: body.status === 'ok' ? 'ok' : 'failed', revision: saved.revision },
          pipelineContext(deps, tx, sender),
        );
      }
    });
  };
}

/**
 * Alias and merge by redirect and by same-site `rel=canonical` (spec 03 §8.1 steps 4–5), in that
 * order: a new key becomes an alias of the current article; a key another article owns merges the
 * current article into it (the owner survives). The remaining evidence then applies to that
 * survivor, because the fetched page is the survivor's page too and the survivor's own extraction
 * may be long done: a redirect to one article whose page names another as canonical merges all
 * three. The page belongs to the revision this job loaded, so every alias check of the article
 * itself fences on it (spec 03 §2.1): a newer revision is `stale` and nothing is written. `merged`
 * means this article no longer exists; the last survivor then continues from its own state, and
 * the carriers new to it get the new-carrier continuation. Otherwise the article is `kept`.
 */
async function applyIdentityEvidence(
  deps: WorkerDeps,
  tx: Transaction,
  sender: JobSender,
  article: ArticleForExtraction,
  result: ExtractResult,
): Promise<'kept' | 'merged' | 'stale'> {
  const evidence: Array<{ url: string | null; source: 'redirect' | 'rel_canonical' }> = [
    { url: result.resolvedUrl, source: 'redirect' },
    { url: result.canonicalUrl, source: 'rel_canonical' },
  ];
  let current: Pick<ArticleForExtraction, 'id' | 'urlKey'> = article;
  // The feeds new to the current survivor: a later merge moves them on, reporting those it adds.
  let newCarrierFeedIds: readonly string[] = [];
  for (const { url, source } of evidence) {
    if (url === null) continue;
    const canonical = canonicalizeUrl(url);
    if (!canonical.ok) continue;
    const key = urlKey(canonical.url);
    if (key === current.urlKey) continue;
    const alias = await addArticleAlias(
      tx,
      current.id,
      key,
      source,
      current.id === article.id ? { expectedRevision: article.revision } : {},
    );
    if (alias.status === 'stale_revision') return 'stale';
    if (alias.status !== 'owned_by_other') continue;
    const merged = await mergeArticles(tx, sender, current.id, alias.ownerId, { reason: source });
    if (merged.status !== 'merged') continue;
    const survivor = await loadArticleForExtraction(tx, merged.survivorId);
    if (survivor === null) {
      throw new Error(`article ${merged.survivorId} vanished inside its merge transaction`);
    }
    current = survivor;
    newCarrierFeedIds = merged.movedFeedIds;
  }
  if (current.id === article.id) return 'kept';

  const context = pipelineContext(deps, tx, sender);
  for (const feedId of newCarrierFeedIds) {
    await afterNewCarrier(current.id, feedId, context);
  }
  const survivor = await loadArticleForExtraction(tx, current.id);
  if (survivor !== null && survivor.pipelineState === 'ingested') {
    await after('fetch', survivor.id, { status: 'ok', revision: survivor.revision }, context);
  } else if (survivor !== null && survivor.pipelineState === 'extracted') {
    await after('extract', survivor.id, { status: 'ok', revision: survivor.revision }, context);
  }
  return 'merged';
}

/**
 * The §6.4 media signals of this extraction (spec 03 §8.1 step 6): the page's video evidence (or a
 * skipped video-host URL) and the in-body image count of a stored readable page body. A linkless
 * article's feed text was examined at ingest, so it brings none here.
 */
function extractionMedia(result: ExtractResult | null): ExtractionMediaSignals {
  if (result === null)
    return { videoEvidence: false, bodyImageCount: null, pageBodyExamined: false };
  return {
    videoEvidence: result.videoEvidence,
    bodyImageCount: result.bodyImageCount,
    pageBodyExamined: result.bodyImageCount !== null,
  };
}

/**
 * The body row to store: the page extraction, or for a linkless article its feed text (no HTTP).
 * A failed page extraction keeps no text; the repository then preserves any good stored body.
 */
function bodyInput(article: ArticleForExtraction, result: ExtractResult | null): ArticleBodyInput {
  if (result === null) {
    const stored = article.body;
    if (
      stored !== null &&
      stored.articleRevision === article.revision &&
      stored.bodyText !== null
    ) {
      return { ...stored };
    }
    const text = article.excerpt;
    return {
      status: text === null ? 'failed' : 'ok',
      resolvedUrl: null,
      httpStatus: null,
      bodyText: text,
      bodyHtml: null,
      completeness: 'partial',
      completenessReason: text === null ? 'no_content' : 'excerpt_only',
      bodyLead: text === null ? null : bodyLead(text),
      extractorVersion: 'feed-v1',
      error: text === null ? 'no_content' : null,
    };
  }
  return {
    status: result.status,
    resolvedUrl: result.resolvedUrl,
    httpStatus: result.httpStatus,
    bodyText: result.bodyText,
    bodyHtml: result.bodyHtml,
    completeness: result.completeness,
    completenessReason: result.completenessReason,
    bodyLead: result.bodyLead,
    extractorVersion: EXTRACTOR_VERSION,
    error: result.error,
  };
}
