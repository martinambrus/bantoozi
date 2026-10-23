import { isConcreteJevModel, isModelAlias, sameModelFamily } from './model-id.js';
import type { EngineModelProbe } from './settings.js';

/**
 * The save-time rules of the TypeSafe model editor (visible-learning §4.1, JEV-5). Pure functions,
 * read by the admin API, which enforces them, and by the web editor, which shows them, so the two
 * cannot disagree about what a change does.
 */

/** A probe is good evidence for a save this long (design §4.1: "from the last 10 minutes"). */
export const MODEL_PROBE_MAX_AGE_MS = 10 * 60_000;
/** A probe stamped further ahead of the reader's clock than this is not trusted (clock skew bound). */
export const MODEL_PROBE_MAX_SKEW_MS = 60_000;

export type ModelProbeVerdict =
  /** No probe of this id, an older one, or one with an unreadable time: ask for a new one. */
  | { state: 'required' }
  /** A fresh probe that does not confirm the id: refused, with what Jev answered. */
  | { state: 'failed'; probe: EngineModelProbe }
  /** A fresh probe that confirms the id; `concrete` is the release it stands for. */
  | { state: 'ok'; probe: EngineModelProbe; concrete: string };

/**
 * Judges the stored probe of `model` at `nowMs`. A concrete id is confirmed only when Jev answered
 * that exact id; the alias only when Jev answered a concrete Jev release.
 */
export function judgeModelProbe(
  probes: Readonly<Record<string, EngineModelProbe>> | null | undefined,
  model: string,
  nowMs: number,
): ModelProbeVerdict {
  if (probes === null || probes === undefined || !Object.hasOwn(probes, model)) {
    return { state: 'required' };
  }
  const probe = probes[model];
  if (probe === undefined) return { state: 'required' };
  const age = nowMs - Date.parse(probe.at);
  if (!Number.isFinite(age) || age > MODEL_PROBE_MAX_AGE_MS || age < -MODEL_PROBE_MAX_SKEW_MS) {
    return { state: 'required' };
  }
  if (!probe.ok || probe.answered === undefined) return { state: 'failed', probe };
  if (isModelAlias(model)) {
    return isConcreteJevModel(probe.answered)
      ? { state: 'ok', probe, concrete: probe.answered }
      : { state: 'failed', probe };
  }
  return probe.answered === model
    ? { state: 'ok', probe, concrete: model }
    : { state: 'failed', probe };
}

/**
 * The concrete model a setting stands for: the id itself, or for the alias the stored resolution,
 * else the pinned model; `null` when nothing says (an alias that was never resolved on a fresh
 * install).
 */
export function concreteModelOf(
  setting: string,
  resolution: { model: string } | null | undefined,
  pin: { model: string } | null | undefined,
): string | null {
  if (!isModelAlias(setting)) return setting;
  const pinned = pin?.model;
  return resolution?.model ?? (pinned === undefined || isModelAlias(pinned) ? null : pinned);
}

/**
 * What a model change does to the data: `none` rebuilds nothing, `kept` analyses the window again
 * but keeps ratings and personal models (another release of one Jev major), `restart` resets
 * personal models (another family) and needs the eval-replay acknowledgement.
 */
export type ModelImpact = 'none' | 'kept' | 'restart';

const IMPACT_RANK: Record<ModelImpact, number> = { none: 0, kept: 1, restart: 2 };

/**
 * What moving from the concrete model `current` to the concrete model `target` does. An unknown
 * `current` counts as a restart, so the acknowledgement is never skipped on a guess.
 */
export function modelChangeImpact(current: string | null, target: string): ModelImpact {
  if (current === null) return 'restart';
  if (current === target) return 'none';
  return sameModelFamily(current, target) ? 'kept' : 'restart';
}

/** The worst impact of the legs `from` to `steps[0]` to `steps[1]` and so on (no steps: none). */
export function modelPathImpact(from: string | null, ...steps: readonly string[]): ModelImpact {
  let worst: ModelImpact = 'none';
  let previous = from;
  for (const next of steps) {
    const leg = modelChangeImpact(previous, next);
    if (IMPACT_RANK[leg] > IMPACT_RANK[worst]) worst = leg;
    previous = next;
  }
  return worst;
}

/** What the editor and the API know about the model setting. */
export interface ModelState {
  /** The effective `engine.typesafe_model`: a concrete id or `jev-latest`. */
  setting: string;
  /** `engine.model_resolution`: where the alias pointed when the worker last asked. */
  resolution: { model: string } | null;
  /** `engine.model_pin`: the model the stored analyses were made with. */
  pin: { model: string } | null;
  /** `engine.model_probe`: the newest probe results by requested id. */
  probes: Readonly<Record<string, EngineModelProbe>> | null | undefined;
}

export type ModelChangePlan =
  | { state: 'required' }
  | { state: 'failed'; probe: EngineModelProbe }
  | {
      state: 'ok';
      probe: EngineModelProbe;
      /** The concrete model in use now; `null` when nothing says. */
      current: string | null;
      /** The concrete model the change settles on (for the alias: what Jev answered). */
      concrete: string;
      impact: ModelImpact;
    };

/**
 * Plans moving the setting to `target` (a concrete id or `jev-latest`) at `nowMs`: whether a probe
 * confirms it and what the change does. A worker started on the alias uses the stored resolution at
 * any age before it asks Jev again, so a stale resolution counts as a step of the path.
 */
export function planModelChange(state: ModelState, target: string, nowMs: number): ModelChangePlan {
  const verdict = judgeModelProbe(state.probes, target, nowMs);
  if (verdict.state !== 'ok') return verdict;
  const current = concreteModelOf(state.setting, state.resolution, state.pin);
  const stale = isModelAlias(target) ? state.resolution?.model : undefined;
  const impact =
    stale !== undefined && stale !== verdict.concrete
      ? modelPathImpact(current, stale, verdict.concrete)
      : modelPathImpact(current, verdict.concrete);
  return { state: 'ok', probe: verdict.probe, current, concrete: verdict.concrete, impact };
}
