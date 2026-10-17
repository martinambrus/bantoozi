import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accumulateJs,
  activeTrainingKernel,
  fitLogistic,
  newtonBuffers,
  seededRandom,
  setTrainingKernel,
} from '../../src/index.js';

afterEach(() => setTrainingKernel('auto'));

/** Element-wise identity, so −0 and NaN count (D-264: bit-identical, not merely close). */
function sameBits(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

const value = fc.oneof(
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  fc.constantFrom(0, -0, 1, -1, 1e-300, -1e-300, 3.5e15),
);

describe('the WASM SIMD Newton accumulation (D-264)', () => {
  it('is available on this runtime', () => {
    expect(activeTrainingKernel()).toBe('wasm');
  });

  it('matches the JS loop bit for bit on any design', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 19 }),
        fc.infiniteStream(value),
        (n, m, values) => {
          const iter = values[Symbol.iterator]();
          const next = (): number => iter.next().value as number;
          setTrainingKernel('wasm');
          const buffers = newtonBuffers(n, m);
          const A = Float64Array.from({ length: n * m }, next);
          const r = Float64Array.from({ length: n }, next);
          const h = Float64Array.from({ length: n }, next);
          buffers.A.set(A);
          buffers.r.set(r);
          buffers.h.set(h);
          buffers.grad.fill(0);
          buffers.H.fill(0);
          buffers.accumulate();
          const grad = new Float64Array(m);
          const H = new Float64Array(m * m);
          accumulateJs(A, n, m, r, h, grad, H);
          return sameBits(buffers.grad, grad) && sameBits(buffers.H, H);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('gives fitLogistic the same fit as the JS kernel, odd and even widths alike', () => {
    for (const [n, d] of [
      [400, 115],
      [300, 16],
      [50, 1],
      [120, 2],
    ] as const) {
      const rand = seededRandom(`fit|${n}|${d}`);
      const X = Array.from({ length: n }, () => Array.from({ length: d }, () => rand() * 4 - 2));
      const y = X.map((row) =>
        row.reduce((s, v, j) => s + v * ((j % 3) - 1), 0) + rand() > 0.5 ? 1 : 0,
      );
      const w = X.map(() => 0.5 + rand());
      setTrainingKernel('js');
      const js = fitLogistic(X, y, w, 10);
      setTrainingKernel('wasm');
      const simd = fitLogistic(X, y, w, 10);
      expect(js.ok).toBe(true);
      expect(simd).toEqual(js);
      if (js.ok && simd.ok) {
        expect(sameBits(simd.weights, js.weights)).toBe(true);
        expect(Object.is(simd.intercept, js.intercept)).toBe(true);
      }
    }
  });

  it('embeds the bytes assembled from accumulate.wat', () => {
    const script = fileURLToPath(new URL('../../scripts/gen-kernel.mjs', import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('falls back to the JS kernel where WebAssembly is unavailable', async () => {
    vi.resetModules();
    vi.stubGlobal('WebAssembly', undefined);
    try {
      const kernel = await import('../../src/learn/kernel/index.js');
      expect(kernel.activeTrainingKernel()).toBe('js');
      expect(() => kernel.setTrainingKernel('wasm')).toThrow(/not available/u);
      const buffers = kernel.newtonBuffers(3, 2);
      buffers.A.set([1, 2, 3, 4, 5, 6]);
      buffers.r.set([1, 1, 1]);
      buffers.h.set([1, 1, 1]);
      buffers.accumulate();
      expect([...buffers.grad]).toEqual([9, 12]);
      expect([...buffers.H]).toEqual([35, 0, 44, 56]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
