import { z } from 'zod';

import { MODEL_NOTICE_MAX_ATTEMPTS, isConcreteJevModel } from '../../src/index.js';

const iso = z.iso.datetime({ offset: true });
const concreteJevModel = z.string().refine(isConcreteJevModel, 'not a concrete Jev release');

// Verbatim origin/main schema before JEV-8; do not derive this from the current schema.
export const EngineModelWatchSchema = z
  .object({
    triggeredAt: iso.optional(),
    lastCheck: z
      .object({ at: iso, ok: z.boolean(), error: z.string().min(1).max(200).optional() })
      .strict()
      .optional(),
    notice: z
      .object({
        from: concreteJevModel,
        to: concreteJevModel,
        at: iso,
        major: z.boolean(),
        attempts: z.number().int().min(0).max(MODEL_NOTICE_MAX_ATTEMPTS),
      })
      .strict()
      .optional(),
  })
  .strict();
