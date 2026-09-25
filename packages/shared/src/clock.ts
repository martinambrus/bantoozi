/** Injectable time source: code that depends on time receives a Clock (spec 01 §5). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A controllable clock for deterministic tests. */
export interface ManualClock extends Clock {
  set(at: Date | string | number): void;
  advance(ms: number): Date;
}

export function createManualClock(start: Date | string | number = 0): ManualClock {
  let current = new Date(start).getTime();
  if (!Number.isFinite(current)) throw new RangeError('invalid start time');
  return {
    now: () => new Date(current),
    set(at) {
      const t = new Date(at).getTime();
      if (!Number.isFinite(t)) throw new RangeError('invalid time');
      current = t;
    },
    advance(ms) {
      if (!Number.isFinite(ms)) throw new RangeError('invalid duration');
      current += ms;
      return new Date(current);
    },
  };
}

/** UTC calendar day `YYYY-MM-DD` of an instant (budget days, metrics keys). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
