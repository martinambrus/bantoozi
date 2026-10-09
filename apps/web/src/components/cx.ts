/** Joins class names, skipping the falsy ones. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The keyboard focus ring of every interactive element (spec 09 §1); AA contrast in both themes. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300';
