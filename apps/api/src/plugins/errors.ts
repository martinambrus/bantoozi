import { mapDbError } from '@bantoozi/db';
import { AppError, isAppError, type ErrorResponse } from '@bantoozi/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * The single place that maps errors to HTTP (spec 01 §5, spec 08 §1): `{error: {code, message,
 * details?}}` with the status of the code. Known database errors become application codes; anything
 * else is a generic 500 carrying only the request id, so internal text never reaches a client.
 */
function envelope(error: AppError): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
    },
  };
}

function toAppError(error: unknown, requestId: string): AppError {
  if (isAppError(error)) return error;
  const fastifyError = error as Partial<FastifyError>;
  // Schema validation, malformed JSON, unsupported media types and oversized bodies: Fastify's own
  // client (4xx) errors.
  const status = fastifyError.statusCode ?? 500;
  if (
    fastifyError.validation !== undefined ||
    (fastifyError.code?.startsWith('FST_') === true && status >= 400 && status < 500)
  ) {
    return new AppError('VALIDATION_FAILED', 'Invalid request', { cause: error });
  }
  const mapped = mapDbError(error);
  if (mapped !== undefined) return mapped;
  return new AppError('INTERNAL', 'Internal error', { details: { requestId }, cause: error });
}

/** Installed on the root instance, so every route and plugin shares it. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    const appError = toAppError(error, request.id);
    if (appError.code === 'INTERNAL') request.log.error({ err: error }, 'unhandled error');
    await reply.code(appError.httpStatus).send(envelope(appError));
  });
  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(envelope(new AppError('NOT_FOUND', 'Not found')));
  });
}
