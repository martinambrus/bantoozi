import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

export type Countdown =
  { unit: 'expired' } | { unit: 'soon' } | { unit: 'minutes' | 'hours' | 'days'; count: number };

/**
 * How long a rule has left, rounded up to the unit that fits: a rule made for three days never reads
 * "2 days" a moment later, and 23 hours and a half read "1 day" rather than "24 hours".
 */
export function countdown(expiresAt: string, now: number): Countdown {
  const remaining = Date.parse(expiresAt) - now;
  if (remaining <= 0) return { unit: 'expired' };
  if (remaining < MINUTE_MS) return { unit: 'soon' };
  const minutes = Math.ceil(remaining / MINUTE_MS);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.ceil(hours / 24) };
}

/** The current time, read again every `intervalMs` and when the tab comes back into view. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const read = () => setNow(Date.now());
    const timer = setInterval(read, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}
