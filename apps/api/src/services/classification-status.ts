import type { ClassificationStatus, EngineCircuit, EngineModelPin } from '@bantoozi/shared';

type Progress = Record<string, { updatedAt: string; completedAt?: string | undefined }>;

const REBUILD_JOBS = ['house.reenrich', 'house.rematch'] as const;
const OK: ClassificationStatus = { state: 'ok', since: null, reason: null };

const ms = (value: string | undefined): number => (value === undefined ? NaN : Date.parse(value));

/**
 * Whether analysis is paused for everyone: the Jev breaker is not closed, or a rebuild after a
 * model change is still running. Absent or unparsable inputs count as not paused.
 */
export function classificationStatus(input: {
  circuit: EngineCircuit | undefined;
  pin: EngineModelPin | undefined;
  progress: Progress | undefined;
}): ClassificationStatus {
  const breaker = input.circuit?.typesafe;
  if (breaker !== undefined && breaker.state !== 'closed') {
    return {
      state: 'paused',
      since: breaker.failingSince ?? breaker.openedAt ?? null,
      reason: 'engine_unavailable',
    };
  }
  const { pin, progress } = input;
  if (pin === undefined || progress === undefined) return OK;
  const pinned = ms(pin.since);
  if (Number.isNaN(pinned)) return OK;
  const rebuilding = REBUILD_JOBS.some((job) => {
    const entry = progress[job];
    if (entry === undefined || !(ms(entry.updatedAt) >= pinned)) return false;
    return entry.completedAt === undefined || !(ms(entry.completedAt) >= pinned);
  });
  return rebuilding ? { state: 'paused', since: pin.since, reason: 'model_upgrade' } : OK;
}
