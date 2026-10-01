import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * OpenAPI (spec 08 §1 "Schemas", §12 "Snapshots"): every route's zod schemas are converted by the
 * type provider's transform. The document is served at `/api/v1/openapi.json`; in production only
 * an admin session may read it.
 */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Bantoozi API', version: '1.0.0' },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'bantoozi_sid' },
          metricsToken: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
}

/** The route serving the document; registered under the API prefix. */
export async function openApiRoute(app: FastifyInstance): Promise<void> {
  const production = app.services.config.nodeEnv === 'production';
  app.get(
    '/openapi.json',
    { config: { auth: production ? 'admin' : 'public' }, schema: { hide: true } },
    async (_request, reply) => {
      await reply.header('cache-control', 'no-store').send(app.swagger());
    },
  );
}
