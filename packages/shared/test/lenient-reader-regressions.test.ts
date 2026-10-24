import { expect, it } from 'vitest';
import { z } from 'zod';

import { readerSchema } from '../src/setting-readers.js';

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
