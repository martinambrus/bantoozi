import { z } from 'zod';

const readers = new WeakMap<z.ZodType, z.ZodType>();

/** Object readers expose strip semantics in their Zod type; other constructs retain their API. */
export type ReaderSchema<S extends z.core.$ZodType> =
  S extends z.ZodObject<infer Shape>
    ? z.ZodObject<{ [K in keyof Shape]: ReaderSchema<Shape[K]> }, z.core.$strip>
    : S;

/** Explicit value-class compatibility for a schema whose writer remains strict. Register before deriving parents. */
export function withStoredReader<S extends z.ZodType>(
  writer: S,
  reader: z.ZodType<z.output<S>>,
): S {
  readers.set(writer, reader);
  return writer;
}

/** Derive a stored-value reader without changing writer constraints or refinements. */
export function readerSchema<S extends z.core.$ZodType>(input: S): ReaderSchema<S> {
  // Publish only a completely derived graph. A failed derivation must not poison the cache.
  const pending = new Map<z.ZodType, z.ZodType>();
  function derive(input: z.core.$ZodType): z.ZodType {
    const schema = input as z.ZodType;
    const cached = readers.get(schema) ?? pending.get(schema);
    if (cached) return cached;
    const def = schema.def;
    let result: z.ZodType;
    if (schema instanceof z.ZodObject) {
      const shape: Record<string, z.ZodType> = {};
      // Zod captures catchall presence when cloning. Keep explicit catchalls present
      // until their recursive readers are installed below; strict objects still strip.
      const catchall = schema.def.catchall instanceof z.ZodNever ? undefined : schema.def.catchall;
      result = schema.clone({ ...schema.def, shape, catchall });
      // Getter-based recursive objects can revisit this object while walking its shape.
      pending.set(schema, result);
      for (const [key, field] of Object.entries(schema.shape))
        shape[key] = derive(field as z.ZodType);
      if (!(schema.def.catchall instanceof z.ZodNever) && schema.def.catchall) {
        (result as z.ZodObject).def.catchall = derive(schema.def.catchall);
      }
    } else if (schema instanceof z.ZodArray) {
      result = schema.clone({ ...schema.def, element: derive(schema.element) });
    } else if (schema instanceof z.ZodRecord) {
      result = schema.clone({
        ...schema.def,
        keyType: derive(schema.keyType) as typeof schema.keyType,
        valueType: derive(schema.valueType),
      });
    } else if (schema instanceof z.ZodMap) {
      result = schema.clone({
        ...schema.def,
        keyType: derive(schema.keyType),
        valueType: derive(schema.valueType),
      });
    } else if (schema instanceof z.ZodSet) {
      result = schema.clone({ ...schema.def, valueType: derive(schema.def.valueType) });
    } else if (schema instanceof z.ZodUnion) {
      result = schema.clone({ ...schema.def, options: schema.options.map(derive) });
    } else if (schema instanceof z.ZodIntersection) {
      result = schema.clone({
        ...schema.def,
        left: derive(schema.def.left),
        right: derive(schema.def.right),
      });
    } else if (schema instanceof z.ZodTuple) {
      result = schema.clone({
        ...schema.def,
        items: schema.def.items.map(derive),
        rest: schema.def.rest && derive(schema.def.rest),
      });
    } else if (schema instanceof z.ZodLazy) {
      // Register the lazy node before evaluating its getter as well.
      result = schema.clone({ ...schema.def, getter: () => inner });
      pending.set(schema, result);
      const inner = derive(schema.def.getter());
    } else if (schema instanceof z.ZodPipe) {
      result = schema.clone({
        ...schema.def,
        in: derive(schema.def.in),
        out: derive(schema.def.out),
      });
    } else if (
      [
        'optional',
        'nullable',
        'default',
        'prefault',
        'catch',
        'readonly',
        'nonoptional',
        'success',
      ].includes(def.type) &&
      'innerType' in def
    ) {
      // Preserve defaultValue getters, including fresh mutable values and function defaults.
      const rebuilt = Object.defineProperties({}, Object.getOwnPropertyDescriptors(def));
      Object.defineProperty(rebuilt, 'innerType', {
        value: derive(def.innerType as z.ZodType),
        enumerable: true,
      });
      result = schema.clone(rebuilt as typeof def);
    } else if (
      [
        'string',
        'number',
        'bigint',
        'boolean',
        'date',
        'symbol',
        'undefined',
        'null',
        'any',
        'unknown',
        'never',
        'void',
        'nan',
        'enum',
        'literal',
        'template_literal',
        'file',
        'transform',
      ].includes(def.type)
    ) {
      result = schema;
    } else {
      throw new Error(`Unsupported reader schema construct: ${def.type}`);
    }
    // Keep metadata on the clone itself: a parent link changes JSON Schema conversion and
    // deliberately drops ids. Do not remap the registry's id lookup away from the writer.
    const metadata = z.globalRegistry.get(schema);
    if (result !== schema && metadata) z.globalRegistry._map.set(result, { ...metadata });
    pending.set(schema, result);
    return result;
  }
  const result = derive(input);
  for (const [schema, reader] of pending) readers.set(schema, reader);
  return result as unknown as ReaderSchema<S>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Object keys owned by any branch; switching variants must not resurrect an old known field. */
function objectFields(input: z.core.$ZodType): Set<string> {
  const schema = input as z.ZodType;
  if ('innerType' in schema.def) return objectFields(schema.def.innerType as z.ZodType);
  if (schema instanceof z.ZodLazy) return objectFields(schema.def.getter());
  if (schema instanceof z.ZodObject) return new Set(Object.keys(schema.shape));
  if (schema instanceof z.ZodUnion)
    return new Set(schema.options.flatMap((option) => [...objectFields(option)]));
  if (schema instanceof z.ZodIntersection)
    return new Set([...objectFields(schema.def.left), ...objectFields(schema.def.right)]);
  return new Set();
}

/**
 * Retain only unknown fields of the old row, including nested objects. Known fields and record
 * entries omitted by the writer stay deleted; arrays retain extras on unchanged entries, even
 * when entries move. Extras belong to the setting key path, not record identity: replacing a
 * model candidate, resetting a breaker or regenerating a daily snapshot can inherit old extras.
 * Array matching compares the stripped, unchanged value (including JSON property order); editing
 * an element in place loses its extras. Pipes/transforms and Map/Set do not restore extras.
 * Direct object intersections combine their fields; other intersections are best-effort branch
 * passes and should not be used when a writer must delete fields owned by another branch.
 * The caller still validates its new known value with the strict writer schema.
 */
export function preserveUnknownFields<T>(input: z.core.$ZodType, current: unknown, next: T): T {
  const schema = input as z.ZodType;
  if (next === null || next === undefined) return next;
  const def = schema.def;
  if ('innerType' in def) return preserveUnknownFields(def.innerType as z.ZodType, current, next);
  if (schema instanceof z.ZodLazy) return preserveUnknownFields(schema.def.getter(), current, next);
  if (schema instanceof z.ZodUnion) {
    const branch =
      schema.options.find((option) => z.safeParse(option, next).success) ??
      schema.options.find((option) => z.safeParse(readerSchema(option), next).success);
    if (!branch) return next;
    if (record(current) && record(next)) {
      const known = objectFields(schema);
      const selected = objectFields(branch);
      const kept = Object.fromEntries(
        Object.entries(current).filter(([key]) => !known.has(key) || selected.has(key)),
      );
      return preserveUnknownFields(branch, kept, next);
    }
    return preserveUnknownFields(branch, current, next);
  }
  if (schema instanceof z.ZodIntersection) {
    const { left, right } = schema.def;
    if (left instanceof z.ZodObject && right instanceof z.ZodObject) {
      // Treat both sides' fields as known, including shared nested object fields. Otherwise
      // either branch can resurrect an optional field deliberately omitted by the writer.
      const shape: Record<string, z.ZodType> = { ...left.shape, ...right.shape };
      for (const key of Object.keys(left.shape)) {
        if (Object.hasOwn(right.shape, key))
          shape[key] = z.intersection(left.shape[key], right.shape[key]);
      }
      return preserveUnknownFields(z.object(shape), current, next);
    }
    return preserveUnknownFields(
      schema.def.right,
      current,
      preserveUnknownFields(schema.def.left, current, next),
    );
  }
  if (schema instanceof z.ZodObject && record(current) && record(next)) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const result: Record<string, unknown> = { ...next };
    for (const [key, value] of Object.entries(current)) {
      if (!Object.hasOwn(shape, key) && !Object.hasOwn(result, key)) {
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    for (const [key, field] of Object.entries(shape)) {
      if (Object.hasOwn(next, key))
        result[key] = preserveUnknownFields(field, current[key], next[key]);
    }
    return result as T;
  }
  if (schema instanceof z.ZodRecord && record(current) && record(next)) {
    return Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        preserveUnknownFields(schema.valueType, current[key], value),
      ]),
    ) as T;
  }
  if (schema instanceof z.ZodArray && Array.isArray(current) && Array.isArray(next)) {
    const reader = readerSchema(schema.element);
    const known = current.map((value) => z.safeParse(reader, value));
    const matched = new Set<number>();
    return next.map((value) => {
      const oldIndex = known.findIndex(
        (parsed, index) =>
          !matched.has(index) &&
          parsed.success &&
          JSON.stringify(parsed.data) === JSON.stringify(value),
      );
      if (oldIndex < 0) return value;
      matched.add(oldIndex);
      return preserveUnknownFields(schema.element, current[oldIndex], value);
    }) as T;
  }
  return next;
}

/** A defensive object reader: a corrupt field does not erase its valid siblings. */
export function readSettingFields<S extends z.ZodObject>(
  schema: S,
  value: unknown,
): Partial<z.output<S>> {
  if (!record(value)) return {} as Partial<z.output<S>>;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = readerSchema(field as z.ZodType).safeParse(value[key]);
    if (parsed.success && parsed.data !== undefined) result[key] = parsed.data;
  }
  return result as Partial<z.output<S>>;
}
