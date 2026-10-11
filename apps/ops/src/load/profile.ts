/**
 * Load profiles of `load:run` (S23, owner decision 2026-10-11).
 *
 * - realistic: a user behaves like the web app (spec 09, "Refresh and errors"): the page load lists
 *   at once; after a list or counts response with `rankingPending` the next poll is a list 5 s later,
 *   otherwise a counts poll (GET /api/v1/articles/counts) 30 s later. Independently the user opens or
 *   rates one article every 10-20 s (uniform, seeded). The p95 and backlog criteria are gated.
 * - stress: today's synthetic load, 1 list/s and 1 open-or-rate/s per user. Reported, never gated.
 */

export const LOAD_PROFILES = ['realistic', 'stress'] as const;
export type LoadProfile = (typeof LOAD_PROFILES)[number];

export function parseLoadProfile(value: string | undefined): LoadProfile {
  if (value === undefined) return 'realistic';
  if ((LOAD_PROFILES as readonly string[]).includes(value)) return value as LoadProfile;
  throw new Error(`--profile takes one of ${LOAD_PROFILES.join(', ')} (got "${value}")`);
}

export const PENDING_POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;
export const ACTION_GAP_MIN_MS = 10_000;
export const ACTION_GAP_MAX_MS = 20_000;
export const STRESS_TICK_MS = 1_000;

export type TrafficKind = 'list' | 'counts' | 'action';
export interface TrafficEvent {
  atMs: number;
  kind: TrafficKind;
}

/** mulberry32 over a seed mixed with the user index. */
function userRandom(seed: number, userIndex: number): () => number {
  let state = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(userIndex + 1, 0x85ebca6b)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Offsets (ms from the start) of one user's actions, sorted, all below `durationMs`. */
export function actionTimes(
  profile: LoadProfile,
  seed: number,
  userIndex: number,
  durationMs: number,
): number[] {
  const out: number[] = [];
  if (profile === 'stress') {
    for (let at = STRESS_TICK_MS; at < durationMs; at += STRESS_TICK_MS) out.push(at);
    return out;
  }
  const random = userRandom(seed, userIndex);
  let at = 0;
  for (;;) {
    at += Math.round(ACTION_GAP_MIN_MS + random() * (ACTION_GAP_MAX_MS - ACTION_GAP_MIN_MS));
    if (at >= durationMs) return out;
    out.push(at);
  }
}

export interface PlanOptions {
  profile: LoadProfile;
  seed: number;
  userIndex: number;
  durationMs: number;
  /** Whether the response of a list or counts request made at `atMs` carries rankingPending. */
  pendingAt: (atMs: number) => boolean;
}

/** The next poll after a response at `atMs` (realistic), or undefined past the end of the run. */
export function nextPoll(
  atMs: number,
  pending: boolean,
  durationMs: number,
): TrafficEvent | undefined {
  const next = atMs + (pending ? PENDING_POLL_MS : IDLE_POLL_MS);
  if (next >= durationMs) return undefined;
  return { atMs: next, kind: pending ? 'list' : 'counts' };
}

/** The pure plan of one user on a virtual clock (instant responses), sorted by time. */
export function planUserTraffic(options: PlanOptions): TrafficEvent[] {
  const { profile, seed, userIndex, durationMs, pendingAt } = options;
  const events: TrafficEvent[] = [];
  if (durationMs > 0) {
    if (profile === 'stress') {
      for (let at = 0; at < durationMs; at += STRESS_TICK_MS)
        events.push({ atMs: at, kind: 'list' });
    } else {
      let event: TrafficEvent | undefined = { atMs: 0, kind: 'list' };
      while (event !== undefined) {
        events.push(event);
        event = nextPoll(event.atMs, pendingAt(event.atMs), durationMs);
      }
    }
  }
  for (const atMs of actionTimes(profile, seed, userIndex, durationMs)) {
    events.push({ atMs, kind: 'action' });
  }
  // stable sort: at equal times the poll (pushed first) stays ahead of the action
  return events.sort((a, b) => a.atMs - b.atMs);
}

export interface PollAnswer {
  rankingPending: boolean;
}

export interface RunTrafficOptions {
  profile: LoadProfile;
  seed: number;
  userIndex: number;
  durationMs: number;
  list: () => Promise<PollAnswer>;
  counts: () => Promise<PollAnswer>;
  act: () => Promise<void>;
}

const sleepUntil = (deadline: number): Promise<void> => {
  const wait = deadline - Date.now();
  return wait <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, wait));
};

/**
 * Runs one user's traffic for `durationMs` on setTimeout / Date.now. The poll loop and the action
 * loop are independent and sequential within themselves (a slow response delays the next request of
 * that loop only). Resolves when the full duration has elapsed and both loops are done.
 */
export async function runUserTraffic(options: RunTrafficOptions): Promise<void> {
  const { profile, seed, userIndex, durationMs } = options;
  const start = Date.now();
  const end = start + durationMs;

  const pollLoop = async (): Promise<void> => {
    if (profile === 'stress') {
      for (let at = 0; at < durationMs; at += STRESS_TICK_MS) {
        await sleepUntil(start + at);
        await options.list();
      }
      return;
    }
    let event: TrafficEvent | undefined = { atMs: 0, kind: 'list' };
    while (event !== undefined) {
      await sleepUntil(start + event.atMs);
      const answer = await (event.kind === 'list' ? options.list() : options.counts());
      event = nextPoll(Date.now() - start, answer.rankingPending, durationMs);
    }
  };

  const actionLoop = async (): Promise<void> => {
    for (const at of actionTimes(profile, seed, userIndex, durationMs)) {
      await sleepUntil(start + at);
      await options.act();
    }
  };

  await Promise.all([pollLoop(), actionLoop()]);
  await sleepUntil(end);
}
