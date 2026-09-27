import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/** `article_translations.engine` (spec 02 §3). */
export type TranslationEngine = 'libretranslate' | 'ollama';
export type TranslationQuality = 'ok' | 'weak' | 'fail';

/** One `article_translations` row (spec 07 §3): valid only for its `articleRevision`. */
export interface TranslationRow {
  articleId: string;
  articleRevision: string;
  sourceSha256: string;
  engine: TranslationEngine;
  model: string | null;
  sourceLang: string;
  title: string | null;
  excerpt: string | null;
  bodyLead: string | null;
  quality: TranslationQuality;
  qualityDetail: Record<string, unknown>;
  createdAt: Date;
}

/** The article's English translation rows stored for `revision` (other revisions are ineligible). */
export async function listTranslations(
  db: Executor,
  articleId: string,
  revision: string,
): Promise<TranslationRow[]> {
  const result = await db.execute<{
    article_id: string;
    article_revision: string;
    source_sha256: string;
    engine: TranslationEngine;
    model: string | null;
    source_lang: string;
    title: string | null;
    excerpt: string | null;
    body_lead: string | null;
    quality: TranslationQuality;
    quality_detail: Record<string, unknown>;
    created_at: RawTimestamp;
  }>(sql`
    SELECT article_id::text AS article_id, article_revision::text AS article_revision,
           source_sha256, engine, model, source_lang, title, excerpt, body_lead, quality,
           quality_detail, created_at
      FROM article_translations
     WHERE article_id = ${articleId}::bigint AND target_lang = 'en'
       AND article_revision = ${revision}::bigint
     ORDER BY engine`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    articleRevision: row.article_revision,
    sourceSha256: row.source_sha256,
    engine: row.engine,
    model: row.model,
    sourceLang: row.source_lang,
    title: row.title,
    excerpt: row.excerpt,
    bodyLead: row.body_lead,
    quality: row.quality,
    qualityDetail: row.quality_detail,
    createdAt: toDate(row.created_at),
  }));
}

export type TranslationInput = Omit<TranslationRow, 'createdAt'>;

/**
 * Store a translation row for its revision (one row per article/target/engine). A row of a newer
 * revision is never replaced by a late older result, and an existing row of the same revision is
 * kept unless `replace` allows it: `'skipped'` replaces only a skipped tier-2 row (the
 * administrative reprocess, spec 07 §3), `'any'` any row of that revision. Returns whether the
 * row was written.
 */
export async function storeTranslation(
  tx: Transaction,
  row: TranslationInput,
  options: { replace?: 'none' | 'skipped' | 'any' } = {},
): Promise<boolean> {
  const replace = options.replace ?? 'none';
  const result = await tx.execute(sql`
    INSERT INTO article_translations AS t
           (article_id, article_revision, source_sha256, target_lang, engine, model, source_lang,
            title, excerpt, body_lead, quality, quality_detail, created_at)
    VALUES (${row.articleId}::bigint, ${row.articleRevision}::bigint, ${row.sourceSha256}, 'en',
            ${row.engine}, ${row.model}, ${row.sourceLang}, ${row.title}, ${row.excerpt},
            ${row.bodyLead}, ${row.quality}, ${JSON.stringify(row.qualityDetail)}::jsonb, now())
    ON CONFLICT (article_id, target_lang, engine) DO UPDATE SET
      article_revision = EXCLUDED.article_revision, source_sha256 = EXCLUDED.source_sha256,
      model = EXCLUDED.model, source_lang = EXCLUDED.source_lang, title = EXCLUDED.title,
      excerpt = EXCLUDED.excerpt, body_lead = EXCLUDED.body_lead, quality = EXCLUDED.quality,
      quality_detail = EXCLUDED.quality_detail, created_at = EXCLUDED.created_at
    WHERE t.article_revision < EXCLUDED.article_revision
       OR (t.article_revision = EXCLUDED.article_revision
           AND (${replace} = 'any'
                OR (${replace} = 'skipped' AND t.quality_detail ? 'skipped')))`);
  return (result.rowCount ?? 0) > 0;
}
