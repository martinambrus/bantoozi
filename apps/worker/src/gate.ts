import {
  articleLanguage,
  carrierSubscriberIds,
  hasInferenceDemand,
  newCarrierDemand,
  readStoredSetting,
  storySubscriberIds,
  upsertMatchQueue,
  type Transaction,
} from '@bantoozi/db';
import { readSetting, type SettingEnvDefaults } from '@bantoozi/shared';

import type { PipelineGate } from './pipeline.js';

/**
 * The pipeline's demand and routing facts, answered from the database inside the handler's own
 * transaction (spec 03 §1.1, spec 07 §1), so a stage decision and its outbox intent commit together.
 */
export function createPipelineGate(tx: Transaction, env: SettingEnvDefaults): PipelineGate {
  return {
    hasInferenceDemand: (articleId) => hasInferenceDemand(tx, articleId),
    async needsTranslation(articleId) {
      // Translation needs `modes[article.lang] === 'translate'` (spec 07 §1); demand is the gate's
      // separate check. An unknown language is never translated as if it were English.
      const lang = await articleLanguage(tx, articleId);
      if (lang === null || lang === 'und') return false;
      const modes = readSetting(
        'language_modes',
        await readStoredSetting(tx, 'language_modes'),
        env,
      );
      return modes?.[lang] === 'translate';
    },
    usersToRank: (articleId, after) =>
      after === 'cluster' ? storySubscriberIds(tx, articleId) : carrierSubscriberIds(tx, articleId),
    async newCarrierDemand(articleId, feedId) {
      const demand = await newCarrierDemand(tx, articleId, feedId);
      return demand === null
        ? null
        : {
            revision: demand.revision,
            pipelineState: demand.pipelineState,
            createsDemand: demand.createsDemand,
            missingCardIds: demand.missingCardIds,
            subscriberIds: demand.subscriberIds,
          };
    },
    async queueMatch(articleId, revision, cardIds) {
      await upsertMatchQueue(tx, { articleId, revision, cardIds });
    },
  };
}
