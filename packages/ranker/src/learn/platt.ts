import { sigmoid } from './metrics.js';

export interface PlattParams {
  a: number;
  b: number;
}

const PRIOR = 0.01;
const A_MIN = 1e-6;

function nll(z: number, y: number): number {
  return Math.max(z, 0) - z * y + Math.log1p(Math.exp(-Math.abs(z)));
}

/** Platt scaling: `sigmoid(a·z + b)` (spec 06 §8.3). */
export function applyPlatt(params: PlattParams, z: number): number {
  return sigmoid(params.a * z + params.b);
}

/** Fits Platt `a, b` by 2-D Newton with a ridge prior toward the identity (spec 06 §8.3). */
export function fitPlatt(
  logits: readonly number[],
  y: readonly number[],
  w?: readonly number[],
): PlattParams {
  const n = logits.length;
  const loss = (a: number, b: number): number => {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += (w?.[i] ?? 1) * nll(a * (logits[i] ?? 0) + b, y[i] ?? 0);
    return s + (PRIOR / 2) * ((a - 1) ** 2 + b * b);
  };
  let a = 1;
  let b = 0;
  let cur = loss(a, b);
  for (let it = 0; it < 100; it += 1) {
    let ga = PRIOR * (a - 1);
    let gb = PRIOR * b;
    let haa = PRIOR;
    let hab = 0;
    let hbb = PRIOR;
    for (let i = 0; i < n; i += 1) {
      const z = logits[i] ?? 0;
      const wi = w?.[i] ?? 1;
      const p = sigmoid(a * z + b);
      const r = wi * (p - (y[i] ?? 0));
      const h = wi * p * (1 - p);
      ga += r * z;
      gb += r;
      haa += h * z * z;
      hab += h * z;
      hbb += h;
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0) || !Number.isFinite(det)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    let step = 1;
    let next = cur;
    let na = a;
    let nb = b;
    let accepted = false;
    for (let h = 0; h <= 30; h += 1) {
      na = Math.max(a - step * da, A_MIN);
      nb = b - step * db;
      next = loss(na, nb);
      if (Number.isFinite(next) && next <= cur) {
        accepted = true;
        break;
      }
      step /= 2;
    }
    if (!accepted) break;
    const delta = cur - next;
    a = na;
    b = nb;
    cur = next;
    if (delta < 1e-10) break;
  }
  return { a, b };
}
