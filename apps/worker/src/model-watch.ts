import {
  retryTransaction,
  updateSettingLocked,
  workerOutbox,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import {
  EngineModelWatchSchema,
  enqueueModelWatch,
  sameModelFamily,
  type EngineModelWatch,
} from '@bantoozi/shared';

export const MODEL_WATCH_KEY = 'engine.model_watch';

type Notice = NonNullable<EngineModelWatch['notice']>;

/** Queues one `house.model-watch` check; a check already waiting absorbs it. */
export async function enqueueModelWatchNow(db: Database): Promise<void> {
  await retryTransaction(db, (tx) => enqueueModelWatch(workerOutbox(tx)));
}

/** The stored watch state; a malformed row reads as empty. */
export function watchStateOf(current: unknown): EngineModelWatch {
  const parsed = EngineModelWatchSchema.safeParse(current);
  return parsed.success ? parsed.data : {};
}

/**
 * Records that the alias moved `from` to `to` and the admins are still to be told. A notice already
 * pending is merged: the earliest `from`, the latest `to`, `major` once any step changed major. A
 * chain that ends where it began leaves no notice.
 */
export async function writePendingNotice(
  tx: Transaction,
  change: { from: string; to: string },
  now: Date,
): Promise<void> {
  await updateSettingLocked<EngineModelWatch>(tx, MODEL_WATCH_KEY, {}, (current) => {
    const state = watchStateOf(current);
    const { notice: old, ...rest } = state;
    const from = old?.from ?? change.from;
    if (from === change.to) return rest;
    const major = (old?.major ?? false) || !sameModelFamily(old?.to ?? change.from, change.to);
    const notice: Notice = {
      from,
      to: change.to,
      at: now.toISOString(),
      major,
      attempts: 0,
    };
    return { ...rest, notice };
  });
}

/** The upgrade mail for a notice (subject and plain text). */
export function upgradeMail(notice: Pick<Notice, 'from' | 'to' | 'major'>): {
  subject: string;
  text: string;
} {
  const { from, to, major } = notice;
  const lead = major
    ? `Jev ${from} → ${to}: major change: personal models restart from new ratings.`
    : `Jev ${from} → ${to}: ratings and personal models kept.`;
  const body = [
    'Workers restart to use the new release.',
    'Recent articles are analysed again with it.',
    'An alias upgrade gets no evaluation replay; replay the golden set by hand if you want one.',
  ].join(' ');
  return {
    subject: major
      ? `[Bantoozi] Jev major update: ${from} → ${to}`
      : `[Bantoozi] Jev updated: ${from} → ${to}`,
    text: `${lead}\n\n${body}\n`,
  };
}
