import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { useApi } from './context.js';
import { isApiError, type ApiError } from './errors.js';
import type { AnyRoute, CallOptions, RouteInput, RouteOutput } from './route.js';

type EmptyObject = Record<never, never>;

/**
 * What `mutate` takes: the route's input and, when an earlier attempt of the same intent is being
 * sent again, its `idempotencyKey`. The `variables` of a failed mutation carry theirs, so
 * `mutate(mutation.variables)` is a retry the server can recognise; so is the same input again.
 */
export type ApiMutationVariables<R extends AnyRoute> = RouteInput<R> & {
  idempotencyKey?: string | undefined;
};

type Variables<R extends AnyRoute> =
  EmptyObject extends ApiMutationVariables<R>
    ? ApiMutationVariables<R> | void
    : ApiMutationVariables<R>;

export type ApiMutationOptions<R extends AnyRoute, TContext = unknown> = Omit<
  UseMutationOptions<RouteOutput<R>, ApiError, Variables<R>, TContext>,
  'mutationFn'
>;

export type ApiMutationResult<R extends AnyRoute, TContext = unknown> = UseMutationResult<
  RouteOutput<R>,
  ApiError,
  Variables<R>,
  TContext
>;

type LooseCall = (route: AnyRoute, input: unknown, options: CallOptions) => Promise<unknown>;
type LooseMutate<Result> = (variables?: unknown, callbacks?: unknown) => Result;
type KeyedVariables = { idempotencyKey?: string };

/** The input of an attempt that failed, and its key. */
interface FailedAttempt {
  readonly input: string;
  readonly key: string;
}

/**
 * The input as canonical text, to tell whether the same input is being sent again; null when it
 * holds anything but plain data (a file is never taken for the same file).
 */
function canonical(value: unknown): string | null {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.includes(null) ? null : `[${items.join(',')}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const fields: string[] = [];
  for (const [name, field] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (field === undefined) continue;
    const text = canonical(field);
    if (text === null) return null;
    fields.push(`${JSON.stringify(name)}:${text}`);
  }
  return `{${fields.join(',')}}`;
}

/**
 * A mutation of one API route. Each `mutate()` is one user intent and gets its Idempotency-Key
 * there, not per attempt: TanStack's retries and a resent `variables` reuse it, and so does the
 * same input sent again after a failure (Save pressed again after a lost answer), so a request
 * that reached the server twice happens once (spec 08 §1.1). A failed request leaves no receipt,
 * so the reused key also serves a retry after a refusal. Once the intent has succeeded, the same
 * input is a new intent with a new key. Mutations are not retried automatically unless `retry`
 * says so.
 */
export function useApiMutation<R extends AnyRoute, TContext = unknown>(
  route: R,
  options: ApiMutationOptions<R, TContext> = {},
): ApiMutationResult<R, TContext> {
  const api = useApi();
  const failed = useRef<FailedAttempt | null>(null);
  const mutation = useMutation<RouteOutput<R>, ApiError, Variables<R>, TContext>({
    retry: false,
    ...options,
    mutationFn: async (variables) => {
      const { idempotencyKey, ...input } = (variables ?? {}) as KeyedVariables;
      try {
        const output = await (api.call as LooseCall)(route, input, { idempotencyKey });
        failed.current = null;
        return output as RouteOutput<R>;
      } catch (error) {
        const text = canonical(input);
        const elsewhere = isApiError(error) && error.code === 'IDEMPOTENCY_CONFLICT';
        failed.current =
          idempotencyKey === undefined || text === null || elsewhere
            ? null
            : { input: text, key: idempotencyKey };
        throw error;
      }
    },
  });

  const withKey = useCallback(
    (variables: unknown): unknown => {
      const given = (variables ?? {}) as KeyedVariables;
      if (!route.idempotent || given.idempotencyKey !== undefined) return variables;
      const last = failed.current;
      const again = last !== null && canonical(given) === last.input;
      return { ...given, idempotencyKey: again ? last.key : crypto.randomUUID() };
    },
    [route],
  );

  // TanStack's rest-argument types depend on `Variables<R>`, unresolved inside this generic.
  const mutate = mutation.mutate as LooseMutate<void>;
  const mutateAsync = mutation.mutateAsync as LooseMutate<Promise<RouteOutput<R>>>;
  const keyedMutate = useCallback(
    (variables?: unknown, callbacks?: unknown) => mutate(withKey(variables), callbacks),
    [mutate, withKey],
  );
  const keyedMutateAsync = useCallback(
    (variables?: unknown, callbacks?: unknown) => mutateAsync(withKey(variables), callbacks),
    [mutateAsync, withKey],
  );
  return {
    ...mutation,
    mutate: keyedMutate as ApiMutationResult<R, TContext>['mutate'],
    mutateAsync: keyedMutateAsync as ApiMutationResult<R, TContext>['mutateAsync'],
  };
}
