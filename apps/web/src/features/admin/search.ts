import { AdminInviteStatusSchema, FeedStatusSchema } from '@bantoozi/shared';
import { z } from 'zod';

// The router reads `?q=2024` as a number, so a text from the address arrives as either.
const SearchText = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().min(1).max(200));

export const USAGE_PERIODS = [7, 14, 30, 60, 90] as const;
export const DEFAULT_USAGE_PERIOD = 30;

const UsagePeriod = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.literal(60),
  z.literal(90),
]);

export const UsageSearchSchema = z.object({ days: UsagePeriod.optional().catch(undefined) });
export const FeedsSearchSchema = z.object({
  status: FeedStatusSchema.optional().catch(undefined),
  q: SearchText.optional().catch(undefined),
});
export const UsersSearchSchema = z.object({ q: SearchText.optional().catch(undefined) });
export const LibrarySearchSchema = UsersSearchSchema;
export const InvitesSearchSchema = z.object({
  status: AdminInviteStatusSchema.optional().catch(undefined),
});
