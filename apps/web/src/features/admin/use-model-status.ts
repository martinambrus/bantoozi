import {
  planModelChange,
  type AdminEngineModel,
  type EngineModelProbe,
  type ModelChangePlan,
  type ModelState,
} from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { useSignInLasts } from '../../session/context.js';
import { useAdminKey } from './use-admin.js';

/** How often the status is read while the editor waits for the worker. */
export const MODEL_POLL_MS = 1500;
/** The worker's probe deadline is 60 s; the rest is the outbox relay and the queue pick-up. */
export const MODEL_WAIT_MS = 90_000;
/**
 * A stored probe is reused only if it will still be usable this much later on the API clock: the
 * API accepts one for 10 minutes, and the person may take a while over the dialog.
 */
export const MODEL_REUSE_SLACK_MS = 2 * 60_000;

export type OkPlan = Extract<ModelChangePlan, { state: 'ok' }>;

export type ProbeOutcome =
  | { state: 'ok'; plan: OkPlan; status: AdminEngineModel }
  | { state: 'failed'; probe: EngineModelProbe }
  | { state: 'timeout' }
  | { state: 'cancelled' };

export type CheckOutcome =
  { state: 'done'; status: AdminEngineModel } | { state: 'timeout' } | { state: 'cancelled' };

export type ModelRun = { name: 'idle' } | { name: 'probing'; model: string } | { name: 'checking' };

export function stateOf(status: AdminEngineModel): ModelState {
  return {
    setting: status.setting.value,
    resolution: status.resolution,
    pin: status.pin,
    probes: status.probes,
  };
}

/** A status read with the API clock at the moment of reading. */
interface StatusRead {
  status: AdminEngineModel;
  serverNow: () => number;
}

function lastCheckMs(status: AdminEngineModel): number {
  const times = [status.watch.lastCheck?.at, status.resolution?.checkedAt]
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter(Number.isFinite);
  return times.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...times);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * The model status and the two waits on the worker (a probe of a value, a check of the alias). A
 * wait is one run that ends with an outcome; a second run is refused, and unmounting, `cancel` or
 * the end of the sign-in stop it without a word.
 */
export function useModelStatus() {
  const api = useApi();
  const queryClient = useQueryClient();
  const adminKey = useAdminKey();
  const lasts = useSignInLasts();
  const key = useMemo(() => adminKey('model-status'), [adminKey]);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.call(routes.adminEngineModelGet, undefined, { signal }),
  });
  const probe = useApiMutation(routes.adminEngineModelProbe);
  const check = useApiMutation(routes.adminEngineModelCheck);
  const { mutateAsync: sendProbe } = probe;
  const { mutateAsync: sendCheck } = check;
  const running = useRef<AbortController | null>(null);
  const [run, setRun] = useState<ModelRun>({ name: 'idle' });

  useEffect(() => () => running.current?.abort(), []);

  const read = useCallback(
    async (signal: AbortSignal): Promise<StatusRead> => {
      const status = await api.call(routes.adminEngineModelGet, undefined, { signal });
      const offset = Date.parse(status.now) - Date.now();
      if (signal.aborted || !lasts()) throw new DOMException('aborted', 'AbortError');
      writeQueryData<AdminEngineModel>(queryClient, key, () => status);
      return { status, serverNow: () => Date.now() + offset };
    },
    [api, key, lasts, queryClient],
  );

  const pollUntil = useCallback(
    async <T>(
      signal: AbortSignal,
      found: (read: StatusRead) => T | undefined,
    ): Promise<T | 'timeout'> => {
      const stop = Date.now() + MODEL_WAIT_MS;
      while (Date.now() < stop) {
        await sleep(MODEL_POLL_MS, signal);
        const result = found(await read(signal));
        if (result !== undefined) return result;
      }
      return 'timeout';
    },
    [read],
  );

  const exclusive = useCallback(
    async <T extends { state: string }>(
      next: ModelRun,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | { state: 'cancelled' }> => {
      if (running.current !== null) return { state: 'cancelled' };
      const controller = new AbortController();
      running.current = controller;
      setRun(next);
      try {
        const outcome = await work(controller.signal);
        return controller.signal.aborted || !lasts() ? { state: 'cancelled' } : outcome;
      } catch (error) {
        if (
          controller.signal.aborted ||
          !lasts() ||
          (isApiError(error) && error.kind === 'aborted')
        )
          return { state: 'cancelled' };
        throw error;
      } finally {
        if (running.current === controller) running.current = null;
        setRun({ name: 'idle' });
      }
    },
    [lasts],
  );

  /** A probe of `target` that is good for a save: a fresh stored one, else one the worker makes. */
  const ensureProbe = useCallback(
    (target: string): Promise<ProbeOutcome> =>
      exclusive<ProbeOutcome>({ name: 'probing', model: target }, async (signal) => {
        const first = await read(signal);
        const reusable = planModelChange(
          stateOf(first.status),
          target,
          first.serverNow() + MODEL_REUSE_SLACK_MS,
        );
        if (reusable.state === 'ok') return { state: 'ok', plan: reusable, status: first.status };
        const baseline = first.status.probes[target]?.at;
        const baselineMs = baseline === undefined ? Number.NEGATIVE_INFINITY : Date.parse(baseline);
        await sendProbe({ body: { model: target } });
        if (signal.aborted || !lasts()) return { state: 'cancelled' };
        const outcome = await pollUntil<ProbeOutcome>(signal, ({ status, serverNow }) => {
          const landed = status.probes[target];
          if (landed === undefined || !(Date.parse(landed.at) > baselineMs)) return undefined;
          const plan = planModelChange(stateOf(status), target, serverNow());
          if (plan.state === 'ok') return { state: 'ok', plan, status };
          if (plan.state === 'failed') return { state: 'failed', probe: plan.probe };
          return undefined;
        });
        return outcome === 'timeout' ? { state: 'timeout' } : outcome;
      }),
    [exclusive, lasts, pollUntil, read, sendProbe],
  );

  const checkNow = useCallback(
    (): Promise<CheckOutcome> =>
      exclusive<CheckOutcome>({ name: 'checking' }, async (signal) => {
        const baseline = lastCheckMs((await read(signal)).status);
        await sendCheck();
        if (signal.aborted || !lasts()) return { state: 'cancelled' };
        const outcome = await pollUntil<CheckOutcome>(signal, ({ status }) =>
          lastCheckMs(status) > baseline ? { state: 'done', status } : undefined,
        );
        return outcome === 'timeout' ? { state: 'timeout' } : outcome;
      }),
    [exclusive, lasts, pollUntil, read, sendCheck],
  );

  const cancel = useCallback(() => running.current?.abort(), []);

  return { query, run, ensureProbe, checkNow, cancel };
}
