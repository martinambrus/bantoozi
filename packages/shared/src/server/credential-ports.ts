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
  /**
   * The provider's credential state, without key material. It may be cached for up to 10 s (the UI
   * poll, spec 04 §1.2 step 5); `fresh` reads the row again, as a decision to admit or refuse work
   * must.
   */
  metadata(
    provider: 'typesafe' | 'ollama',
    options?: { fresh?: boolean },
  ): Promise<{
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
