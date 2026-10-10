/**
 * Cholesky solve of the symmetric system `H x = b` (spec 06 §8.3). `H` is row-major n×n; returns
 * `null` when it is not positive definite or a pivot is non-finite.
 */
export function choleskySolve(H: Float64Array, n: number, b: Float64Array): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = H[i * n + j] ?? 0;
      for (let k = 0; k < j; k += 1) s -= (L[i * n + k] ?? 0) * (L[j * n + k] ?? 0);
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / (L[j * n + j] ?? 1);
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = b[i] ?? 0;
    for (let k = 0; k < i; k += 1) s -= (L[i * n + k] ?? 0) * (y[k] ?? 0);
    y[i] = s / (L[i * n + i] ?? 1);
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i] ?? 0;
    for (let k = i + 1; k < n; k += 1) s -= (L[k * n + i] ?? 0) * (x[k] ?? 0);
    x[i] = s / (L[i * n + i] ?? 1);
  }
  return x;
}
