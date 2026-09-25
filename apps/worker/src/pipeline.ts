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
 */
export type StageOutcome =
  | { status: 'ok'; revision: string }
  | { status: 'failed'; revision: string }
  | { status: 'degraded'; revision: string }
  | { status: 'invalid_request'; revision: string };

/** Demand and routing facts the later milestones implement against the database (specs 03, 05, 07). */
export interface PipelineGate {
  /** `eligibleInferenceDemand(articleId, tx)` (spec 03 §1.1): no demand stops at the local stage. */
  hasInferenceDemand(articleId: string): Promise<boolean>;
  /** Whether the article's language mode requires translation before enrichment (spec 07 §1). */
  needsTranslation(articleId: string): Promise<boolean>;
  /** Users whose ranking changed: matched users, or every subscriber after a degraded enrichment. */
  usersToRank(articleId: string, after: 'enrich' | 'match'): Promise<readonly string[]>;
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
  cluster: [],
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
    case 'rank':
      return;
  }
}
