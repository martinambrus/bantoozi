import {
  claimSuggestLease,
  finishSuggestRun,
  hasSuggestDemand,
  isPrimaryAnswer,
  listTranslations,
  loadCardInputs,
  loadClassificationArticles,
  loadRankArticleFacts,
  loadRankCards,
  loadRankFacets,
  loadSuggestAnswers,
  loadSuggestLibrary,
  loadSuggestLikes,
  readSuggestPin,
  releaseSuggestLease,
  renewSuggestLease,
  type SuggestAnswerRow,
} from '@bantoozi/db';
import {
  SUGGEST_QUESTION_KEY,
  effectiveCardText,
  planSuggestion,
  stateSha256,
  suggestResults,
  type ChoiceAnswer,
  type SuggestLike,
} from '@bantoozi/questions';
import { isCardApplicable } from '@bantoozi/ranker';

import { isCurrentCardAnswer } from '../classify/card-questions.js';
import {
  loadClassificationConfig,
  loadSuggestSet,
  requireSet,
  type ClassificationConfig,
} from '../classify/config.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { cardInputHashes } from '../rank/items.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const T1_PREFIX = 't1.';

/**
 * `user.suggest {userId}` (spec 05 §7). One attempt per user and day: claims the suggest lease
 * (refused for a live lease or a stamp younger than 24 hours), reads the user's unexplained likes
 * (rated +1 or bookmarked in the last 30 days, on currently authorized articles, no applicable
 * positive card answering 0.3 or more) and plans one bulk Jev call over library cards. A user with
 * no inference demand, or a plan that asks nothing, clears the undismissed suggestions without
 * spending. Otherwise the call runs under the lease authorization (the router's spend reservation
 * rechecks the lease and stamps `last_suggested_at`; a lost lease never reserves). An unavailable
 * engine releases the lease and leaves the stored suggestions; an answer from another engine or
 * model than the current pin is discarded. The results are stored in one transaction under the
 * lease token and the active suggest set and pin, which also cleans up stale rows and releases the
 * lease.
 */
export function createUserSuggestHandler(deps: WorkerDeps): QueueHandler<'user.suggest'> {
  const classification = deps.classification;
  if (classification === undefined) {
    throw new Error('user.suggest needs the classification dependencies');
  }
  return async ({ userId }) => {
    const now = nowOf(deps);
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const suggestSet = requireSet(await loadSuggestSet(deps.db), 'suggest');
    const pin = await readSuggestPin(deps.db, classification.primaryModel);

    const claim = await claimSuggestLease(deps.db, userId, { leaseMs: classification.leaseMs });
    if (claim.status !== 'claimed') return;
    const { leaseToken } = claim;
    const finish = (results: { cardId: string; score: number }[] | null, asked = false) =>
      finishSuggestRun(deps.db, {
        userId,
        leaseToken,
        results,
        ...(asked ? { asked: { questionSetId: suggestSet.id, pin } } : {}),
        fallbackModel: classification.primaryModel,
      });
    try {
      const demand = await hasSuggestDemand(deps.db, userId, now);
      const plan = demand
        ? await planFor(deps, config, userId, now, classification.primaryModel)
        : ({ ask: false } as const);
      if (!plan.ask) {
        await finish([]);
        return;
      }
      if (!(await renewSuggestLease(deps.db, userId, leaseToken, classification.leaseMs))) return;
      const outcome = await classification.router.ask({
        kind: 'suggest',
        priority: 'bulk',
        userId,
        state: plan.state,
        questions: plan.questions,
        questionSetId: suggestSet.id,
        questionSetSha: suggestSet.sha256,
        stateSha256: stateSha256(plan.state),
        cardIds: plan.cardIds,
        authorization: {
          type: 'suggest',
          userId,
          eligibleArticleIds: plan.articleIds,
          leaseToken,
        },
        deadlineMs: now.getTime() + classification.callDeadlineMs,
      });
      const answer = outcome.ok ? outcome.answers[SUGGEST_QUESTION_KEY] : undefined;
      if (
        !outcome.ok ||
        outcome.engine !== 'typesafe' ||
        outcome.model !== pin ||
        answer?.type !== 'choice'
      ) {
        await releaseSuggestLease(deps.db, userId, leaseToken);
        return;
      }
      const offered = new Set(plan.cardIds);
      await finish(
        suggestResults(answer as ChoiceAnswer).filter((result) => offered.has(result.cardId)),
        true,
      );
    } catch (error) {
      await releaseSuggestLease(deps.db, userId, leaseToken).catch(() => undefined);
      throw error;
    }
  };
}

/** Steps 1–5 of spec 05 §7 over the user's current evidence. */
async function planFor(
  deps: WorkerDeps,
  config: ClassificationConfig,
  userId: string,
  now: Date,
  primaryModel: string,
) {
  const positive = (await loadRankCards(deps.db, userId)).filter(
    (card) => card.strength !== 'never',
  );
  const likedRows = await loadSuggestLikes(deps.db, userId, now);
  const facts = await loadRankArticleFacts(deps.db, {
    userId,
    articleIds: likedRows.map((row) => row.articleId),
    now,
  });
  const liked = likedRows.filter(
    (row) => (facts.get(row.articleId)?.inferenceFeedIds.length ?? 0) > 0,
  );
  const ids = liked.map((row) => row.articleId);
  const articles = await loadClassificationArticles(deps.db, ids);
  const facets = await loadRankFacets(deps.db, {
    articleIds: ids,
    enrichSetId: config.enrich?.id ?? null,
  });
  const cardIds = positive.map((card) => card.cardId);
  const hashes = cardInputHashes(await loadCardInputs(deps.db, cardIds), config);
  const answers = new Map<string, SuggestAnswerRow>();
  for (const row of await loadSuggestAnswers(deps.db, { articleIds: ids, cardIds })) {
    answers.set(`${row.articleId}:${row.cardId}`, row);
  }

  const likes: SuggestLike[] = [];
  for (const row of liked) {
    const article = articles.get(row.articleId);
    const fact = facts.get(row.articleId);
    if (article === undefined || fact === undefined) continue;
    const applicable = positive.filter((card) =>
      isCardApplicable(
        card.scopeFeedId === null ? {} : { scopeFeedId: card.scopeFeedId },
        fact.inferenceFeedIds,
      ),
    );
    let matchSha: string | undefined;
    const cardP: (number | null)[] = [];
    for (const card of applicable) {
      const answer = answers.get(`${row.articleId}:${card.cardId}`);
      const cardSha = hashes.get(card.cardId);
      if (answer === undefined || cardSha === undefined || config.match === null) {
        cardP.push(null);
        continue;
      }
      matchSha ??= buildState(
        modelInput(article, await listTranslations(deps.db, article.id, article.revision), config),
        'match',
      ).sha256;
      const current = isCurrentCardAnswer(
        answer,
        {
          articleRevision: article.revision,
          matchSetSha: config.match.sha256,
          stateSha256: matchSha,
        },
        cardSha,
      );
      cardP.push(current && isPrimaryAnswer(answer, primaryModel) ? answer.p : null);
    }
    likes.push({
      articleId: row.articleId,
      likedAt: row.likedAt,
      title: article.title,
      excerpt: article.excerpt,
      t1: t1Of(facets.get(row.articleId)),
      cardP,
    });
  }

  const library = await loadSuggestLibrary(deps.db, userId, now);
  return planSuggestion({
    positiveCardCount: positive.length,
    likes,
    libraryCards: library.cards.map((card) => {
      const text = effectiveCardText(
        {
          interest: card.interest,
          not_for: card.notFor,
          interest_en: card.interestEn,
          not_for_en: card.notForEn,
        },
        config.cardTextMode,
      );
      return { id: card.id, interest: text.interest, notFor: text.notFor, topicIds: card.topicIds };
    }),
    excludedCardIds: new Set(library.excludedCardIds),
  });
}

/** The `t1.<l1>` features keyed by plain level-1 id; null without current facets. */
function t1Of(features: Record<string, number> | undefined): Record<string, number> | null {
  if (features === undefined) return null;
  const t1: Record<string, number> = {};
  for (const [key, value] of Object.entries(features)) {
    if (key.startsWith(T1_PREFIX)) t1[key.slice(T1_PREFIX.length)] = value;
  }
  return Object.keys(t1).length === 0 ? null : t1;
}
