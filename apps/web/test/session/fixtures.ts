import { DEFAULT_USER_PREFERENCES, type Me, type UserPreferences } from '@bantoozi/shared';

export const USER_A_ID = '0192f7a0-0000-7000-8000-00000000000a';
export const USER_B_ID = '0192f7a0-0000-7000-8000-00000000000b';

interface MeOverrides extends Partial<Omit<Me, 'preferences'>> {
  preferences?: Partial<UserPreferences>;
}

/** A complete, schema-valid `Me`; `preferences.onboardingCompletedAt` is set unless overridden. */
export function makeMe(overrides: MeOverrides = {}): Me {
  const { preferences, ...rest } = overrides;
  return {
    id: USER_A_ID,
    email: 'a@example.com',
    displayName: null,
    locale: 'en',
    timezone: 'Europe/Bratislava',
    role: 'user',
    plan: 'beta',
    invitesLeft: 3,
    preferences: {
      ...DEFAULT_USER_PREFERENCES,
      onboardingCompletedAt: '2026-10-01T08:00:00+00:00',
      ...preferences,
    },
    quotas: {
      used: { maxFeeds: 0, maxCards: 0, maxLabels: 0, maxForks: 0, maxRules: 0 },
      limits: {
        maxFeeds: 200,
        maxCards: 50,
        maxLabels: 20,
        maxForks: 20,
        maxRules: 200,
        opmlMaxFeeds: 300,
      },
    },
    ...rest,
  };
}
