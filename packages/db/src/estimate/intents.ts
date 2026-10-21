import { enqueueEstimate, type JobSender } from '@bantoozi/shared';

/**
 * Records `user.estimate` (visible-learning §4.4) when a reader action changed an explicit rating or
 * its time: rate, un-rate, prompt answer, bulk rate and the undo of any of them, but not a hide of an
 * unrated article. `changes` are the rank-relevant changes of the action (`ReaderRankChange`); the
 * intent is debounced per user and the job trains only when its inputs changed, so no threshold
 * applies.
 */
export async function recordEstimateIntent(
  outbox: JobSender,
  userId: string,
  changes: readonly { ratingValueChanged?: boolean }[],
): Promise<void> {
  if (changes.some((change) => change.ratingValueChanged === true)) {
    await enqueueEstimate(outbox, { userId });
  }
}
