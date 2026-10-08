import { useEffect, useState } from 'react';

import { isApiError } from '../../api/errors.js';
import { useOnline } from '../../components/states/use-online.js';

/** The part of a TanStack query result that tells whether it lacks data for want of a connection. */
export interface ConnectionProbe {
  data: unknown;
  status: 'pending' | 'error' | 'success';
  error: unknown;
}

/**
 * Whether a query has no data because there is no connection: the browser reports none, or the
 * request failed before it reached the server. It stays true while another attempt runs, which
 * resets the query to pending, so that what is shown for the lost connection does not give way to
 * a spinner for as long as the attempt takes.
 */
export function useLostConnection({ data, status, error }: ConnectionProbe): boolean {
  const online = useOnline();
  const unreachable = status === 'error' && isApiError(error) && error.kind === 'network';
  const down = data === undefined && (!online || unreachable);
  const [lost, setLost] = useState(down);
  const now = data === undefined && (down || (status !== 'error' && lost));
  if (now !== lost) setLost(now);
  return now;
}

/** Calls `retry` whenever the browser reports a connection again, while `active`. */
export function useReconnect(active: boolean, retry: () => void): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [active, retry]);
}
