/** A worker is live for three 30-second heartbeat periods (specs 08 §9.1, 10 §2.1, 11 §2). */
export const HEARTBEAT_FRESH_MS = 90_000;

/** A finite timestamp within three heartbeat periods, allowing bounded clock skew both ways. */
export function isHeartbeatFresh(at: number, now: Date): boolean {
  return Number.isFinite(at) && Math.abs(now.getTime() - at) <= HEARTBEAT_FRESH_MS;
}
