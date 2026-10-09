import { useCallback, useRef, useState } from 'react';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { quotaDetails, type QuotaDetails } from '../../components/error-message.js';
import { useSession } from '../../session/context.js';
import { displayTitle } from '../feeds/folders.js';
import { useSubscriptionsCache } from '../feeds/subscriptions.js';

export type RowStatus = 'waiting' | 'adding' | 'added' | 'existing' | 'failed' | 'skipped';

/** Why an address could not be added when it is not an API error: it needs a choice of feed. */
export const NEEDS_CHOICE = 'needs-choice';

export interface ImportRow {
  url: string;
  status: RowStatus;
  /** The feed's name, once it is subscribed. */
  title?: string;
  /** An `ApiError`, or `NEEDS_CHOICE`. */
  error?: unknown;
}

export interface BundleRun {
  rows: ImportRow[];
  running: boolean;
  /** The plan limit that ended the run early, if one did. */
  quota: QuotaDetails | null;
}

/**
 * Adds the addresses of a bundle one after the other, each as its own subscription request with no
 * folder, and records the outcome per address. A plan limit ends the run; any other failure only
 * fails its own address. So does the end of the sign-in that started it: the requests after that
 * would go out with the cookie of whoever signs in next. Every feed starts with classification Off.
 */
export function useBundleImport() {
  const session = useSession();
  const subscribe = useApiMutation(routes.subscriptionsCreate);
  const cache = useSubscriptionsCache();
  const [runs, setRuns] = useState<Readonly<Record<string, BundleRun>>>({});
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  const { mutateAsync } = subscribe;

  const add = useCallback(
    async (bundleId: string, urls: readonly string[]) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(true);
      const signIn = session.currentSignIn();
      const known = new Set(cache.known()?.map((subscription) => subscription.feed.id));
      const rows: ImportRow[] = urls.map((url) => ({ url, status: 'waiting' }));
      let quota: QuotaDetails | null = null;
      const publish = (isRunning: boolean) => {
        setRuns((all) => ({
          ...all,
          [bundleId]: { rows: rows.map((row) => ({ ...row })), running: isRunning, quota },
        }));
      };

      publish(true);
      try {
        for (const row of rows) {
          if (quota !== null || session.currentSignIn() !== signIn) {
            row.status = 'skipped';
            continue;
          }
          row.status = 'adding';
          publish(true);
          try {
            const result = await mutateAsync({ body: { url: row.url } });
            if ('status' in result) {
              row.status = 'failed';
              row.error = NEEDS_CHOICE;
            } else {
              const { subscription } = result;
              row.status = known.has(subscription.feed.id) ? 'existing' : 'added';
              row.title = displayTitle(subscription);
              known.add(subscription.feed.id);
            }
          } catch (error) {
            row.status = 'failed';
            row.error = error;
            quota = quotaDetails(error);
          }
        }
      } finally {
        busy.current = false;
        setRunning(false);
        publish(false);
        void cache.refresh();
      }
    },
    [cache, mutateAsync, session],
  );

  return { runs, running, add };
}
