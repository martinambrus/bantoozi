import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import { useApi } from './context.js';
import type { ApiError } from './errors.js';
import type { AnyRoute, CallOptions, RouteInput, RouteOutput } from './route.js';

type EmptyObject = Record<never, never>;

/**
 * What `mutate` takes: the route's input and, when an earlier attempt of the same intent is being
 * sent again, its `idempotencyKey`. The `variables` of a failed mutation carry theirs, so
 * `mutate(mutation.variables)` is a retry the server can recognise.
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

function withKey<V>(route: AnyRoute, variables: V): V {
  const given = (variables ?? {}) as KeyedVariables;
  if (!route.idempotent || given.idempotencyKey !== undefined) return variables;
  return { ...given, idempotencyKey: crypto.randomUUID() } as V;
}

/**
 * A mutation of one API route. Each `mutate()` is one user intent and gets its Idempotency-Key
 * there, not per attempt: TanStack's retries and a resent `variables` reuse it, so a request that
 * reached the server twice happens once (spec 08 §1.1). Mutations are not retried automatically
 * unless `retry` says so.
 */
export function useApiMutation<R extends AnyRoute, TContext = unknown>(
  route: R,
  options: ApiMutationOptions<R, TContext> = {},
): ApiMutationResult<R, TContext> {
  const api = useApi();
  const mutation = useMutation<RouteOutput<R>, ApiError, Variables<R>, TContext>({
    retry: false,
    ...options,
    mutationFn: async (variables) => {
      const { idempotencyKey, ...input } = (variables ?? {}) as KeyedVariables;
      const output = await (api.call as LooseCall)(route, input, { idempotencyKey });
      return output as RouteOutput<R>;
    },
  });

  // TanStack's rest-argument types depend on `Variables<R>`, unresolved inside this generic.
  const mutate = mutation.mutate as LooseMutate<void>;
  const mutateAsync = mutation.mutateAsync as LooseMutate<Promise<RouteOutput<R>>>;
  const keyedMutate = useCallback(
    (variables?: unknown, callbacks?: unknown) => mutate(withKey(route, variables), callbacks),
    [mutate, route],
  );
  const keyedMutateAsync = useCallback(
    (variables?: unknown, callbacks?: unknown) => mutateAsync(withKey(route, variables), callbacks),
    [mutateAsync, route],
  );
  return {
    ...mutation,
    mutate: keyedMutate as ApiMutationResult<R, TContext>['mutate'],
    mutateAsync: keyedMutateAsync as ApiMutationResult<R, TContext>['mutateAsync'],
  };
}
