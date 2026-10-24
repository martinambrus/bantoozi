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
