import {
  listNightlyLearnUsers,
  retryTransaction,
  updateSettingLocked,
  workerOutbox,
} from '@bantoozi/db';
import { buildJobIntent, parseSetting, type JobIntent } from '@bantoozi/shared';

import { enqueueStaleEstimates } from '../estimate/sweep.js';
import { ensureFingerprintRegistered, guardedRegistration } from '../learn/fingerprints.js';
import { loadLearnInputs } from '../learn/inputs.js';
import { loadRankerSettings } from '../rank/settings.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.nightly-learn' as const;
const DAY_MS = 86_400_000;
/** Users examined per page. */
export const NIGHTLY_LEARN_PAGE = 200;
/** Users active this recently get a `user.suggest` (spec 11 §6). */
export const SUGGEST_ACTIVE_DAYS = 7;
/** The suggestion like window (spec 05 §7: likes of the last 30 days). */
const SUGGEST_LIKE_WINDOW_DAYS = 30;

/**
 * `house.nightly-learn` (daily at 01:00 UTC, spec 11 §6, spec 06 §8.4): for every recently active user,
 * user with feedback in the history window, or user with any stored model, recomputes the input manifest
 * (implicit evidence, preferences, 180-day expiry included) and enqueues `user.learn` only when it
 * differs from the latest attempt's; users active in the last 7 days also get `user.suggest`, once
 * per day. Afterwards it sweeps the word estimates (spec 06 §8.6): `user.estimate` is recorded for each
 * reader whose stored model, or missing one, went stale untriggered (a rating aging out, a merge, a
 * subscription or threshold change). Records the run in `settings['house.progress']`.
 */
export function createNightlyLearnHandler(deps: WorkerDeps): QueueHandler<'house.nightly-learn'> {
  return async () => {
    const now = nowOf(deps);
    const day = now.toISOString().slice(0, 10);
    await guardedRegistration(
      () =>
        ensureFingerprintRegistered(
          deps.db,
          { settingsEnv: deps.settingsEnv, primaryModel: deps.classification?.primaryModel ?? '' },
          now,
        ),
      deps.logger,
    );
    const { config } = await loadRankerSettings(deps.db);
    // Paged by the wider of the learn history and the suggestion like window, so an active user with
    // no model still reaches `user.suggest`; learn change detection is unaffected (it uses eligibility).
    const feedbackSince = new Date(
      now.getTime() - Math.max(config.model.historyDays, SUGGEST_LIKE_WINDOW_DAYS) * DAY_MS,
    );
    const activeSince = new Date(now.getTime() - SUGGEST_ACTIVE_DAYS * DAY_MS);
    let after: string | null = null;
    let examined = 0;
    let learn = 0;
    let failed = 0;
    for (;;) {
      const page = await listNightlyLearnUsers(deps.db, {
        after,
        limit: NIGHTLY_LEARN_PAGE,
        feedbackSince,
        activeSince,
      });
      const changed = new Map<string, string>();
      for (const user of page) {
        try {
          const inputs = await loadLearnInputs(deps.db, deps, user.userId, now);
          if (inputs.modelState.latestTerminal?.metrics['inputSha'] !== inputs.inputSha)
            changed.set(user.userId, inputs.inputSha);
        } catch (err) {
          deps.logger.warn({ job: JOB, userId: user.userId, err }, 'learn check failed');
          failed += 1;
        }
      }
      await retryTransaction(deps.db, async (tx) => {
        const sender = workerOutbox(tx);
        const learnIntents: JobIntent[] = [];
        const suggestIntents: JobIntent[] = [];
        for (const user of page) {
          const inputSha = changed.get(user.userId);
          if (inputSha !== undefined) {
            learnIntents.push(
              buildJobIntent('user.learn', { userId: user.userId }, { revision: inputSha }),
            );
          }
          if (user.recentlyActive) {
            suggestIntents.push(
              buildJobIntent(
                'user.suggest',
                { userId: user.userId },
                { revision: `nightly:${day}` },
              ),
            );
          }
        }
        await sender.enqueueMany!(learnIntents);
        await sender.enqueueMany!(suggestIntents);
      });
      examined += page.length;
      learn += changed.size;
      if (page.length < NIGHTLY_LEARN_PAGE) break;
      after = page[page.length - 1]?.userId ?? null;
    }
    const estimate = await enqueueStaleEstimates(deps, { now, config });
    await retryTransaction(deps.db, (tx) =>
      updateSettingLocked(tx, 'house.progress', {}, (current) => {
        const progress = parseSetting('house.progress', current ?? {});
        return parseSetting('house.progress', {
          ...progress,
          [JOB]: { updatedAt: now.toISOString(), completedAt: now.toISOString(), version: 1 },
        });
      }),
    );
    const summary = { job: JOB, examined, learn, failed, estimate };
    if (failed > 0) deps.logger.error(summary, 'nightly learn enqueued');
    else deps.logger.info(summary, 'nightly learn enqueued');
    if (failed > 0 && failed === examined) {
      throw new Error('All examined users failed nightly learn');
    }
  };
}
