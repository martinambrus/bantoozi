/**
 * Server-only credential ports (spec 04 §1). The resolver is composed in the worker/eval apps over
 * the encrypted DB repository and `credential-crypto`; it unwraps a key in memory for one provider
 * request. Never serialize or log a `ProviderAuth`.
 */
export type CredentialSource = 'none' | 'env' | 'db';

export interface ProviderAuth {
  apiKey: string;
  source: 'db' | 'env';
  credentialVersion?: string;
}

export interface CredentialResolver {
  metadata(provider: 'typesafe' | 'ollama'): Promise<{
    source: CredentialSource;
    enabled: boolean;
    revision?: string;
    activeVersion?: string;
  }>;
  useActive<T>(
    provider: 'typesafe' | 'ollama',
    signal: AbortSignal,
    send: (auth: ProviderAuth) => Promise<T>,
  ): Promise<T>;
  /** `provider.validate` only. */
  useCandidate<T>(
    provider: 'typesafe' | 'ollama',
    candidateVersion: string,
    validationToken: string,
    signal: AbortSignal,
    send: (auth: ProviderAuth) => Promise<T>,
  ): Promise<T>;
}
