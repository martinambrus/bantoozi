import { choleskySolve } from './linalg.js';

export type LogisticFit =
  | { ok: true; weights: number[]; intercept: number; iterations: number }
  | { ok: false; reason: 'singular' | 'nonfinite' | 'nonconverged' };

const MAX_ITER = 25;
const TOL = 1e-6;

function sigmoidStable(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Ridge-penalized logistic fit on the summed loss, Σ wᵢ·NLLᵢ + λ/2·‖weights‖² with the intercept
 * unpenalized (spec 06 §8.3): damped Newton with a Cholesky solve and diagonal jitter.
 */
export function fitLogistic(
  X: readonly (readonly number[])[],
  y: readonly number[],
  w: readonly number[],
  lambda: number,
  opts?: { init?: { weights: readonly number[]; intercept: number } },
): LogisticFit {
  const n = X.length;
  const d = n > 0 ? (X[0]?.length ?? 0) : 0;
  const m = d + 1;
  const A = new Float64Array(n * m);
  for (let i = 0; i < n; i += 1) {
    const row = X[i] ?? [];
    for (let j = 0; j < d; j += 1) {
      const v = row[j] ?? 0;
      if (!Number.isFinite(v)) return { ok: false, reason: 'nonfinite' };
      A[i * m + j] = v;
    }
    A[i * m + d] = 1;
    if (!Number.isFinite(y[i] ?? 0) || !Number.isFinite(w[i] ?? 1)) {
      return { ok: false, reason: 'nonfinite' };
    }
  }
  if (!Number.isFinite(lambda)) return { ok: false, reason: 'nonfinite' };

  const theta = new Float64Array(m);
  if (opts?.init) {
    for (let j = 0; j < d; j += 1) theta[j] = opts.init.weights[j] ?? 0;
    theta[d] = opts.init.intercept;
  }

  const loss = (t: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      let z = 0;
      for (let j = 0; j < m; j += 1) z += (A[i * m + j] ?? 0) * (t[j] ?? 0);
      const yi = y[i] ?? 0;
      s += (w[i] ?? 1) * (Math.max(z, 0) - z * yi + Math.log1p(Math.exp(-Math.abs(z))));
    }
    let pen = 0;
    for (let j = 0; j < d; j += 1) pen += (t[j] ?? 0) ** 2;
    return s + (lambda / 2) * pen;
  };

  let cur = loss(theta);
  if (!Number.isFinite(cur)) return { ok: false, reason: 'nonconverged' };

  for (let it = 1; it <= MAX_ITER; it += 1) {
    const grad = new Float64Array(m);
    const H = new Float64Array(m * m);
    for (let i = 0; i < n; i += 1) {
      let z = 0;
      for (let j = 0; j < m; j += 1) z += (A[i * m + j] ?? 0) * (theta[j] ?? 0);
      const p = sigmoidStable(z);
      const wi = w[i] ?? 1;
      const r = wi * (p - (y[i] ?? 0));
      const h = wi * p * (1 - p);
      for (let j = 0; j < m; j += 1) {
        const aj = A[i * m + j] ?? 0;
        grad[j] = (grad[j] ?? 0) + r * aj;
        for (let k = 0; k <= j; k += 1) {
          H[j * m + k] = (H[j * m + k] ?? 0) + h * aj * (A[i * m + k] ?? 0);
        }
      }
    }
    for (let j = 0; j < m; j += 1) {
      for (let k = j + 1; k < m; k += 1) H[j * m + k] = H[k * m + j] ?? 0;
    }
    for (let j = 0; j < d; j += 1) {
      grad[j] = (grad[j] ?? 0) + lambda * (theta[j] ?? 0);
      H[j * m + j] = (H[j * m + j] ?? 0) + lambda;
    }
    let maxDiag = 0;
    for (let j = 0; j < m; j += 1) maxDiag = Math.max(maxDiag, H[j * m + j] ?? 0);
    if (![...grad].every(Number.isFinite) || !Number.isFinite(maxDiag)) {
      return { ok: false, reason: 'nonconverged' };
    }

    let dir = choleskySolve(H, m, grad);
    let delta = 1e-10 * (maxDiag > 0 ? maxDiag : 1);
    for (let t = 0; dir === null && t < 10; t += 1) {
      const Hj = H.slice();
      for (let j = 0; j < m; j += 1) Hj[j * m + j] = (Hj[j * m + j] ?? 0) + delta;
      dir = choleskySolve(Hj, m, grad);
      delta *= 10;
    }
    if (dir === null) return { ok: false, reason: 'singular' };

    let step = 1;
    let next = theta;
    let nextLoss = Number.POSITIVE_INFINITY;
    for (let h = 0; h <= 30; h += 1) {
      next = new Float64Array(m);
      for (let j = 0; j < m; j += 1) next[j] = (theta[j] ?? 0) - step * (dir[j] ?? 0);
      nextLoss = loss(next);
      if (Number.isFinite(nextLoss) && nextLoss <= cur) break;
      step /= 2;
    }
    if (!Number.isFinite(nextLoss)) return { ok: false, reason: 'nonconverged' };
    const accepted = nextLoss <= cur;
    const change = accepted ? cur - nextLoss : 0;
    if (accepted) {
      theta.set(next);
      cur = nextLoss;
    }
    if (change < TOL) {
      const out = Array.from(theta);
      if (!out.every(Number.isFinite)) return { ok: false, reason: 'nonconverged' };
      return { ok: true, weights: out.slice(0, d), intercept: out[d] ?? 0, iterations: it };
    }
  }
  return { ok: false, reason: 'nonconverged' };
}
