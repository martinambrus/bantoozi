import type { EstimateModel } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A stored `user_estimate_models` row as an {@link EstimateModel}, or null when its layout is not the
 * one the trainer writes: a finite intercept, weights a plain object of finite numbers, platt
 * `{a, b}` finite numbers, metrics an object. The spec is not compared here.
 */
export function parseEstimateModel(row: {
  spec: string;
  intercept: number;
  weights: unknown;
  platt: unknown;
  metrics: unknown;
}): EstimateModel | null {
  if (!isFiniteNumber(row.intercept)) return null;
  if (!isPlainObject(row.weights) || !Object.values(row.weights).every(isFiniteNumber)) return null;
  if (!isPlainObject(row.platt) || !isFiniteNumber(row.platt.a) || !isFiniteNumber(row.platt.b)) {
    return null;
  }
  if (!isPlainObject(row.metrics)) return null;
  return {
    spec: row.spec,
    intercept: row.intercept,
    weights: row.weights as Record<string, number>,
    platt: { a: row.platt.a, b: row.platt.b },
    metrics: row.metrics as unknown as EstimateModel['metrics'],
  };
}
