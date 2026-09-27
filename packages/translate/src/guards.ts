/**
 * Own-property-safe checks for untrusted JSON (provider responses). `JSON.parse` creates plain
 * objects whose keys may be anything, `__proto__` included; values are read only as own
 * properties, never through the prototype chain.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own property's value, or `undefined`. */
export function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A non-negative safe integer (token counts). */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
