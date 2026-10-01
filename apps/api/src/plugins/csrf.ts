import { AppError } from '@bantoozi/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isMetricsBearer, routeAuthMode } from './auth.js';

/**
 * CSRF (spec 08 §1). Every non-GET/HEAD/OPTIONS request must carry `X-Bantoozi-Client: web`, which a
 * browser cannot send cross-site without a CORS preflight (and CORS is disabled). A present `Origin`
 * must equal the origin of `PUBLIC_BASE_URL` (`null` and malformed origins fail), and
 * `Sec-Fetch-Site: cross-site` is refused. Requests authenticated by the `METRICS_TOKEN` bearer on
 * the bearer routes are exempt: host scripts send no cookie.
 */

export const CLIENT_HEADER = 'x-bantoozi-client';
export const CLIENT_HEADER_VALUE = 'web';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const forbidden = (reason: string) =>
  new AppError('FORBIDDEN', 'Cross-site request refused', { details: { reason } });

export function checkCsrf(request: FastifyRequest, publicOrigin: string): void {
  if (request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) throw forbidden('client_header');
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed: string;
    try {
      parsed = new URL(origin).origin;
    } catch {
      throw forbidden('origin');
    }
    // `new URL('null')` throws; an opaque origin string never equals a tuple origin.
    if (parsed !== publicOrigin || origin !== publicOrigin) throw forbidden('origin');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw forbidden('fetch_site');
}

export function registerCsrf(app: FastifyInstance): void {
  const publicOrigin = new URL(app.services.config.publicBaseUrl).origin;
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method) || request.is404) return;
    const mode = routeAuthMode(request);
    if (
      (mode === 'metrics' || mode === 'admin_or_metrics') &&
      isMetricsBearer(request, app.services.config.metricsToken)
    ) {
      return;
    }
    checkCsrf(request, publicOrigin);
  });
}
