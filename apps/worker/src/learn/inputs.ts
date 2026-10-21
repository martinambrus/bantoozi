import {
  loadCardInputs,
  loadLearnConsent,
  loadLearnSamples,
  loadRankCards,
  loadModelState,
  readRatingFingerprintState,
  type RatingFingerprint,
  type Executor,
  type LearnSample,
} from '@bantoozi/db';
import {
  FEATURE_SPEC_V1_SHA,
  modelContextSha,
  compareSamples,
  sampleEligibility,
  eligibleSetSha,
  eligibilityOf,
  type Consent,
  type HeldCard,
  type ReadonlyRankerConfig,
  type TrainingSample,
} from '@bantoozi/ranker';
import type { RankerConfig } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';

import { loadClassificationConfig, ratingDefaults } from '../classify/config.js';
import type { WorkerDeps } from '../handlers/deps.js';
import { cardInputHashes } from '../rank/items.js';
import { loadRankerSettings } from '../rank/settings.js';

/** Everything one learn step reads about a user at one instant (spec 06 §8.4 step 1). */
export interface LearnInputs {
  now: Date;
  ratingSha: string;
  familySha: string;
  /** The sha to family map eligibility used; empty in strict mode. */
  families: Record<string, string>;
  /** The latest attempt marked this exact sha strict: only rows carrying it are eligible. */
  strict: boolean;
  /** Whether the current exact sha is in the registry. */
  registered: boolean;
  fingerprint: RatingFingerprint;
  modelState: Awaited<ReturnType<typeof loadModelState>>;
  config: RankerConfig;
  consent: Consent;
  samples: LearnSample[];
  eligible: LearnSample[];
  cutoffEventId: string | null;
  held: HeldCard[];
  eligibleSetSha: string;
  inputSha: string;
}

/**
 * Loads the user's samples, rating fingerprint, held cards with their current input hashes, ranker
 * settings and behavioral consent, and the `inputSha` over the eligible set, fingerprint, feature
 * spec, the held cards that appear in an eligible snapshot, the config and the consent (spec 06
 * §8.4). A held card no snapshot mentions cannot become an own input, so it does not change it.
 */
export async function loadLearnInputs(
  db: Executor,
  deps: Pick<WorkerDeps, 'settingsEnv' | 'classification'>,
  userId: string,
  now: Date,
): Promise<LearnInputs> {
  const config = (await loadRankerSettings(db)).config;
  const { samples, cutoffEventId } = await loadLearnSamples(db, { userId, now });
  const consent: Consent = await loadLearnConsent(db, userId);

  const classification = await loadClassificationConfig(db, deps.settingsEnv);
  const state = await readRatingFingerprintState(
    db,
    ratingDefaults(classification, deps.classification?.primaryModel ?? ''),
  );
  const { sha: ratingSha, familySha } = state;
  const fingerprint: RatingFingerprint = {
    sha: state.sha,
    familySha: state.familySha,
    settings: state.settings,
  };
  const modelState = await loadModelState(db, userId);
  const strict = modelState.latestTerminal?.metrics['strictRatingSha'] === ratingSha;
  const families = strict ? {} : state.families;
  const cards = await loadRankCards(db, userId);
  const cardInputs = await loadCardInputs(
    db,
    cards.map((card) => card.cardId),
  );
  const hashes = cardInputHashes(cardInputs, classification);
  const held: HeldCard[] = cards.flatMap((card) => {
    const cardInputSha256 = hashes.get(card.cardId);
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

  const opts = eligibilityOf({ now, config, ratingSha, familySha, families });
  const training = samples as unknown as TrainingSample[];
  const eligible = samples.filter((_, i) => sampleEligibility(training[i]!, opts).ok);
  const setSha = eligibleSetSha(training, opts);
  const inSnapshots = new Set(eligible.flatMap((s) => s.features?.cards.map((c) => c.id) ?? []));
  const manifest = canonicalSha256(
    [...eligible]
      .sort((a, b) => compareSamples(a as TrainingSample, b as TrainingSample))
      .map((s) => ({
        articleId: s.articleId,
        eventId: s.eventId,
        signal: s.signal,
        y: s.y,
        weight: s.weight,
        explicit: s.explicit,
        groupId: s.groupId,
        features: canonicalSha256({ ...s.features, snapshotAt: null }),
      })),
  );
  const inputSha = canonicalSha256({
    eligibleManifest: manifest,
    ratingSha,
    familySha,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    cards: held.filter((card) => inSnapshots.has(card.cardId)),
    strengthWeights: config.strengthWeights,
    model: config.model,
    consent,
  });
  return {
    now,
    ratingSha,
    familySha,
    families,
    strict,
    registered: state.registered,
    fingerprint,
    modelState,
    config,
    consent,
    samples,
    eligible,
    cutoffEventId,
    held,
    eligibleSetSha: setSha,
    inputSha,
  };
}

/** The model context (spec 06 §8.1) the current state implies for the own inputs `ownIds`. */
export function currentContextSha(
  inputs: Pick<LearnInputs, 'familySha' | 'consent' | 'held'> & { config: ReadonlyRankerConfig },
  featureSpecSha: string,
  ownIds: readonly string[],
): string {
  const own = new Set(ownIds);
  return modelContextSha({
    familySha: inputs.familySha,
    featureSpecSha,
    strengthWeights: inputs.config.strengthWeights,
    modelConfig: inputs.config.model,
    consent: inputs.consent,
    ownInputs: inputs.held.filter((card) => own.has(card.cardId)),
  });
}
