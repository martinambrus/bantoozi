import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { preserveUnknownFields, readerSchema } from '../src/setting-readers.js';

it('re-evaluates defaults and prefaults and isolates mutable object and array defaults', () => {
  let calls = 0;
  const schema = readerSchema(
    z
      .object({
        object: z.object({ n: z.number() }).strict().default({ n: 1 }),
        array: z.array(z.string()).default([]),
        generated: z.number().default(() => ++calls),
        prefault: z.number().prefault(() => ++calls),
      })
      .strict(),
  );
  expect(calls).toBe(0);
  const first = schema.parse({});
  first.object.n = 99;
  first.array.push('leak');
  const second = schema.parse({});
  expect(second).toEqual({ object: { n: 1 }, array: [], generated: 3, prefault: 4 });
});

it('derives getter-recursive objects before descending into their shape', () => {
  const tree = z.strictObject({
    n: z.number(),
    get children(): z.ZodArray<typeof tree> {
      return z.array(tree);
    },
  });
  const reader = readerSchema(tree);
  expect(
    reader.parse({ n: 1, future: true, children: [{ n: 2, future: true, children: [] }] }),
  ).toEqual({ n: 1, children: [{ n: 2, children: [] }] });
  expect(reader).toBe(readerSchema(tree));
  expect(() => reader.parse({ n: 1, children: [{ n: 'bad', children: [] }] })).toThrow();
});

it('derives Map keys and values and Set elements with their constraints', () => {
  const leaf = z.strictObject({ n: z.number().min(1) });
  const map = readerSchema(z.map(leaf, leaf).refine((v) => v.size <= 1));
  expect(
    map.parse(
      new Map([
        [
          { n: 1, extra: true },
          { n: 2, extra: true },
        ],
      ]),
    ),
  ).toEqual(new Map([[{ n: 1 }, { n: 2 }]]));
  expect(() => map.parse(new Map([[{ n: 0 }, { n: 1 }]]))).toThrow();
  const set = readerSchema(z.set(leaf).max(1));
  expect(set.parse(new Set([{ n: 1, extra: true }]))).toEqual(new Set([{ n: 1 }]));
  expect(() => set.parse(new Set([{ n: 1 }, { n: 2 }]))).toThrow();
});

it('rejects unsupported constructs when deriving, including ones nested in a container', () => {
  const custom = z.custom<{ n: number }>();
  expect(() => readerSchema(custom)).toThrow(/unsupported.*custom/i);
  expect(() => readerSchema(z.object({ value: custom }))).toThrow(/unsupported.*custom/i);
  expect(() => readerSchema(z.object({ value: custom }))).toThrow(/unsupported.*custom/i);
});

it('keeps metadata on the derived root, nested objects, wrappers and leaf schemas', () => {
  const leaf = z.string().describe('leaf description').meta({ title: 'Leaf' });
  const child = z.strictObject({ leaf }).describe('child description');
  const schema = z
    .strictObject({ child: child.optional().describe('optional child') })
    .describe('root description')
    .meta({ id: 'reader-root', title: 'Root', examples: [{ child: { leaf: 'yes' } }] });
  const derived = readerSchema(schema);
  expect(derived.meta()).toMatchObject({ id: 'reader-root' });
  const json = z.toJSONSchema(derived);
  expect(json.$defs?.['reader-root'] ?? json).toMatchObject({
    description: 'root description',
    title: 'Root',
    examples: [{ child: { leaf: 'yes' } }],
    properties: {
      child: {
        description: 'optional child',
        properties: { leaf: { description: 'leaf description', title: 'Leaf' } },
      },
    },
  });
  expect(z.toJSONSchema(readerSchema(child))).toMatchObject({ description: 'child description' });
  expect(schema.shape.child.meta()).toMatchObject({ description: 'optional child' });
});

it.each([
  { a: 2, child: { a: 2 } },
  { b: 2, child: { b: 2 } },
])('keeps intersection extras without resurrecting omitted known fields: %j', (next) => {
  const schema = z.intersection(
    z.object({ a: z.number().optional(), child: z.object({ a: z.number().optional() }) }),
    z.object({ b: z.number().optional(), child: z.object({ b: z.number().optional() }) }),
  );
  const validated = schema.parse(next);
  expect(validated).toEqual(next);
  expect(
    preserveUnknownFields(
      schema,
      { a: 1, b: 2, future: 3, child: { a: 1, b: 2, future: 4 } },
      validated,
    ),
  ).toEqual({ ...next, future: 3, child: { ...next.child, future: 4 } });
});

it('exposes strip semantics in the object reader type', () => {
  const schema = z.strictObject({ n: z.number() });
  expectTypeOf(readerSchema(schema)).toEqualTypeOf<
    z.ZodObject<{ n: z.ZodNumber }, z.core.$strip>
  >();
});

it('preserves explicit catchall values and recursively reads their structured DTOs', () => {
  const child = z.strictObject({ n: z.number().min(1) });
  const schema = z.object({ name: z.string() }).catchall(child);
  const wire = { name: 'known', dynamic: { n: 2, future: true } };
  const reader = readerSchema(schema);
  expect(reader.parse(wire)).toEqual({ name: 'known', dynamic: { n: 2 } });
  expect(reader.safeParse({ name: 'known', dynamic: { n: 0 } }).success).toBe(false);
  expect(schema.safeParse(wire).success).toBe(false);
  const open = z.object({ name: z.string() }).catchall(z.unknown());
  expect(readerSchema(open).parse(wire)).toEqual(wire);
});

it('supports recursive catchalls without leaving their writer permissive', () => {
  const tree: z.ZodType = z.object({ n: z.number() }).catchall(z.lazy(() => tree));
  const wire = { n: 1, child: { n: 2, grandchild: { n: 3 } } };
  expect(readerSchema(tree).parse(wire)).toEqual(wire);
  expect(readerSchema(tree).safeParse({ n: 1, child: { n: 'bad' } }).success).toBe(false);
});
