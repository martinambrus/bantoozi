import {
  loadActiveRules,
  loadRankCards,
  loadRankLabels,
  loadRankTranslations,
  loadReadClusterIds,
  loadRecentDislikes,
  rankCorpusPage,
  type Executor,
  type RankDislike,
  type RankUser,
  type TranslationRow,
} from '@bantoozi/db';
import {
  buildBm25Corpus,
  DEMOTION_FLAGS,
  type Bm25Text,
  type DemotionFlag,
  type DislikeReason,
  type RankerSettings,
  type UserRankContext,
} from '@bantoozi/ranker';
import {
  canonicalJson,
  normalizeText,
  RANK_WINDOW_DAYS,
  readUserPreferences,
} from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';
import { selectBestTranslation } from '@bantoozi/translate';

/** Corpus articles read per query while building the BM25 statistics. */
export const RANK_CORPUS_PAGE = 2_000;

const DAY_MS = 86_400_000;

/** The version of the `contextSha` recipe (D-97); bump it when the hashed inputs change. */
const CONTEXT_SHA_VERSION = 1;

/** Normalized article texts of one document, the translation selected as `rankArticle` reads it. */
export interface RankTexts extends Bm25Text {
  translation?: { engine: string; quality: string } | undefined;
}

/** The ranker's texts of an article: its own normalized title/excerpt and the best translation. */
export function rankTexts(
  article: { titleNorm: string; excerpt: string | null; revision: string },
  translations: readonly TranslationRow[],
): RankTexts {
  const best = selectBestTranslation(translations, article.revision);
  return {
    titleNorm: article.titleNorm,
    excerptNorm: normalizeText(article.excerpt ?? ''),
    ...(best === null
      ? {}
      : {
          translatedTitleNorm: normalizeText(best.title ?? ''),
          translatedExcerptNorm: normalizeText(best.excerpt ?? ''),
          translation: { engine: best.engine, quality: best.quality },
        }),
  };
}

/**
 * The demotion state of spec 06 §5 from the user's current dislikes in the auto window: counts per
 * reason, the stale-at-feedback count, and per `auto` flag the time its count falls below
 * `autoMinDislikes` as the oldest qualifying dislike leaves the window (`next_rank_at`, §7 step 5).
 */
export function demotionState(
  dislikes: readonly RankDislike[],
  settings: RankerSettings,
): Pick<UserRankContext, 'reasonCounts90d' | 'staleDislikes90d' | 'demotionDeadlines'> {
  const { autoMinDislikes, autoWindowDays } = settings.config.demotion;
  const windowMs = autoWindowDays * DAY_MS;
  const reasonCounts: Partial<Record<DislikeReason, number>> = {};
  for (const dislike of dislikes) {
    if (dislike.reason === null) continue;
    const reason = dislike.reason as DislikeReason;
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const qualifying: Record<DemotionFlag, RankDislike[]> = {
    clickbait: dislikes.filter((d) => d.reason === 'clickbait'),
    promotional: dislikes.filter((d) => d.reason === 'promo'),
    shallow: dislikes.filter((d) => d.reason === 'shallow'),
    stale: dislikes.filter((d) => d.staleAtFeedback === true),
  };
  const deadlines: Partial<Record<DemotionFlag, Date>> = {};
  for (const flag of DEMOTION_FLAGS) {
    const rows = [...qualifying[flag]].sort((a, b) => a.ratedAt.getTime() - b.ratedAt.getTime());
    if (rows.length < autoMinDislikes) continue;
    // Below the minimum once all but `autoMinDislikes − 1` of them have aged out.
    const pivot = rows[rows.length - autoMinDislikes];
    if (pivot !== undefined) deadlines[flag] = new Date(pivot.ratedAt.getTime() + windowMs);
  }
  return {
    reasonCounts90d: reasonCounts,
    staleDislikes90d: qualifying.stale.length,
    demotionDeadlines: deadlines,
  };
}

/** A sha256 over the canonical JSON of the ranking context (D-97). */
function contextHash(value: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ v: CONTEXT_SHA_VERSION, ...value }));
}

/**
 * The BM25 corpus of the user's window (spec 06 §7 step 1, §9) and a fingerprint of its documents:
 * each eligible article's revision and selected translation. A changed fingerprint changes the
 * degraded context, so every degraded item is ranked again ("BM25 corpus membership changed").
 */
export async function loadRankCorpus(
  db: Executor,
  input: { userId: string; now: Date },
): Promise<{ corpus: UserRankContext['bm25']; documents: number; sha: string }> {
  const texts: RankTexts[] = [];
  const fingerprint: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await rankCorpusPage(db, {
      userId: input.userId,
      now: input.now,
      windowDays: RANK_WINDOW_DAYS,
      ...(afterId === undefined ? {} : { afterId }),
      limit: RANK_CORPUS_PAGE,
    });
    if (page.length === 0) break;
    const translations = await loadRankTranslations(
      db,
      page.map((article) => article.articleId),
    );
    const byArticle = new Map<string, typeof translations>();
    for (const row of translations) {
      const rows = byArticle.get(row.articleId) ?? [];
      rows.push(row);
      byArticle.set(row.articleId, rows);
    }
    for (const article of page) {
      const rows = byArticle.get(article.articleId) ?? [];
      const text = rankTexts(article, rows);
      texts.push(text);
      const best = selectBestTranslation(rows, article.revision);
      fingerprint.push(
        [
          article.articleId,
          article.revision,
          best === null ? '' : `${best.engine}@${best.createdAt.toISOString()}`,
        ].join(':'),
      );
    }
    afterId = page[page.length - 1]?.articleId;
    if (page.length < RANK_CORPUS_PAGE) break;
  }
  return {
    corpus: buildBm25Corpus(texts),
    documents: texts.length,
    sha: sha256Hex(fingerprint.join('|')),
  };
}

/**
 * Loads `UserRankContext` (spec 06 §7 step 1) at the run's single `now`. `contextSha` hashes the
 * score version, the rank revision, the classification context and the model context; M7 adds the
 * active model, until then none is compatible and the hash records `null`. `degradedContextSha`
 * adds the BM25 corpus fingerprint.
 */
export async function loadRankContext(
  db: Executor,
  input: {
    user: RankUser;
    settings: RankerSettings;
    now: Date;
    /**
     * The classification context the stored answers and facets were judged current under (active
     * sets, card text mode, language modes, each held card's question hash): part of `contextSha`,
     * so a change, such as a card's newly translated text, makes every row dirty (D-97).
     */
    classification: Record<string, unknown>;
  },
): Promise<UserRankContext> {
  const { user, settings, now } = input;
  const config = settings.config;
  const [cards, labels, rules, dislikes, readClusterIds, corpus] = [
    await loadRankCards(db, user.userId),
    await loadRankLabels(db, user.userId),
    await loadActiveRules(db, user.userId, now),
    await loadRecentDislikes(
      db,
      user.userId,
      new Date(now.getTime() - config.demotion.autoWindowDays * DAY_MS),
    ),
    await loadReadClusterIds(db, user.userId, new Date(now.getTime() - RANK_WINDOW_DAYS * DAY_MS)),
    await loadRankCorpus(db, { userId: user.userId, now }),
  ];
  const context = {
    scoreVersion: settings.scoreVersion,
    rankRevision: user.rankRevision,
    classification: input.classification,
    model: null,
  };
  return {
    userId: user.userId,
    rankRevision: user.rankRevision,
    contextSha: contextHash(context),
    degradedContextSha: contextHash({
      ...context,
      corpus: { documents: corpus.documents, sha: corpus.sha },
    }),
    config,
    cards: cards.map((card) => ({
      cardId: card.cardId,
      title: card.title,
      strength: card.strength,
      ...(card.scopeFeedId === null ? {} : { scopeFeedId: card.scopeFeedId }),
      interest: card.interest,
      ...(card.interestEn === null ? {} : { interestEn: card.interestEn }),
      lang: card.lang,
    })),
    labels,
    rules: rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      value: rule.value,
      ...(rule.expiresAt === null ? {} : { expiresAt: rule.expiresAt }),
    })),
    demote: readUserPreferences(user.preferences).demote,
    ...demotionState(dislikes, settings),
    readClusterIds,
    bm25: corpus.corpus,
  };
}
