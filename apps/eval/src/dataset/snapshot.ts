import type { CarrierFeed, ClassificationArticle } from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import type { ArticleStateInput } from '@bantoozi/questions';
import { normalizeText } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';

/**
 * The frozen input of one golden article (spec 10 §2.1): everything an experiment or replay reads
 * about it, so runs never touch the mutable live article. `input` is exactly what the production
 * state builder takes (spec 05 §3.1: canonical feed title and registrable site, title, author,
 * categories, excerpt, the stored body lead, word count, language); translations are frozen with
 * each run, not here.
 */
export interface EvalSnapshot {
  v: 1;
  articleId: string;
  /** `articles.content_revision` at the freeze (decimal string). */
  contentRevision: string;
  /** The article link ("open original"); null when the item had none. */
  url: string | null;
  /** Detected language (`articles.lang`). */
  lang: string;
  input: SnapshotStateInput;
  publishedAt: string | null;
  firstSeenAt: string;
  /** The canonical feed (oldest carrier, then lowest id); null when no feed carries it. */
  canonicalFeedId: string | null;
  carrierFeeds: { feedId: string; title: string | null; firstSeenAt: string }[];
  /** Story group: `c<story_cluster_id>` when clustered, else `t<sha of the normalized title>`. */
  storyGroupId: string;
}

/** `ArticleStateInput` without a translation, as plain JSON. */
export type SnapshotStateInput = Omit<ArticleStateInput, 'translation' | 'categories'> & {
  categories: string[];
};

/**
 * The story group of an article (spec 10 §2.1 groups duplicates and all raters' copies of a story).
 * Golden collection runs ingest-only, so story clusters are usually absent: unclustered articles
 * group by their normalized title, which keeps exact republished duplicates together (D-97).
 */
export function storyGroupId(
  article: Pick<ClassificationArticle, 'storyClusterId' | 'title'>,
): string {
  if (article.storyClusterId !== null) return `c${article.storyClusterId}`;
  const norm = normalizeText(article.title).replace(/\s+/g, ' ').trim();
  return `t${canonicalSha256(norm).slice(0, 16)}`;
}

/** Build the snapshot of an article at its current revision. */
export function buildSnapshot(
  article: ClassificationArticle,
  carriers: readonly CarrierFeed[],
  url: string | null,
): EvalSnapshot {
  const site =
    article.feed === null
      ? null
      : (registrableDomain(article.feed.siteUrl) ?? registrableDomain(article.feed.url));
  return {
    v: 1,
    articleId: article.id,
    contentRevision: article.revision,
    url,
    lang: article.lang ?? 'und',
    input: {
      title: article.title,
      author: article.author,
      categories: [...article.categories],
      excerpt: article.excerpt,
      bodyLead: article.bodyLead,
      wordCount: article.wordCount,
      lang: article.lang,
      feed: { title: article.feed?.title ?? null, site },
    },
    publishedAt: article.publishedAt?.toISOString() ?? null,
    firstSeenAt: article.firstSeenAt.toISOString(),
    canonicalFeedId: article.feed?.id ?? null,
    carrierFeeds: carriers.map((c) => ({
      feedId: c.feedId,
      title: c.title,
      firstSeenAt: c.firstSeenAt.toISOString(),
    })),
    storyGroupId: storyGroupId(article),
  };
}

/** `eval.sample.snapshot_sha`. */
export function snapshotSha(snapshot: EvalSnapshot): string {
  return canonicalSha256(snapshot);
}

/** Read back a stored snapshot (a jsonb object written by {@link buildSnapshot}). */
export function asSnapshot(value: Record<string, unknown>): EvalSnapshot {
  if (value['v'] !== 1 || typeof value['articleId'] !== 'string') {
    throw new TypeError('not an eval snapshot (v1)');
  }
  return value as unknown as EvalSnapshot;
}
