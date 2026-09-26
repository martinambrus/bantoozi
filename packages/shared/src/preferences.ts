import { z } from 'zod';

/** Reader preferences stored in `users.preferences` (spec 08 §3.1); defaults are applied on read. */
export const TriSchema = z.enum(['auto', 'on', 'off']);
export type Tri = z.infer<typeof TriSchema>;

export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME_LENGTH = 100;

const FolderNameSchema = z.string().trim().min(1).max(MAX_FOLDER_NAME_LENGTH);
const IsoTimestampSchema = z.iso.datetime({ offset: true });

const fields = {
  defaultTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  hideEverything: z.boolean(),
  simpleMode: z.boolean(),
  sort: z.enum(['score', 'date']),
  markReadOnExpand: z.boolean(),
  markReadOnRate: z.boolean(),
  feedbackPrompt: z.enum(['often', 'occasionally', 'never']),
  exampleSuggestions: z.boolean(),
  demote: {
    clickbait: TriSchema,
    promotional: TriSchema,
    shallow: TriSchema,
    stale: TriSchema,
  },
  implicitNegative: z.boolean(),
  swipe: {
    left: z.enum(['dislike', 'read', 'none']),
    right: z.enum(['like', 'bookmark', 'none']),
  },
  theme: z.enum(['system', 'light', 'dark']),
  loadRemoteImages: z.boolean(),
  implicitFeedback: z.boolean(),
  folderOrder: z.array(FolderNameSchema).max(MAX_FOLDERS),
  onboardingCompletedAt: IsoTimestampSchema.nullable(),
} as const;

export interface UserPreferences {
  defaultTier: 1 | 2 | 3 | 4 | 5;
  hideEverything: boolean;
  simpleMode: boolean;
  sort: 'score' | 'date';
  markReadOnExpand: boolean;
  markReadOnRate: boolean;
  feedbackPrompt: 'often' | 'occasionally' | 'never';
  /** Offer to add a rated article as a card example (spec 06 §10). */
  exampleSuggestions: boolean;
  demote: { clickbait: Tri; promotional: Tri; shallow: Tri; stale: Tri };
  implicitNegative: boolean;
  swipe: { left: 'dislike' | 'read' | 'none'; right: 'like' | 'bookmark' | 'none' };
  theme: 'system' | 'light' | 'dark';
  /** Publisher images/icons require opt-in (spec 08 §4.2). */
  loadRemoteImages: boolean;
  /** Opt in to dwell/read-derived learning. */
  implicitFeedback: boolean;
  folderOrder: string[];
  /** ISO timestamp; null shows onboarding. */
  onboardingCompletedAt: string | null;
}

export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = Object.freeze<UserPreferences>({
  defaultTier: 1,
  hideEverything: false,
  simpleMode: false,
  sort: 'score',
  markReadOnExpand: true,
  markReadOnRate: true,
  feedbackPrompt: 'occasionally',
  exampleSuggestions: true,
  demote: { clickbait: 'auto', promotional: 'auto', shallow: 'auto', stale: 'auto' },
  implicitNegative: false,
  swipe: { left: 'dislike', right: 'like' },
  theme: 'system',
  loadRemoteImages: false,
  implicitFeedback: false,
  folderOrder: [],
  onboardingCompletedAt: null,
});

/** Read schema: fills every missing leaf with its default and drops unknown keys. */
export const UserPreferencesSchema: z.ZodType<UserPreferences> = z.object({
  defaultTier: fields.defaultTier.catch(DEFAULT_USER_PREFERENCES.defaultTier),
  hideEverything: fields.hideEverything.catch(DEFAULT_USER_PREFERENCES.hideEverything),
  simpleMode: fields.simpleMode.catch(DEFAULT_USER_PREFERENCES.simpleMode),
  sort: fields.sort.catch(DEFAULT_USER_PREFERENCES.sort),
  markReadOnExpand: fields.markReadOnExpand.catch(DEFAULT_USER_PREFERENCES.markReadOnExpand),
  markReadOnRate: fields.markReadOnRate.catch(DEFAULT_USER_PREFERENCES.markReadOnRate),
  feedbackPrompt: fields.feedbackPrompt.catch(DEFAULT_USER_PREFERENCES.feedbackPrompt),
  exampleSuggestions: fields.exampleSuggestions.catch(DEFAULT_USER_PREFERENCES.exampleSuggestions),
  demote: z
    .object({
      clickbait: fields.demote.clickbait.catch('auto'),
      promotional: fields.demote.promotional.catch('auto'),
      shallow: fields.demote.shallow.catch('auto'),
      stale: fields.demote.stale.catch('auto'),
    })
    .catch({ ...DEFAULT_USER_PREFERENCES.demote }),
  implicitNegative: fields.implicitNegative.catch(DEFAULT_USER_PREFERENCES.implicitNegative),
  swipe: z
    .object({
      left: fields.swipe.left.catch(DEFAULT_USER_PREFERENCES.swipe.left),
      right: fields.swipe.right.catch(DEFAULT_USER_PREFERENCES.swipe.right),
    })
    .catch({ ...DEFAULT_USER_PREFERENCES.swipe }),
  theme: fields.theme.catch(DEFAULT_USER_PREFERENCES.theme),
  loadRemoteImages: fields.loadRemoteImages.catch(DEFAULT_USER_PREFERENCES.loadRemoteImages),
  implicitFeedback: fields.implicitFeedback.catch(DEFAULT_USER_PREFERENCES.implicitFeedback),
  folderOrder: fields.folderOrder.catch(() => []),
  onboardingCompletedAt: fields.onboardingCompletedAt.catch(null),
});

/** Stored preferences with defaults applied (spec 08 §3.1: "zod defaults applied on read"). */
export function readUserPreferences(stored: unknown): UserPreferences {
  const input =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return UserPreferencesSchema.parse(input);
}

/**
 * PATCH body: a strict deep-partial (unknown keys rejected, spec 02 "Wire types"). An empty
 * patch fails validation (spec 08 §1.1).
 */
export const UserPreferencesPatchSchema = z
  .object({
    defaultTier: fields.defaultTier,
    hideEverything: fields.hideEverything,
    simpleMode: fields.simpleMode,
    sort: fields.sort,
    markReadOnExpand: fields.markReadOnExpand,
    markReadOnRate: fields.markReadOnRate,
    feedbackPrompt: fields.feedbackPrompt,
    exampleSuggestions: fields.exampleSuggestions,
    demote: z
      .object({
        clickbait: fields.demote.clickbait,
        promotional: fields.demote.promotional,
        shallow: fields.demote.shallow,
        stale: fields.demote.stale,
      })
      .partial()
      .strict()
      .refine((o) => Object.keys(o).length > 0, 'empty object'),
    implicitNegative: fields.implicitNegative,
    swipe: z
      .object({ left: fields.swipe.left, right: fields.swipe.right })
      .partial()
      .strict()
      .refine((o) => Object.keys(o).length > 0, 'empty object'),
    theme: fields.theme,
    loadRemoteImages: fields.loadRemoteImages,
    implicitFeedback: fields.implicitFeedback,
    folderOrder: fields.folderOrder,
    onboardingCompletedAt: fields.onboardingCompletedAt,
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'empty preferences patch');
export type UserPreferencesPatch = z.infer<typeof UserPreferencesPatchSchema>;

/**
 * Merge only the supplied leaves; arrays are replaced, not concatenated (spec 08 §1.1).
 * The caller holds the user-row lock.
 */
export function mergeUserPreferences(
  current: UserPreferences,
  patch: UserPreferencesPatch,
): UserPreferences {
  const next: UserPreferences = {
    ...current,
    demote: { ...current.demote },
    swipe: { ...current.swipe },
    folderOrder: [...current.folderOrder],
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'demote' || key === 'swipe') {
      Object.assign(next[key], value);
    } else if (key === 'folderOrder') {
      next.folderOrder = [...(value as string[])];
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return UserPreferencesSchema.parse(next);
}

/** Preference keys whose change invalidates ranking (spec 06 §7): enqueue `user.rank {full}`. */
export const RANKING_RELEVANT_PREFERENCES = [
  'demote',
  'implicitFeedback',
  'implicitNegative',
] as const;
