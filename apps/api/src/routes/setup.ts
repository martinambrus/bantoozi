import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * First-run setup (M8b-T6): `GET /setup`, `POST /setup/complete`. No routes yet. Every route added
 * here uses the OpenAPI tag `setup` (`schema: { tags: ['setup'] }`).
 */
export const setupRoutes: FastifyPluginAsyncZod = async (_app) => {
  // M8b-T6
};
