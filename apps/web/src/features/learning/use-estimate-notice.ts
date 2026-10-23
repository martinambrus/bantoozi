import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { useApi } from '../../api/context.js';
import { useAccountId } from '../../session/context.js';
import { useSettledActions } from '../reader/actions/provider.js';
import {
  INITIAL_ESTIMATE_RUN,
  armEstimateRun,
  dismissEstimateRun,
  expireEstimateRun,
  observeEstimateRun,
  type EstimateNotice,
  type EstimateRunState,
} from './estimate-run.js';
import { learningQueryOptions } from './use-learning.js';

const POLL_MS = 5000;

type Event =
  | { type: 'arm'; now: number }
  | { type: 'expire'; now: number }
  | { type: 'dismiss' }
  | { type: 'observe'; estimates: Parameters<typeof observeEstimateRun>[1]; now: number };

function reduce(state: EstimateRunState, event: Event): EstimateRunState {
  switch (event.type) {
    case 'arm':
      return armEstimateRun(state, event.now);
    case 'expire':
      return expireEstimateRun(state, event.now);
    case 'dismiss':
      return dismissEstimateRun(state);
    case 'observe':
      return observeEstimateRun(state, event.estimates, event.now);
  }
}

export interface EstimateNoticeControl {
  notice: EstimateNotice | null;
  /** The reader rated: ask for the model's refresh for the next minute. */
  arm: () => void;
  dismiss: () => void;
}

/**
 * Watches for the refresh of the estimated rows that follows the reader's own ratings (design
 * 4.5): polls `GET /me/learning` only while waiting for it, in a visible, online tab.
 */
export function useEstimateNoticeState(): EstimateNoticeControl {
  const api = useApi();
  const accountId = useAccountId();
  const [state, dispatch] = useReducer(reduce, INITIAL_ESTIMATE_RUN);
  const { armedUntil, notice } = state;
  const waiting = armedUntil !== null;
  // Asking at once gives the status the refresh will be compared with before it can finish.
  const query = useQuery({
    ...learningQueryOptions(api, accountId),
    enabled: waiting,
    refetchInterval: waiting ? POLL_MS : false,
  });
  const { data, dataUpdatedAt } = query;

  useEffect(() => {
    if (data === undefined) return;
    dispatch({ type: 'observe', estimates: data.estimates, now: Date.now() });
  }, [data, dataUpdatedAt]);

  useEffect(() => {
    if (armedUntil === null) return;
    const timer = setTimeout(
      () => dispatch({ type: 'expire', now: Date.now() }),
      Math.max(0, armedUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [armedUntil]);

  const arm = useCallback(() => dispatch({ type: 'arm', now: Date.now() }), []);
  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), []);

  useSettledActions((handle, result) => {
    if (result.status !== 'done') return;
    const { action } = handle;
    if (action.type === 'promptAnswer' || (action.type === 'rate' && action.rating !== null)) {
      arm();
    }
  });

  return useMemo(() => ({ notice, arm, dismiss }), [notice, arm, dismiss]);
}
