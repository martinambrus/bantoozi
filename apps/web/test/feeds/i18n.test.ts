import { describe, expect, it } from 'vitest';

import { RESOURCES } from '../../src/i18n/resources.js';

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** Every message with the placeholders it uses, keyed without the plural suffix. */
function placeholdersByKey(
  messages: Record<string, unknown>,
  prefix = '',
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'object' && value !== null) {
      for (const [nested, names] of placeholdersByKey(
        value as Record<string, unknown>,
        `${prefix}${key}.`,
      )) {
        found.set(nested, new Set([...(found.get(nested) ?? []), ...names]));
      }
    } else {
      const base = `${prefix}${key}`.replace(PLURAL_SUFFIX, '');
      const names = [...String(value).matchAll(PLACEHOLDER)].map((match) => match[1] as string);
      found.set(base, new Set([...(found.get(base) ?? []), ...names]));
    }
  }
  return found;
}

describe('the feeds messages', () => {
  const english = placeholdersByKey(RESOURCES.en['feeds'] ?? {});
  const slovak = placeholdersByKey(RESOURCES.sk['feeds'] ?? {});

  it('use the same placeholders in English and Slovak', () => {
    const asObject = (map: Map<string, Set<string>>) =>
      Object.fromEntries([...map].map(([key, names]) => [key, [...names].sort()]));

    expect(asObject(slovak)).toEqual(asObject(english));
  });
});
