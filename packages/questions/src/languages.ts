import { languageName } from '@bantoozi/shared/server';

/** The name the state uses for an unknown language (`und`, a missing or a non-ISO 639-1 code). */
export const UNKNOWN_LANGUAGE_NAME = 'Unknown';

/**
 * The English name of an article language for the model state (`sk-SK` → `Slovak`), or
 * {@link UNKNOWN_LANGUAGE_NAME} for `und`, a missing code or anything that is not ISO 639-1.
 */
export function stateLanguageName(code: string | null | undefined): string {
  return languageName(code) ?? UNKNOWN_LANGUAGE_NAME;
}
