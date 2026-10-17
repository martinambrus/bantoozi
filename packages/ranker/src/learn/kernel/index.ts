import { ACCUMULATE_WASM_BASE64 } from './accumulate.wasm.js';

/** Which implementation accumulates the Newton step (D-264): `auto` uses WASM SIMD when available. */
export type TrainingKernel = 'auto' | 'js' | 'wasm';

/** One fit's design matrix and per-iteration buffers, in kernel memory when WASM is used. */
export interface NewtonBuffers {
  /** n × m, row-major. */
  readonly A: Float64Array;
  readonly r: Float64Array;
  readonly h: Float64Array;
  readonly grad: Float64Array;
  /** m × m; only the lower triangle is accumulated. */
  readonly H: Float64Array;
  readonly n: number;
  readonly m: number;
  /** grad and H += Σ over the rows (see {@link accumulateJs}). */
  accumulate(): void;
}

/** The part of the WebAssembly API the kernel uses (the ranker compiles without the DOM types). */
interface WasmApi {
  validate(bytes: Uint8Array): boolean;
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
}

interface WasmMemory {
  readonly buffer: ArrayBuffer;
  grow(pages: number): number;
}

interface WasmKernel {
  memory: WasmMemory;
  accumulate: (n: number, m: number, a: number, r: number, h: number, g: number, H: number) => void;
}

let requested: TrainingKernel = 'auto';
let wasm: WasmKernel | null | undefined;

/** Selects the kernel (tests, the bench); `wasm` throws when this runtime cannot run it. */
export function setTrainingKernel(kernel: TrainingKernel): void {
  if (kernel === 'wasm' && loadWasm() === null) {
    throw new Error('the WASM SIMD training kernel is not available in this runtime');
  }
  requested = kernel;
}

/** The kernel {@link newtonBuffers} uses now. */
export function activeTrainingKernel(): 'js' | 'wasm' {
  return requested !== 'js' && loadWasm() !== null ? 'wasm' : 'js';
}

/** Compiled once per thread; null (and the JS path for good) when validation or compilation fails. */
function loadWasm(): WasmKernel | null {
  if (wasm !== undefined) return wasm;
  wasm = null;
  const api = (globalThis as { WebAssembly?: WasmApi }).WebAssembly;
  if (api === undefined) return null;
  try {
    const bytes = Uint8Array.from(atob(ACCUMULATE_WASM_BASE64), (c) => c.charCodeAt(0));
    if (!api.validate(bytes)) return null;
    const { exports } = new api.Instance(new api.Module(bytes), {});
    wasm = {
      memory: exports['memory'] as WasmMemory,
      accumulate: exports['accumulate'] as WasmKernel['accumulate'],
    };
  } catch {
    wasm = null;
  }
  return wasm;
}

/**
 * The reference accumulation, exactly the loop `fitLogistic` ran before D-264:
 * `grad[j] += r_i·a_ij` and `H[j][k] += (h_i·a_ij)·a_ik` for `k ≤ j`, rows in order.
 */
export function accumulateJs(
  A: Float64Array,
  n: number,
  m: number,
  r: Float64Array,
  h: Float64Array,
  grad: Float64Array,
  H: Float64Array,
): void {
  for (let i = 0; i < n; i += 1) {
    const ri = r[i] ?? 0;
    const hi = h[i] ?? 0;
    for (let j = 0; j < m; j += 1) {
      const aj = A[i * m + j] ?? 0;
      grad[j] = (grad[j] ?? 0) + ri * aj;
      for (let k = 0; k <= j; k += 1) {
        H[j * m + k] = (H[j * m + k] ?? 0) + hi * aj * (A[i * m + k] ?? 0);
      }
    }
  }
}

const PAGE = 65_536;

/**
 * Buffers for one fit of an n × m design: with the WASM kernel they live in its memory (grown on
 * demand, one fit at a time per thread), otherwise in plain arrays. The caller fills `A` once and
 * `r`, `h` per iteration, zeroes `grad` and `H`, and calls `accumulate()`.
 */
export function newtonBuffers(n: number, m: number): NewtonBuffers {
  const kernel = activeTrainingKernel() === 'wasm' ? loadWasm() : null;
  if (kernel === null) {
    const A = new Float64Array(n * m);
    const r = new Float64Array(n);
    const h = new Float64Array(n);
    const grad = new Float64Array(m);
    const H = new Float64Array(m * m);
    return { A, r, h, grad, H, n, m, accumulate: () => accumulateJs(A, n, m, r, h, grad, H) };
  }
  const doubles = n * m + n + n + m + m * m;
  const bytes = doubles * 8;
  const have = kernel.memory.buffer.byteLength;
  if (bytes > have) kernel.memory.grow(Math.ceil((bytes - have) / PAGE));
  const buffer = kernel.memory.buffer;
  let offset = 0;
  const take = (length: number): Float64Array => {
    const view = new Float64Array(buffer, offset, length);
    offset += length * 8;
    return view;
  };
  const A = take(n * m);
  const r = take(n);
  const h = take(n);
  const grad = take(m);
  const H = take(m * m);
  return {
    A,
    r,
    h,
    grad,
    H,
    n,
    m,
    accumulate: () =>
      kernel.accumulate(
        n,
        m,
        A.byteOffset,
        r.byteOffset,
        h.byteOffset,
        grad.byteOffset,
        H.byteOffset,
      ),
  };
}
