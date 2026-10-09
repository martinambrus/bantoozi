import { z } from 'zod';

import { SCOPED_LANES } from './lanes.js';

/** The search of the feed, folder and label routes: the lane to narrow the view to, `all` if absent. */
export const ScopedSearchSchema = z.object({
  lane: z.enum(SCOPED_LANES).optional().catch(undefined),
});
