import type { Subscription } from '@bantoozi/shared';
import { useEffect, type ReactNode } from 'react';

import { QueryState } from '../../components/states/query-state.js';
import { useSubscriptions } from '../feeds/subscriptions.js';
import type { GoToStep } from './steps.js';

export interface GatedStepProps {
  go: GoToStep;
  children: (subscriptions: Subscription[]) => ReactNode;
}

/** The steps after the feeds need a feed: an address that skips ahead goes back to the feeds. */
export function GatedStep({ go, children }: GatedStepProps) {
  const subscriptions = useSubscriptions();
  const none = subscriptions.data !== undefined && subscriptions.data.length === 0;

  useEffect(() => {
    if (none) go('feeds', { replace: true });
  }, [none, go]);

  return (
    <QueryState query={subscriptions} isEmpty={(list) => list.length === 0} empty={null}>
      {children}
    </QueryState>
  );
}
