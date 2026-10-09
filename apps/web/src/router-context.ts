import type { Me } from '@bantoozi/shared';
import type { QueryClient } from '@tanstack/react-query';

/** What every route's `beforeLoad` and loader receive (spec 09 §1, §2). */
export interface RouterContext {
  queryClient: QueryClient;
  /** The signed-in account from `GET /me`, or null when signed out. */
  loadMe: () => Promise<Me | null>;
}
