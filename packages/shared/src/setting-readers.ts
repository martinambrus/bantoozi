import { z } from 'zod';

const readers = new WeakMap<z.ZodType, z.ZodType>();

/** Derive a stored-value reader without changing writer constraints or refinements. */
export function readerSchema<S extends z.core.$ZodType>(input: S): S {
  const schema = input as unknown as z.ZodType;
  const cached = readers.get(schema);
  if (cached) return cached as unknown as S;
  const def = schema.def;
  let result: z.ZodType = schema;
  if (schema instanceof z.ZodObject) {
    result = schema.clone({
      ...schema.def,
      shape: Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [key, readerSchema(field as z.ZodType)]),
      ),
      catchall:
        schema.def.catchall instanceof z.ZodNever
          ? undefined
          : schema.def.catchall && readerSchema(schema.def.catchall),
    });
  } else if (schema instanceof z.ZodArray) {
    result = schema.clone({ ...schema.def, element: readerSchema(schema.element) });
  } else if (schema instanceof z.ZodRecord) {
    result = schema.clone({ ...schema.def, valueType: readerSchema(schema.valueType) });
  } else if (schema instanceof z.ZodUnion) {
    result = schema.clone({ ...schema.def, options: schema.options.map(readerSchema) });
  } else if (schema instanceof z.ZodIntersection) {
    result = schema.clone({
      ...schema.def,
      left: readerSchema(schema.def.left),
      right: readerSchema(schema.def.right),
    });
  } else if (schema instanceof z.ZodTuple) {
    result = schema.clone({
      ...schema.def,
      items: schema.def.items.map(readerSchema),
      rest: schema.def.rest && readerSchema(schema.def.rest),
    });
  } else if (schema instanceof z.ZodLazy) {
    result = schema.clone({ ...schema.def, getter: () => readerSchema(schema.def.getter()) });
  } else if (schema instanceof z.ZodPipe) {
    result = schema.clone({
      ...schema.def,
      in: readerSchema(schema.def.in),
      out: readerSchema(schema.def.out),
    });
  } else if ('innerType' in def) {
    // Optional, nullable, default, prefault, catch, readonly and nonoptional wrappers.
    result = schema.clone({
      ...def,
      innerType: readerSchema(def.innerType as z.ZodType),
    } as typeof def);
  }
  readers.set(schema, result);
  return result as unknown as S;
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
 * when entries move. The caller still validates its new known value with the strict writer schema.
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
