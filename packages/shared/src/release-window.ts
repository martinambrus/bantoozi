/** Wall-clock aligned plan releases. Stored release intervals are 60..86400 seconds; null/0 is immediate. */
export interface ReleaseWindow {
  releasedAt: Date;
  nextReleaseAt: Date | null;
}

const DAY_MS = 86400000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(instant: number, zone: string): number {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
}

/**
 * Find the last release and the next real release in the user's time zone. The candidate offsets
 * cover both sides of a daylight-saving transition. Repeated hours have two distinct releases;
 * nonexistent wall-clock boundaries are skipped. A six-hour plan remains aligned to 00/06/12/18
 * even on the five- or seven-hour window across a clock change.
 */
export function releaseWindow(now: Date, zone: string, intervalS: number | null): ReleaseWindow {
  const instant = now.getTime();
  if (!Number.isFinite(instant)) throw new RangeError('invalid release time');
  if (intervalS === null || intervalS === 0)
    return { releasedAt: new Date(instant), nextReleaseAt: null };
  if (!Number.isInteger(intervalS) || intervalS < 60 || intervalS > 86400)
    throw new RangeError('invalid release interval');
  const interval = intervalS * 1000;
  const offsets = new Set(
    [0, -2, -0.5, 0.5, 2].map((days) => {
      const probe = Math.floor((instant + days * DAY_MS) / 1000) * 1000;
      return localTime(probe, zone) - probe;
    }),
  );
  const previousWall = (wall: number) =>
    wall % DAY_MS === 0
      ? wall - DAY_MS + Math.floor((DAY_MS - 1) / interval) * interval
      : wall - interval;
  const nextWall = (wall: number) =>
    Math.min(wall + interval, (Math.floor(wall / DAY_MS) + 1) * DAY_MS);
  let released = -Infinity;
  let next = Infinity;
  for (const offset of offsets) {
    // Project into each possible offset, including the other side of a repeated hour. The next
    // instant may have an earlier wall time (02:00 after 02:45), so searching only forward in
    // the current wall clock would miss it.
    const projected = instant + offset;
    const day = Math.floor(projected / DAY_MS) * DAY_MS;
    const current = day + Math.floor((projected - day) / interval) * interval;
    let before = current;
    let after = nextWall(current);
    for (let step = 0; step <= 1441; step += 1) {
      const candidate = before - offset;
      if (candidate <= released || candidate < instant - 3 * DAY_MS) break;
      if (candidate <= instant && localTime(candidate, zone) === before) {
        released = Math.max(released, candidate);
        break;
      }
      before = previousWall(before);
    }
    for (let step = 0; step <= 1441; step += 1) {
      const candidate = after - offset;
      if (candidate >= next || candidate > instant + 3 * DAY_MS) break;
      if (candidate > instant && localTime(candidate, zone) === after) {
        next = Math.min(next, candidate);
        break;
      }
      after = nextWall(after);
    }
  }
  if (!Number.isFinite(released) || !Number.isFinite(next))
    throw new RangeError('no release boundary in the time zone');
  return { releasedAt: new Date(released), nextReleaseAt: new Date(next) };
}
