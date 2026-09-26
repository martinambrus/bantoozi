/**
 * Accessors for the element values rss-parser/xml2js produce: a string for a text-only element, an
 * object with `_` (text) and `$` (attributes) for an element with attributes, and child element
 * arrays keyed by name otherwise. Every accessor tolerates any shape.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The array itself, `[]` for `undefined`/`null`, else a one-element array. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value as unknown[];
  return value === undefined || value === null ? [] : [value];
}

/** The first element of an array, or the value itself. */
export function first(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/** Text of an element value: the string, its `_` text, or its descendants' text in key order. */
export function textOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 64) return '';
  if (Array.isArray(value)) return textOf(value[0], depth + 1);
  if (!isRecord(value)) return '';
  if (typeof value['_'] === 'string') return value['_'];
  return Object.entries(value)
    .filter(([key]) => key !== '$')
    .flatMap(([, child]) => asArray(child).map((item) => textOf(item, depth + 1)))
    .join(' ');
}

/** Attributes (`$`) of an element value; values that are not strings are ignored. */
export function attributesOf(value: unknown): Record<string, string> {
  const attributes = isRecord(value) ? value['$'] : undefined;
  if (!isRecord(attributes)) return {};
  const result: Record<string, string> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    if (typeof attribute === 'string') result[name] = attribute;
  }
  return result;
}

/** One attribute of an element value. */
export function attributeOf(value: unknown, name: string): string | undefined {
  return attributesOf(value)[name];
}

/** Whether an element value has child elements (not only text and attributes). */
export function hasElementChildren(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => key !== '$' && key !== '_');
}
