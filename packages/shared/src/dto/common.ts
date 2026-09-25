import { z } from 'zod';

/** Default and maximum page sizes of cursor pagination (spec 08 §1). */
export const DEFAULT_PAGE_LIMIT = 30;
export const MAX_PAGE_LIMIT = 100;

export const PageQuerySchema = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  })
  .strict();

/** `{items, nextCursor}` envelope of paginated responses (spec 08 §1). */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
}

/** ISO 8601 UTC timestamp string used in DTOs. */
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
