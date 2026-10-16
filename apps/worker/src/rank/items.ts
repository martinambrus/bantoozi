import {
  loadClassificationArticles,
  loadRankAnswers,
  loadRankArticleFacts,
  loadRankFacets,
  loadRankFacetStates,
  loadRankQueueRows,
  loadRankTranslations,
  loadStoredRanks,
  MATCH_MAX_ATTEMPTS,
  type CardInput,
  type ClassificationArticle,
  type Executor,
  type RankQueueRow,
  type StoredRankRow,
  type TranslationRow,
} from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import {
  isCardApplicable,
  matchCoverage,
  type CardAnswers,
  type CardWorkState,
  type ModelEngine,
  type RankItem,
  type UserRankContext,
} from '@bantoozi/ranker';

import { builtCardQuestion, isCurrentCardAnswer } from '../classify/card-questions.js';
import type { ClassificationConfig } from '../classify/config.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { rankTexts } from './context.js';

/** What a run fixes once for all its pages. */
export interface RankItemsRun {
  userId: string;
  now: Date;
  ctx: UserRankContext;
  config: ClassificationConfig;
  /** The user's interest and label cards (their question inputs), by id. */
  cardInputs: ReadonlyMap<string, CardInput>;
  /** The current model pin (setting `engine.model_pin.model`, else the primary model). */
  modelPin: string;
  /**
   * Articles of the loaded pages whose facets and card answers come from the current state and the
   * pin: the only ones the personal model may score (spec 06 §8.1). Filled by `loadRankItems`.
   */
  modelEligible: Set<string>;
}

/** One article ready for `rankArticle`, with what the write and the comparison need. */
export interface LoadedRankItem {
  item: RankItem;
  stored: StoredRankRow | undefined;
  /** The current-revision English translation rows (weak-translation escalation, §7 step 6). */
  translations: TranslationRow[];
}

const DEFERRED_ERRORS = new Set(['no_key', 'budget', 'circuit_open']);
const MODEL_ENGINES = new Set<string>(['typesafe', 'llm', 'laya']);

/** The question hash of every card and label the run knows, under the card text mode. */
export function cardInputHashes(
  cardInputs: ReadonlyMap<string, CardInput>,
  config: ClassificationConfig,
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [id, card] of cardInputs) {
    hashes.set(id, builtCardQuestion(card, config.cardTextMode).sha256);
  }
  return hashes;
}

/**
 * The work state of a card without a usable answer (spec 06 §2, `matchCoverage`): its
 * `match_queue` row when there is one; otherwise an article whose enrichment degraded or failed can
 * make no progress for it, while one still on its way to matching is scheduled.
 */
function workState(row: RankQueueRow | undefined, article: ClassificationArticle, now: Date) {
  if (row !== undefined) {
    if (row.attempts >= MATCH_MAX_ATTEMPTS) return 'exhausted' satisfies CardWorkState;
    if (
      row.lastError !== null &&
      DEFERRED_ERRORS.has(row.lastError) &&
      row.nextAttemptAt.getTime() > now.getTime()
    ) {
      return row.lastError as CardWorkState;
    }
    return 'scheduled' satisfies CardWorkState;
  }
  if (article.pipelineState === 'degraded' || article.pipelineState === 'failed') {
    return 'exhausted' satisfies CardWorkState;
  }
  return undefined;
}

function group<T extends { articleId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.articleId) ?? [];
    list.push(row);
    map.set(row.articleId, list);
  }
  return map;
}

/**
 * Batch-loads the page's articles (spec 06 §7 step 3) and builds each `RankItem`. Answers count only
 * when they answer exactly the current input (revision, match set, article state and card question,
 * spec 05 §5.2); facets only from the active enrich set at the current revision. Articles that
 * disappeared are absent from the result.
 */
export async function loadRankItems(
  db: Executor,
  run: RankItemsRun,
  hashes: ReadonlyMap<string, string>,
  articleIds: readonly string[],
): Promise<LoadedRankItem[]> {
  const { userId, now, ctx, config } = run;
  const cardIds = [...run.cardInputs.keys()];
  const articles = await loadClassificationArticles(db, articleIds);
  const ids = articleIds.filter((id) => articles.has(id));
  const facts = await loadRankArticleFacts(db, { userId, articleIds: ids, now });
  const facets = await loadRankFacets(db, {
    articleIds: ids,
    enrichSetId: config.enrich?.id ?? null,
  });
  const facetStates = await loadRankFacetStates(db, {
    articleIds: ids,
    enrichSetId: config.enrich?.id ?? null,
  });
  const answers = group(await loadRankAnswers(db, { articleIds: ids, cardIds }));
  const queue = group(await loadRankQueueRows(db, { articleIds: ids, cardIds }));
  const stored = await loadStoredRanks(db, { userId, articleIds: ids });
  const translations = group(await loadRankTranslations(db, ids));

  const interestCards = new Map(ctx.cards.map((card) => [card.cardId, card]));
  const loaded: LoadedRankItem[] = [];
  for (const id of ids) {
    const article = articles.get(id);
    const fact = facts.get(id);
    if (article === undefined || fact === undefined) continue;
    const rows = translations.get(id) ?? [];
    const cardAnswers: Record<string, { p: number; engine: RankAnswerEngine }> = {};
    const match = config.match;
    const articleAnswers = answers.get(id) ?? [];
    let modelCurrent = true;
    if (match !== null && articleAnswers.length > 0) {
      const fingerprint = {
        articleRevision: article.revision,
        matchSetSha: match.sha256,
        stateSha256: buildState(modelInput(article, rows, config), 'match').sha256,
      };
      for (const answer of articleAnswers) {
        const sha = hashes.get(answer.cardId);
        if (sha !== undefined && isCurrentCardAnswer(answer, fingerprint, sha)) {
          cardAnswers[answer.cardId] = { p: answer.p, engine: answer.engine };
          // Interest-card answers feed the model's features; label answers do not.
          const card = interestCards.get(answer.cardId);
          if (
            card !== undefined &&
            isCardApplicable(card, fact.inferenceFeedIds) &&
            answer.engine !== 'prefilter' &&
            answer.model !== run.modelPin
          ) {
            modelCurrent = false;
          }
        }
      }
    }
    const facetState = facetStates.get(id);
    if (
      facetState !== undefined &&
      (facetState.model !== run.modelPin ||
        facetState.stateSha256 !== buildState(modelInput(article, rows, config), 'enrich').sha256)
    ) {
      modelCurrent = false;
    }
    if (modelCurrent) run.modelEligible.add(id);
    else run.modelEligible.delete(id);
    const work: Record<string, CardWorkState> = {};
    // A selection is frozen (D-254): where this user's demand reaches the article only through a
    // selection, a card with neither an answer nor a queue row is not applicable to it, whatever
    // the article's state (another account may have enriched it), so it is neither pending nor
    // unavailable.
    const frozen = fact.explicitSelection && !fact.automaticAdmitted;
    const queueRows = new Map((queue.get(id) ?? []).map((row) => [row.cardId, row]));
    for (const card of ctx.cards) {
      const state = workState(queueRows.get(card.cardId), article, now);
      if (state !== undefined) work[card.cardId] = state;
    }
    const texts = rankTexts(
      { titleNorm: article.titleNorm, excerpt: article.excerpt, revision: article.revision },
      rows,
    );
    const storedRow = stored.get(id);
    const evidence = {
      cardAnswers: cardAnswers as CardAnswers,
      inferenceFeedIds: fact.inferenceFeedIds,
    };
    const featureSet = facets.get(id);
    const item: RankItem = {
      articleId: id,
      feedIds: fact.feedIds,
      inferenceFeedIds: fact.inferenceFeedIds,
      inferenceEligible: fact.inferenceFeedIds.length > 0,
      explicitSelection: fact.explicitSelection,
      domain: registrableDomain(fact.url) ?? '',
      author: article.author,
      ...texts,
      firstSeenAt: article.firstSeenAt,
      ...(article.publishedAt === null ? {} : { publishedAt: article.publishedAt }),
      contentRevision: article.revision,
      wordCount: article.wordCount,
      hasImage: fact.hasImage,
      lang: article.lang ?? 'und',
      hasVideo: fact.hasVideo,
      bodyImageCount: fact.bodyImageCount,
      mediaRevision: fact.mediaRevision,
      ...(article.storyClusterId === null ? {} : { clusterId: article.storyClusterId }),
      clusterSize: fact.clusterSize ?? 1,
      pipelineState: article.pipelineState,
      matchCoverage: matchCoverage(
        frozen
          ? ctx.cards.filter(
              (card) => queueRows.has(card.cardId) || cardAnswers[card.cardId] !== undefined,
            )
          : ctx.cards,
        evidence,
        work,
      ).coverage,
      ...(featureSet === undefined ? {} : { facets: featureSet }),
      ...(facetState !== undefined && MODEL_ENGINES.has(facetState.engine)
        ? { facetsEngine: facetState.engine as ModelEngine }
        : {}),
      cardAnswers,
      labelIds: storedRow?.labelIds ?? [],
    };
    loaded.push({ item, stored: storedRow, translations: rows });
  }
  return loaded;
}

type RankAnswerEngine = CardAnswers[string]['engine'];
