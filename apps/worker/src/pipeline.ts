import {
  enqueueCluster,
  enqueueEnrich,
  enqueueExtract,
  enqueueMatch,
  enqueueRank,
  enqueueTranslate,
  type JobSender,
} from '@bantoozi/shared';

/**
 * The single place that decides an article's next stage (spec 03 §1). Every stage handler ends with
 * `after(stage, articleId, outcome, context)` inside its own transaction: the next stage is recorded
 * as an outbox intent through `context.sender` (the transaction's outbox writer), so a rollback
 * produces no job and a commit never loses one (spec 03 §2.1).
 *
 *   fetch → extract → [demand gate] → translate (only if required) → enrich → cluster + match → rank
 */
export const STAGES = [
  'fetch',
  'extract',
  'translate',
  'enrich',
  'cluster',
  'match',
  'rank',
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * How a stage ended, for the content revision it processed (the dedupe fingerprint of the next
 * intent). `failed` is a terminal failure after the stage's bounded retries; `degraded` and
 * `invalid_request` are enrichment's engine-unavailable and question-set-bug outcomes.
 * `clusterChanged` is the cluster stage's report that the article joined or moved story clusters,
 * a merge included (spec 05 §6).
 */
export type StageOutcome =
  | { status: 'ok'; revision: string; clusterChanged?: boolean }
  | { status: 'failed'; revision: string }
  | { status: 'degraded'; revision: string }
  | { status: 'invalid_request'; revision: string };

/** The demand a newly inserted `feed_items` association creates (spec 03 §7). */
export interface NewCarrierDemand {
  /** The article's current `content_revision` and `pipeline_state`. */
  revision: string;
  pipelineState: string;
  /** An active subscription of this feed admits automatic inference for the new association. */
  createsDemand: boolean;
  /** Cards admitted through this carrier that still lack a current primary answer. */
  missingCardIds: readonly string[];
  /** The feed's subscribers: each gets an incremental rank. */
  subscriberIds: readonly string[];
}

/** Demand and routing facts, answered from the database inside the handler's transaction. */
export interface PipelineGate {
  /** `eligibleInferenceDemand(articleId, tx)` (spec 03 §1.1): no demand stops at the local stage. */
  hasInferenceDemand(articleId: string): Promise<boolean>;
  /** Whether the article's language mode requires translation before enrichment (spec 07 §1). */
  needsTranslation(articleId: string): Promise<boolean>;
  /**
   * Users whose ranking changed: matched users, every subscriber after a degraded enrichment, or,
   * after a cluster membership change, every user whose window holds a member of the article's
   * story cluster.
   */
  usersToRank(articleId: string, after: 'enrich' | 'match' | 'cluster'): Promise<readonly string[]>;
  /** The demand of a newly inserted association of `articleId` with `feedId`; null when gone. */
  newCarrierDemand(articleId: string, feedId: string): Promise<NewCarrierDemand | null>;
  /** Queue the current questions of `cardIds` at `revision` (`match_queue`, spec 05 §5.3). */
  queueMatch(articleId: string, revision: string, cardIds: readonly string[]): Promise<void>;
}

export interface PipelineContext {
  sender: JobSender;
  gate: PipelineGate;
}

/** The stages that may follow `stage` (for documentation and tests of the order). */
export const NEXT_STAGES: Readonly<Record<Stage, readonly Stage[]>> = {
  fetch: ['extract'],
  extract: ['translate', 'enrich'],
  translate: ['enrich'],
  enrich: ['cluster', 'match', 'rank'],
  cluster: ['rank'],
  match: ['rank'],
  rank: [],
};

export async function after(
  stage: Stage,
  articleId: string,
  outcome: StageOutcome,
  context: PipelineContext,
): Promise<void> {
  const { sender, gate } = context;
  const revision = { revision: outcome.revision };
  switch (stage) {
    case 'fetch':
      // A new, non-stale article from ingest: extraction runs for reading and saved content.
      await enqueueExtract(sender, { articleId }, revision);
      return;
    case 'extract':
      // A failed extraction continues without a body; without inference demand the article stops.
      if (!(await gate.hasInferenceDemand(articleId))) return;
      if (await gate.needsTranslation(articleId)) {
        await enqueueTranslate(sender, { articleId }, revision);
      } else {
        await enqueueEnrich(sender, { articleId }, revision);
      }
      return;
    case 'translate':
      // Both tiers failing still enriches, with the native text.
      if (!(await gate.hasInferenceDemand(articleId))) return;
      await enqueueEnrich(sender, { articleId }, revision);
      return;
    case 'enrich':
      if (outcome.status === 'ok') {
        if (!(await gate.hasInferenceDemand(articleId))) return;
        await enqueueCluster(sender, { articleId }, revision);
        await enqueueMatch(sender, { articleId }, revision);
        return;
      }
      // Degraded or failed enrichment: no match; every subscriber is ranked (BM25 where authorized).
      for (const userId of await gate.usersToRank(articleId, 'enrich')) {
        await enqueueRank(sender, { userId, reason: 'degraded' });
      }
      return;
    case 'match':
      for (const userId of await gate.usersToRank(articleId, 'match')) {
        await enqueueRank(sender, { userId, reason: 'match' });
      }
      return;
    case 'cluster':
      // Membership is a ranking input (read stories, mute-story rules), and match may already have
      // ranked the article: a changed membership re-ranks every affected user in full (spec 06 §7).
      if (outcome.status !== 'ok' || outcome.clusterChanged !== true) return;
      for (const userId of await gate.usersToRank(articleId, 'cluster')) {
        await enqueueRank(sender, { userId, reason: 'cluster', full: true });
      }
      return;
    case 'rank':
      return;
  }
}

/**
 * A feed newly carrying an article (spec 03 §7): a newly inserted `feed_items` row, from ingestion,
 * the extraction merge or the feed merge. The feed's subscribers always get an incremental rank
 * (stale and failed articles need no paid stage to become readable); then the article continues
 * from its state for the new association's own eligible demand only (activation time and
 * generation checked; `feed_cards` alone never authorizes a historical arrival):
 * - enriched/matched: queue the admitted cards that lack current answers, then match them;
 * - extracted/translated (it stopped at the demand gate): the next stage through `after`;
 * - degraded: enrichment, as `house.rescore-degraded` would — never straight to matching;
 * - ingested/stale/failed: nothing more (extraction applies the demand gate itself; stale and
 *   failed articles are not processed automatically).
 */
export async function afterNewCarrier(
  articleId: string,
  feedId: string,
  context: PipelineContext,
): Promise<void> {
  const { sender, gate } = context;
  const demand = await gate.newCarrierDemand(articleId, feedId);
  if (demand === null) return;
  for (const userId of demand.subscriberIds) {
    await enqueueRank(sender, { userId, reason: 'ingest' });
  }
  const ok: StageOutcome = { status: 'ok', revision: demand.revision };
  switch (demand.pipelineState) {
    case 'enriched':
    case 'matched':
      if (demand.missingCardIds.length === 0) return;
      await gate.queueMatch(articleId, demand.revision, demand.missingCardIds);
      await enqueueMatch(sender, { articleId }, { revision: demand.revision });
      return;
    case 'extracted':
      if (demand.createsDemand) await after('extract', articleId, ok, context);
      return;
    case 'translated':
      if (demand.createsDemand) await after('translate', articleId, ok, context);
      return;
    case 'degraded':
      if (demand.createsDemand) {
        await enqueueEnrich(sender, { articleId }, { revision: demand.revision });
      }
      return;
    default:
      return;
  }
}
