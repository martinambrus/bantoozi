import { z } from 'zod';

import { BigIntStringSchema } from '../ids.js';

/**
 * Provider credential metadata registry (spec 02 §2.1, spec 04 §1.2, spec 08 §9.1). Only these
 * allowlisted, non-secret fields ever leave the database: never an envelope, a key, part of a key
 * or a hash of a key.
 */
export const PROVIDERS = ['typesafe', 'ollama'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

export const CandidateStatusSchema = z.enum(['pending', 'validating', 'valid', 'invalid']);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

/** Sanitized, bounded error codes (never raw provider text). */
export const CredentialErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * `provider_credentials.candidate_validation`: allowlisted health/capability metadata recorded by
 * `provider.validate` (spec 04 §1.2).
 */
export const CandidateValidationSchema = z
  .object({
    /** Hash of the tested endpoint/model policy, compared again at activation. */
    configFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    model: z.string().max(200).optional(),
    checkedAt: z.iso.datetime({ offset: true }).optional(),
    /** Account concurrency limit when the provider reports one; unknown stays conservative. */
    concurrencyLimit: z.number().int().min(1).max(10_000).optional(),
    capabilities: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.boolean())
      .refine((c) => Object.keys(c).length <= 32, 'too many capability flags')
      .optional(),
    latencyMs: z.number().int().min(0).max(600_000).optional(),
    attempts: z.number().int().min(0).max(3).optional(),
    errorCode: CredentialErrorCodeSchema.optional(),
  })
  .strict();
export type CandidateValidation = z.infer<typeof CandidateValidationSchema>;

/** What `admin_provider_credentials_metadata()` and the admin API return. */
export const ProviderCredentialMetadataSchema = z
  .object({
    provider: ProviderSchema,
    /** `env` only while no row exists and a bootstrap env key is present on a worker. */
    source: z.enum(['none', 'env', 'db']),
    revision: BigIntStringSchema,
    enabled: z.boolean(),
    activeVersion: BigIntStringSchema.nullable(),
    candidateVersion: BigIntStringSchema.nullable(),
    candidateStatus: CandidateStatusSchema.nullable(),
    candidateValidation: CandidateValidationSchema,
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
    activatedAt: z.iso.datetime({ offset: true }).nullable(),
    validatedAt: z.iso.datetime({ offset: true }).nullable(),
    lastErrorCode: CredentialErrorCodeSchema.nullable(),
  })
  .strict();
export type ProviderCredentialMetadata = z.infer<typeof ProviderCredentialMetadataSchema>;
