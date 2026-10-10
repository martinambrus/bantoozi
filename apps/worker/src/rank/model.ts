import {
  loadActiveUserModel,
  loadLearnConsent,
  loadRankCards,
  readRatingFingerprint,
  type ActiveModelRow,
  type Executor,
} from '@bantoozi/db';
import {
  FEATURE_SPEC_V1_SHA,
  itemFeatures,
  scoreModel,
  type ActiveModel,
  type HeldCard,
  type StoredModel,
  type UserRankContext,
} from '@bantoozi/ranker';
import type { RankerConfig } from '@bantoozi/shared';

import { currentContextSha } from '../learn/inputs.js';

/** The user's active model and whether its stored context is still the current one (spec 06 §8.1). */
export type RankModelState =
  | { status: 'none' }
  | { status: 'stale' }
  | { status: 'current'; row: ActiveModelRow; stored: ScoringModel; contextSha: string };

type ScoringModel = Pick<
  StoredModel,
  'features' | 'weights' | 'scaler' | 'intercept' | 'platt' | 'ownInputs'
>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const numbers = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (v as number[])
    : null;

/** The stored row as a scoring model, or null when its layout is not the one `user.learn` writes. */
function parseScoringModel(row: ActiveModelRow): ScoringModel | null {
  const { weights, scaler, calibration, metrics } = row;
  if (!isRecord(weights) || !isRecord(scaler) || !isRecord(calibration)) return null;
  const features = weights['features'];
  const w = numbers(weights['weights']);
  const mean = numbers(scaler['mean']);
  const scale = numbers(scaler['scale']);
  if (!Array.isArray(features) || !features.every((f) => typeof f === 'string')) return null;
  if (w === null || mean === null || scale === null) return null;
  if (w.length !== features.length || mean.length !== w.length || scale.length !== w.length) {
    return null;
  }
  const a = calibration['a'];
  const b = calibration['b'];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  const own = metrics['ownInputs'];
  const ownInputs = Array.isArray(own)
    ? own.flatMap((entry) =>
        isRecord(entry) && typeof entry['cardId'] === 'string' ? [entry['cardId']] : [],
      )
    : [];
  return {
    features: features as string[],
    weights: w,
    scaler: { mean, scale },
    intercept: row.intercept,
    platt: { a, b },
    ownInputs,
  };
}

/**
 * Loads the active model and checks its stored context against the current one, computed by the
 * same `currentContextSha` `user.learn` uses (spec 06 §7 step 1, §8.1). `hashes` are the held
 * cards' current question hashes.
 */
export async function loadRankModelState(
  db: Executor,
  input: { userId: string; config: RankerConfig; hashes: ReadonlyMap<string, string> },
): Promise<RankModelState> {
  const row = await loadActiveUserModel(db, input.userId);
  if (row === null) return { status: 'none' };
  const stored = parseScoringModel(row);
  const storedSha = row.metrics['contextSha'];
  if (
    stored === null ||
    typeof storedSha !== 'string' ||
    row.featureSpecSha !== FEATURE_SPEC_V1_SHA
  ) {
    return { status: 'stale' };
  }
  const cards = await loadRankCards(db, input.userId);
  const held: HeldCard[] = cards.flatMap((card) => {
    const cardInputSha256 = input.hashes.get(card.cardId);
    return cardInputSha256 === undefined
      ? []
      : [
          {
            cardId: card.cardId,
            strength: card.strength,
            scopeFeedId: card.scopeFeedId,
            cardInputSha256,
          },
        ];
  });
  const contextSha = currentContextSha(
    {
      ratingSha: await readRatingFingerprint(db),
      config: input.config,
      consent: await loadLearnConsent(db, input.userId),
      held,
    },
    row.featureSpecSha,
    stored.ownInputs,
  );
  return contextSha === storedSha
    ? { status: 'current', row, stored, contextSha }
    : { status: 'stale' };
}

/**
 * The `ActiveModel` of a current model state for the run's context (spec 06 §2 step 4a, §6.2):
 * `itemFeatures` through `scoreModel`; a contribution's label is the current title of its card.
 */
export function buildActiveModel(
  state: Extract<RankModelState, { status: 'current' }>,
  ctx: Pick<UserRankContext, 'cards' | 'config'>,
): ActiveModel {
  const titles = new Map(ctx.cards.map((card) => [card.cardId, card.title]));
  const labelOf = (feature: string): string => {
    const match = /^(?:known\.)?card\.(\d+)$/.exec(feature);
    return (match?.[1] === undefined ? undefined : titles.get(match[1])) ?? feature;
  };
  return {
    version: state.row.version,
    score(item, now) {
      const x = itemFeatures(ctx.cards, item, now, ctx.config, state.stored.ownInputs);
      const scored = scoreModel(state.stored, x);
      if (scored === null) return null;
      return {
        p: scored.p,
        top: scored.contributions.map(({ feature, contribution }) => ({
          feature,
          label: labelOf(feature),
          contribution,
        })),
      };
    },
  };
}
