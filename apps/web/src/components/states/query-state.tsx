import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { quotaDetails } from '../error-message.js';
import { EmptyState } from './empty-state.js';
import { ErrorState } from './error-state.js';
import { LoadingState } from './loading-state.js';
import { OfflineState } from './offline-state.js';
import { QuotaLimitState } from './quota-limit-state.js';
import { useOnline } from './use-online.js';

/** The part of a TanStack `useQuery` result that decides what is shown. */
export interface QueryStateSource<T> {
  data: T | undefined;
  error: unknown;
  status: 'pending' | 'error' | 'success';
  refetch: () => unknown;
}

export interface QueryStateProps<T> {
  query: QueryStateSource<T>;
  isEmpty?: ((data: T) => boolean) | undefined;
  /** Replaces the default empty state. */
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * The screen states of one query (spec 09 §1). Data on hand always wins, so a failed refetch or a
 * lost connection never hides what the user is reading.
 */
export function QueryState<T>({ query, isEmpty, empty, children }: QueryStateProps<T>) {
  const { t } = useTranslation('common');
  const online = useOnline();
  const retry = () => {
    void query.refetch();
  };

  if (query.data !== undefined) {
    if (isEmpty?.(query.data) === true) {
      return empty === undefined ? <EmptyState title={t('states.emptyTitle')} /> : empty;
    }
    return children(query.data);
  }

  if (query.status === 'error') {
    const quota = quotaDetails(query.error);
    if (quota !== null) return <QuotaLimitState {...quota} />;
    const lostConnection = !online || (isApiError(query.error) && query.error.kind === 'network');
    if (lostConnection) return <OfflineState onRetry={retry} />;
    return <ErrorState error={query.error} onRetry={retry} />;
  }

  // Offline, TanStack pauses the fetch and the query stays pending: say so instead of spinning.
  return online ? <LoadingState /> : <OfflineState onRetry={retry} />;
}
