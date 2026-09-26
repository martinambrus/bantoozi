import {
  BACKFILL_INTERACTIVE_ARTICLES,
  BACKFILL_PAGE_SIZE,
  BACKFILL_PRIORITY_FIRST,
  BACKFILL_PRIORITY_REST,
  backfillPage,
  heldBackfillCards,
  isPrimaryAnswer,
  listTranslations,
  loadCardInputs,
  loadClassificationArticles,
  readCardAnswers,
  retryTransaction,
  upsertMatchQueue,
  userPlan,
  workerOutbox,
  type CardInput,
  type ClassificationArticle,
  type HeldBackfillCard,
} from '@bantoozi/db';
import {
  enqueueBackfill,
  enqueueEnrich,
  enqueueMatch,
  planLimits,
  type JobPayload,
} from '@bantoozi/shared';

import { builtCardQuestion, isCurrentCardAnswer } from '../classify/card-questions.js';
import {
  loadClassificationConfig,
  requireSet,
  type ClassificationConfig,
} from '../classify/config.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/** Where the backfill sends an article (spec 05 §5.4 steps 2 and 5). */
type ArticleWork =
  | { kind: 'match'; articleId: string; revision: string; cardIds: string[]; priority: number }
  | { kind: 'enrich'; articleId: string; revision: string; cardIds: string[]; priority: number }
  | { kind: 'queue'; articleId: string; revision: string; cardIds: string[]; priority: number };

/**
 * `card.backfill {userId, cardIds, feedIds?, snapshotAt?, cursor?, processedCount?}` (spec 05 §5.4).
 * The first page fixes `snapshotAt` and `processedCount`; every page revalidates the user, the held
 * cards and labels, and the subscriptions, then reads up to 500 articles the user's admitted demand
 * covers (active arrivals after activation, current selected requests) whose eligible carrier
 * arrival lies in the plan window before `snapshotAt`, newest first below the cursor. Each
 * applicable held card without a current primary answer is queued at priority 2 for the first 50
 * articles of the whole request and 6 after, attributed to the user; enriched/matched articles get
 * `article.match`, degraded ones prerequisite enrichment, and a full page records its continuation,
 * all in one transaction. A backfill never expands authorization: off and unselected training
 * carriers contribute nothing, and a new subscription creates no backfill.
 */
export function createCardBackfillHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'card.backfill'> {
  return async (payload) => {
    const user = await userPlan(deps.db, payload.userId);
    if (user === null || user.deleted) return;
    const held = await heldBackfillCards(deps.db, payload.userId, payload.cardIds);
    if (held.length === 0) return;
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    requireSet(config.enrich, 'enrich');
    requireSet(config.match, 'match');

    const snapshotAt =
      payload.snapshotAt === undefined ? nowOf(deps) : new Date(payload.snapshotAt);
    const processedCount = payload.processedCount ?? 0;
    const page = await backfillPage(deps.db, {
      userId: payload.userId,
      ...(payload.feedIds === undefined ? {} : { feedIds: payload.feedIds }),
      snapshotAt,
      windowDays: planLimits(user.plan).backfillDays,
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
    });
    if (page.length === 0) return;

    const articles = await loadClassificationArticles(
      deps.db,
      page.map((entry) => entry.articleId),
    );
    const cards = await loadCardInputs(
      deps.db,
      held.map((card) => card.cardId),
    );
    const work: ArticleWork[] = [];
    for (const [index, entry] of page.entries()) {
      const article = articles.get(entry.articleId);
      if (article === undefined) continue;
      const applicable = held.filter(
        (card) => card.scopeFeedId === null || entry.feedIds.includes(card.scopeFeedId),
      );
      const priority =
        processedCount + index < BACKFILL_INTERACTIVE_ARTICLES
          ? BACKFILL_PRIORITY_FIRST
          : BACKFILL_PRIORITY_REST;
      const item = await articleWork(
        deps,
        classification,
        config,
        article,
        applicable,
        cards,
        priority,
      );
      if (item !== null) work.push(item);
    }

    await retryTransaction(deps.db, async (tx) => {
      const sender = workerOutbox(tx);
      for (const item of work) {
        await upsertMatchQueue(tx, {
          articleId: item.articleId,
          revision: item.revision,
          cardIds: item.cardIds,
          priority: item.priority,
          userId: payload.userId,
        });
        if (item.kind === 'match') {
          await enqueueMatch(sender, { articleId: item.articleId }, { revision: item.revision });
        } else if (item.kind === 'enrich') {
          await enqueueEnrich(
            sender,
            {
              articleId: item.articleId,
              priority: item.priority === BACKFILL_PRIORITY_FIRST ? 'interactive' : 'bulk',
            },
            { revision: item.revision },
          );
        }
      }
      const last = page.at(-1);
      if (page.length === BACKFILL_PAGE_SIZE && last !== undefined) {
        await enqueueBackfill(
          sender,
          continuation(payload, snapshotAt, processedCount, page.length, last),
        );
      }
    });
  };
}

/**
 * The pairs an article still needs and where it goes: enriched/matched articles queue the held
 * cards without a current primary answer (an LLM or prefilter answer is re-asked) and match them;
 * a degraded article queues them and gets its prerequisite enrichment; an article still on its way
 * to enrichment only queues them (matching waits for current facets). Failed and stale articles are
 * never processed automatically.
 */
async function articleWork(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  config: ClassificationConfig,
  article: ClassificationArticle,
  applicable: readonly HeldBackfillCard[],
  cards: ReadonlyMap<string, CardInput>,
  priority: number,
): Promise<ArticleWork | null> {
  if (applicable.length === 0) return null;
  const base = { articleId: article.id, revision: article.revision, priority };
  const ids = applicable.map((card) => card.cardId);
  switch (article.pipelineState) {
    case 'enriched':
    case 'matched': {
      const match = config.match;
      if (match === null) return null;
      const input = modelInput(
        article,
        await listTranslations(deps.db, article.id, article.revision),
        config,
      );
      const state = buildState(input, 'match');
      const fingerprint = {
        articleRevision: article.revision,
        matchSetSha: match.sha256,
        stateSha256: state.sha256,
      };
      const answers = new Map(
        (await readCardAnswers(deps.db, article.id, ids)).map((a) => [a.cardId, a]),
      );
      const { primaryModel } = classification;
      const missing = ids.filter((id) => {
        const card = cards.get(id);
        const answer = answers.get(id);
        if (card === undefined) return false;
        if (answer === undefined) return true;
        const { sha256 } = builtCardQuestion(card, config.cardTextMode);
        return !(
          isCurrentCardAnswer(answer, fingerprint, sha256) && isPrimaryAnswer(answer, primaryModel)
        );
      });
      return missing.length === 0 ? null : { kind: 'match', ...base, cardIds: missing };
    }
    case 'degraded':
      return { kind: 'enrich', ...base, cardIds: ids };
    case 'extracted':
    case 'translated':
      return { kind: 'queue', ...base, cardIds: ids };
    default:
      return null;
  }
}

function continuation(
  payload: JobPayload<'card.backfill'>,
  snapshotAt: Date,
  processedCount: number,
  pageLength: number,
  last: { articleId: string; pageKey: string },
) {
  return {
    userId: payload.userId,
    cardIds: payload.cardIds,
    ...(payload.feedIds === undefined ? {} : { feedIds: payload.feedIds }),
    snapshotAt: snapshotAt.toISOString(),
    cursor: { firstSeenAt: last.pageKey, articleId: last.articleId },
    processedCount: processedCount + pageLength,
  };
}
