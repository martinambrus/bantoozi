import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';

/** `article_bodies.status` (spec 02 §3). */
export type ArticleBodyStatus = 'ok' | 'skipped' | 'failed' | 'blocked' | 'too_large' | 'not_html';

/** Extractor version of a publisher body taken from the feed itself (spec 03 §7 step 6). */
export const FEED_BODY_EXTRACTOR = 'feed-v1';

/** One revisioned `article_bodies` row (spec 03 §8.1 step 6, spec 02 §3). */
export interface ArticleBodyInput {
  status: ArticleBodyStatus;
  resolvedUrl: string | null;
  httpStatus: number | null;
  /** Full available readable text: never model-truncated (bookmark archives copy it). */
  bodyText: string | null;
  /** Full sanitized readable HTML. Text + HTML stay within 10 MiB of UTF-8 (the table CHECK). */
  bodyHtml: string | null;
  completeness: 'complete' | 'partial';
  completenessReason: string | null;
  /** ≤ 1,500 characters, the model view. */
  bodyLead: string | null;
  extractorVersion: string;
  /** Bounded, sanitized error code/message; never a raw URL query or response body. */
  error: string | null;
}

export interface StoredArticleBody extends ArticleBodyInput {
  articleId: string;
  articleRevision: string;
  extractedAt: Date;
}

/** Write the article's body row at `revision`, replacing any previous row (callers decide when). */
export async function upsertArticleBody(
  tx: Transaction,
  articleId: string,
  revision: string,
  body: ArticleBodyInput,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO article_bodies (article_id, article_revision, resolved_url, status, http_status,
                                body_text, body_html, completeness, completeness_reason, body_lead,
                                extractor_version, error, extracted_at)
    VALUES (${articleId}::bigint, ${revision}::bigint, ${body.resolvedUrl}, ${body.status},
            ${body.httpStatus}, ${body.bodyText}, ${body.bodyHtml}, ${body.completeness},
            ${body.completenessReason}, ${body.bodyLead}, ${body.extractorVersion}, ${body.error},
            now())
    ON CONFLICT (article_id) DO UPDATE SET
      article_revision = EXCLUDED.article_revision, resolved_url = EXCLUDED.resolved_url,
      status = EXCLUDED.status, http_status = EXCLUDED.http_status,
      body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html,
      completeness = EXCLUDED.completeness, completeness_reason = EXCLUDED.completeness_reason,
      body_lead = EXCLUDED.body_lead, extractor_version = EXCLUDED.extractor_version,
      error = EXCLUDED.error, extracted_at = EXCLUDED.extracted_at`);
}

/** The article's body row, whatever its revision (callers compare `articleRevision`). */
export async function getArticleBody(
  db: Executor,
  articleId: string,
): Promise<StoredArticleBody | null> {
  const result = await db.execute<{
    article_id: string;
    article_revision: string;
    resolved_url: string | null;
    status: ArticleBodyStatus;
    http_status: number | null;
    body_text: string | null;
    body_html: string | null;
    completeness: 'complete' | 'partial';
    completeness_reason: string | null;
    body_lead: string | null;
    extractor_version: string;
    error: string | null;
    extracted_at: Date;
  }>(sql`
    SELECT article_id::text AS article_id, article_revision::text AS article_revision, resolved_url,
           status, http_status, body_text, body_html, completeness, completeness_reason, body_lead,
           extractor_version, error, extracted_at
      FROM article_bodies WHERE article_id = ${articleId}::bigint`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    articleId: row.article_id,
    articleRevision: row.article_revision,
    resolvedUrl: row.resolved_url,
    status: row.status,
    httpStatus: row.http_status,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    completeness: row.completeness,
    completenessReason: row.completeness_reason,
    bodyLead: row.body_lead,
    extractorVersion: row.extractor_version,
    error: row.error,
    extractedAt: new Date(row.extracted_at),
  };
}
