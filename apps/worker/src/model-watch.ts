import {
  retryTransaction,
  updateSettingLocked,
  workerOutbox,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import {
  EngineModelCandidateSchema,
  EngineModelWatchSchema,
  enqueueModelWatch,
  sameModelFamily,
  type EngineModelCandidate,
  type EngineModelWatch,
} from '@bantoozi/shared';

export const MODEL_CANDIDATE_KEY = 'engine.model_candidate';
export const MODEL_WATCH_KEY = 'engine.model_watch';
export const MODEL_WATCH_CONFIRM_MS = 10 * 60_000;
const MODEL_WATCH_MAX_RETRIES = 3;
const MODEL_WATCH_RETRY_MS = 60_000;
export const MODEL_WATCH_TRIGGER_GAP_MS = 10 * 60_000;

type Notice = NonNullable<EngineModelWatch['notice']>;

/** Both ids are validated concrete Jev releases; build metadata does not change precedence. */
export function isOlderSameMajorRelease(answered: string, current: string): boolean {
  const parts = (model: string) => /^jev-(\d+)\.(\d+)\.(\d+)(.*)$/.exec(model)!;
  const a = parts(answered);
  const b = parts(current);
  if (BigInt(a[1]!) !== BigInt(b[1]!)) return false;
  for (const i of [2, 3]) {
    if (BigInt(a[i]!) !== BigInt(b[i]!)) return BigInt(a[i]!) < BigInt(b[i]!);
  }
  const suffix = (value: string) => value.split('+')[0]!;
  const left = suffix(a[4]!);
  const right = suffix(b[4]!);
  if (left === right || left === '') return false;
  if (right === '') return true;
  const l = left.slice(1).split('.');
  const r = right.slice(1).split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const x = l[i];
    const y = r[i];
    if (x === y) continue;
    if (x === undefined) return true;
    if (y === undefined) return false;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y);
      continue;
    }
    if (nx !== ny) return nx;
    return x < y;
  }
  return false;
}

/** Save an observation and its first confirmation intent atomically; only an aged agreement adopts. */
export async function observeModelCandidate(
  db: Database,
  model: string,
  now: Date,
): Promise<boolean> {
  return retryTransaction(db, async (tx) => {
    let started = false;
    let confirmed = false;
    // All transactions touching both rows lock watch first, then candidate.
    await updateSettingLocked<EngineModelWatch>(tx, MODEL_WATCH_KEY, {}, (current) => ({
      ...watchStateOf(current),
      lastCheck: { at: now.toISOString(), ok: true },
    }));
    const candidate = await updateSettingLocked<EngineModelCandidate | null>(
      tx,
      MODEL_CANDIDATE_KEY,
      null,
      (current) => {
        const parsed = EngineModelCandidateSchema.safeParse(current);
        const old = parsed.success ? parsed.data : undefined;
        started = old === undefined || old.model !== model;
        const candidate = started
          ? { model, firstSeenAt: now.toISOString(), count: 1 }
          : { ...old!, count: Math.min(Number.MAX_SAFE_INTEGER, old!.count + 1) };
        confirmed =
          !started && now.getTime() - Date.parse(candidate.firstSeenAt) >= MODEL_WATCH_CONFIRM_MS;
        return candidate;
      },
    );
    if (candidate !== null && !confirmed) {
      await enqueueCandidateConfirmation(tx, candidate, now, started);
    }
    return confirmed;
  });
}

/** The caller holds the watch lock before taking the candidate lock, in this transaction. */
export async function retryModelCandidate(tx: Transaction, now: Date): Promise<void> {
  const candidate = await updateSettingLocked<EngineModelCandidate | null>(
    tx,
    MODEL_CANDIDATE_KEY,
    null,
    (current) => {
      const parsed = EngineModelCandidateSchema.safeParse(current);
      return parsed.success
        ? { ...parsed.data, count: Math.min(Number.MAX_SAFE_INTEGER, parsed.data.count + 1) }
        : null;
    },
  );
  if (candidate !== null) await enqueueCandidateConfirmation(tx, candidate, now, false);
}

async function enqueueCandidateConfirmation(
  tx: Transaction,
  candidate: EngineModelCandidate,
  now: Date,
  started: boolean,
): Promise<void> {
  if (!started && candidate.count > 1 + MODEL_WATCH_MAX_RETRIES) return;
  const due = Date.parse(candidate.firstSeenAt) + MODEL_WATCH_CONFIRM_MS;
  const availableAt = new Date(started ? due : Math.max(due, now.getTime() + MODEL_WATCH_RETRY_MS));
  await enqueueModelWatch(workerOutbox(tx, { availableAt }), {
    revision: `confirm:${candidate.model}:${candidate.firstSeenAt}:${candidate.count}`,
  });
}

/** Queues one `house.model-watch` check; a check already waiting absorbs it. */
export async function enqueueModelWatchNow(db: Database): Promise<void> {
  await retryTransaction(db, (tx) => enqueueModelWatch(workerOutbox(tx)));
}

/**
 * Claims the shared right to queue a check for an unavailable model: at most one claim per gap
 * across all processes. The claim and its outbox intent commit together.
 */
export async function requestModelWatch(
  db: Database,
  now: Date,
  options: { minGapMs?: number } = {},
): Promise<boolean> {
  const gap = options.minGapMs ?? MODEL_WATCH_TRIGGER_GAP_MS;
  return retryTransaction(db, async (tx) => {
    let claimed = false;
    await updateSettingLocked<EngineModelWatch>(tx, MODEL_WATCH_KEY, {}, (current) => {
      const state = watchStateOf(current);
      if (state.triggeredAt !== undefined) {
        const last = Date.parse(state.triggeredAt);
        if (!(now.getTime() - last >= gap)) return state;
      }
      claimed = true;
      return { ...state, triggeredAt: now.toISOString() };
    });
    if (claimed) {
      await enqueueModelWatch(workerOutbox(tx), { revision: `unavailable:${now.toISOString()}` });
    }
    return claimed;
  });
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
