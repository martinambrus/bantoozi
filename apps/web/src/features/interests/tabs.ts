/** The sections of /interests; the first is shown when the address names none. */
export const TABS = ['mine', 'suggestions', 'library', 'updates', 'requests'] as const;

export type InterestsTab = (typeof TABS)[number];

export const DEFAULT_TAB: InterestsTab = 'mine';
