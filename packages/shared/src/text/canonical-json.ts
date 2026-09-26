/**
 * Canonical JSON (spec 05 §2): object keys sorted recursively, no whitespace, arrays in order.
 * Used for content hashes, card text hashes and outbox dedupe keys, so it must be deterministic:
 * non-finite numbers, bigints and non-plain objects are rejected instead of being coerced.
 * `undefined` object properties are omitted, as in `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined)
              throw new TypeError(`canonicalJson: undefined at ${path}[${i}]`);
            return serialize(item, `${path}[${i}]`);
          })
          .join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: unsupported object at ${path}`);
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}
