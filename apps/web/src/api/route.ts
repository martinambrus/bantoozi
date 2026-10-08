import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call an operation. `public` means the session cookie does not govern it (the login flow,
 * the waitlist, probes and the bearer-token host routes), so a 401 there never means "signed out".
 */
export type RouteAuth = 'public' | 'user' | 'admin';

/** The one part of the OPML upload form. */
export interface MultipartBody {
  file: Blob;
}

type ParamsSchema = z.ZodType | undefined;
type QuerySchema = z.ZodType | undefined;
type BodySchema = z.ZodType | 'multipart' | undefined;
type ResponseSpec = z.ZodType | 'text' | null;

/**
 * One HTTP operation of spec 08. `body` is a request schema, `'multipart'` for the OPML upload, or
 * absent; `response` is the schema of the 2xx body, `'text'` for a text download or `null` for
 * "no content".
 */
export interface Route<
  P extends ParamsSchema = ParamsSchema,
  Q extends QuerySchema = QuerySchema,
  B extends BodySchema = BodySchema,
  R extends ResponseSpec = ResponseSpec,
> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: RouteAuth;
  /** Authenticated mutations carry an `Idempotency-Key` (spec 08 §1.1). */
  readonly idempotent: boolean;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  readonly response: R;
}

export type AnyRoute = Route;

export interface RouteConfig<
  P extends ParamsSchema,
  Q extends QuerySchema,
  B extends BodySchema,
  R extends ResponseSpec,
> {
  method: HttpMethod;
  path: string;
  auth: RouteAuth;
  idempotent: boolean;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
}

export function defineRoute<
  P extends ParamsSchema = undefined,
  Q extends QuerySchema = undefined,
  B extends BodySchema = undefined,
  R extends ResponseSpec = null,
>(config: RouteConfig<P, Q, B, R>): Route<P, Q, B, R> {
  return {
    method: config.method,
    path: config.path,
    auth: config.auth,
    idempotent: config.idempotent,
    params: config.params as P,
    query: config.query as Q,
    body: config.body as B,
    response: config.response,
  };
}

type EmptyObject = Record<never, never>;

type Section<Key extends string, S> = S extends z.ZodType
  ? EmptyObject extends z.input<S>
    ? { [K in Key]?: z.input<S> }
    : { [K in Key]: z.input<S> }
  : unknown;

type BodySection<B> = B extends 'multipart' ? { body: MultipartBody } : Section<'body', B>;

/**
 * What a caller supplies: `params` for the `:name` segments of the path, `query` for the query
 * string and `body` for the request body. Each key exists only if the route has that part, and is
 * optional if its schema accepts `{}`. Request types are the schemas' inputs, so defaults and
 * coercions of the server's parsing are not repeated here.
 */
export type RouteInput<R extends AnyRoute> = Section<'params', R['params']> &
  Section<'query', R['query']> &
  BodySection<R['body']>;

/** What a successful call resolves to: the response schema's output, text, or nothing. */
export type RouteOutput<R extends AnyRoute> = R['response'] extends z.ZodType
  ? z.output<R['response']>
  : R['response'] extends 'text'
    ? string
    : undefined;

export interface CallOptions {
  /** Resend an earlier attempt of the same request under its key; otherwise a new one is made. */
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Let the request outlive the page (a dwell report sent while the tab is hidden). */
  keepalive?: boolean | undefined;
}

/** The input argument disappears when the route takes none and is optional when all of it is. */
export type CallArgs<R extends AnyRoute> =
  unknown extends RouteInput<R>
    ? [input?: undefined, options?: CallOptions]
    : EmptyObject extends RouteInput<R>
      ? [input?: RouteInput<R>, options?: CallOptions]
      : [input: RouteInput<R>, options?: CallOptions];
