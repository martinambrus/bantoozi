import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import type { DatasetSplit } from './datasets.js';

/**
 * `eval status` aggregates (spec 10 §2.1): per-language sample counts, then per rater the cards
 * written, feeds picked, assigned, rated and skipped articles, and the facet-label counts per
 * language. Read-only; the rating app (M3a-T3/T4) writes these tables.
 */

export interface SampleLangCount {
  lang: string;
  dev: number;
  test: number;
}

/** Sample rows of a dataset version per language and split. */
export async function sampleLangCounts(db: Executor, version: string): Promise<SampleLangCount[]> {
  const result = await db.execute<{ lang: string; split: DatasetSplit; n: string }>(sql`
    SELECT lang, split, count(*)::text AS n FROM eval.sample
     WHERE dataset_version = ${version} GROUP BY lang, split ORDER BY lang, split`);
  const byLang = new Map<string, SampleLangCount>();
  for (const row of result.rows) {
    const entry = byLang.get(row.lang) ?? { lang: row.lang, dev: 0, test: 0 };
    entry[row.split] += Number(row.n);
    byLang.set(row.lang, entry);
  }
  return [...byLang.values()];
}

export interface RaterProgress {
  raterId: string;
  name: string;
  participantKey: string;
  contextName: string | null;
  langs: string[];
  /** Interest cards (strength must/love/like). */
  cards: number;
  /** "Never" cards. */
  neverCards: number;
  feeds: number;
  assigned: number;
  rated: number;
  skipped: number;
  pending: number;
  likes: number;
  dislikes: number;
  revoked: boolean;
}

/** Progress of every rater, by id. */
export async function raterProgress(db: Executor): Promise<RaterProgress[]> {
  const result = await db.execute<{
    rater_id: string;
    name: string;
    participant_key: string;
    context_name: string | null;
    langs: string[];
    cards: string;
    never_cards: string;
    feeds: string;
    assigned: string;
    rated: string;
    skipped: string;
    pending: string;
    likes: string;
    dislikes: string;
    revoked: boolean;
  }>(sql`
    SELECT r.id::text AS rater_id, r.name, r.participant_key::text AS participant_key,
           r.context_name, r.langs,
           (SELECT count(*) FROM eval.rater_cards c
             WHERE c.rater_id = r.id AND c.strength <> 'never')::text AS cards,
           (SELECT count(*) FROM eval.rater_cards c
             WHERE c.rater_id = r.id AND c.strength = 'never')::text AS never_cards,
           (SELECT count(*) FROM eval.rater_feeds f WHERE f.rater_id = r.id)::text AS feeds,
           (SELECT count(*) FROM eval.assignments a WHERE a.rater_id = r.id)::text AS assigned,
           (SELECT count(*) FROM eval.assignments a
             WHERE a.rater_id = r.id AND a.status = 'rated')::text AS rated,
           (SELECT count(*) FROM eval.assignments a
             WHERE a.rater_id = r.id AND a.status = 'skipped')::text AS skipped,
           (SELECT count(*) FROM eval.assignments a
             WHERE a.rater_id = r.id AND a.status = 'pending')::text AS pending,
           (SELECT count(*) FROM eval.ratings t
             WHERE t.rater_id = r.id AND t.rating = 1)::text AS likes,
           (SELECT count(*) FROM eval.ratings t
             WHERE t.rater_id = r.id AND t.rating = -1)::text AS dislikes,
           r.token_revoked_at IS NOT NULL AS revoked
      FROM eval.raters r
     ORDER BY r.id`);
  return result.rows.map((row) => ({
    raterId: row.rater_id,
    name: row.name,
    participantKey: row.participant_key,
    contextName: row.context_name,
    langs: row.langs,
    cards: Number(row.cards),
    neverCards: Number(row.never_cards),
    feeds: Number(row.feeds),
    assigned: Number(row.assigned),
    rated: Number(row.rated),
    skipped: Number(row.skipped),
    pending: Number(row.pending),
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
    revoked: row.revoked,
  }));
}

export interface FacetLabelCount {
  labeler: string;
  /** The article's detected language (`und` when none). */
  lang: string;
  /** Distinct labelled articles. */
  articles: number;
  /** Stored labels (one per article and question). */
  labels: number;
}

/** Facet labels per labeller and language. */
export async function facetLabelCounts(db: Executor): Promise<FacetLabelCount[]> {
  const result = await db.execute<{
    labeler: string;
    lang: string;
    articles: string;
    labels: string;
  }>(sql`
    SELECT l.labeler, coalesce(a.lang, 'und') AS lang,
           count(DISTINCT l.article_id)::text AS articles, count(*)::text AS labels
      FROM eval.facet_labels l JOIN articles a ON a.id = l.article_id
     GROUP BY l.labeler, 2 ORDER BY l.labeler, 2`);
  return result.rows.map((row) => ({
    labeler: row.labeler,
    lang: row.lang,
    articles: Number(row.articles),
    labels: Number(row.labels),
  }));
}
