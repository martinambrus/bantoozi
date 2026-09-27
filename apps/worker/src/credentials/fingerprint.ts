import { canonicalJson } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';

import type { CredentialProvider } from './resolver.js';

/** The host configuration a provider's key is validated against (spec 01 §3 names). */
export interface ProviderEndpointConfig {
  typesafeBaseUrl: string;
  typesafeModel: string;
  ollamaBaseUrl: string;
  ollamaModelFast: string;
  ollamaModelStrong: string;
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

/**
 * The endpoint/model-policy fingerprint of a provider (spec 04 §1.2 step 3): `provider.validate`
 * records it with a valid result and activation requires the current one to be equal, so a key
 * validated against another endpoint or pinned model is never activated silently. A hex SHA-256
 * of canonical JSON; it contains no key material.
 */
export function providerConfigFingerprint(
  provider: CredentialProvider,
  config: ProviderEndpointConfig,
): string {
  const policy =
    provider === 'typesafe'
      ? {
          v: 1,
          provider,
          baseUrl: trimSlashes(config.typesafeBaseUrl),
          model: config.typesafeModel,
        }
      : {
          v: 1,
          provider,
          baseUrl: trimSlashes(config.ollamaBaseUrl),
          models: { fast: config.ollamaModelFast, strong: config.ollamaModelStrong },
        };
  return sha256Hex(canonicalJson(policy));
}
