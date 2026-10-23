import type { Control } from '../support/control.js';

/**
 * The model the e2e worker asks for all its life (TYPESAFE_MODEL). While the fake has a table, every
 * id the worker or a probe asks for must be in it, or that request is a 404: the worker's own model
 * and the environment default the reset probes both are `jev-fake`.
 */
export const WORKER_MODEL = { 'jev-fake': 'jev-fake' } as const;

/** Makes the fake answer exactly these requested -> answered pairs, plus the worker's own model. */
export function setModels(control: Control, table: Record<string, string>) {
  return control.setFakeOptions({ models: { ...WORKER_MODEL, ...table } });
}
