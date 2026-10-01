import { readActiveCredentialSecret, readCredentialMetadata, type Database } from '@bantoozi/db';
import { AppError } from '@bantoozi/shared';
import type { CredentialResolver, ProviderAuth } from '@bantoozi/shared/server';
import { decryptProviderSecret, ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';

/**
 * The eval process's server-only credential resolver (spec 04 §1.2, spec 10 M3b "active Jev/Ollama
 * credentials through the encrypted database resolver (or authorized first-use environment
 * bootstrap)"). It follows the worker's rules without its metadata cache: the encrypted
 * `provider_credentials` row is read and decrypted for each attempt and never kept; an environment
 * key (`TYPESAFE_API_KEY`/`OLLAMA_API_KEY`) is used only while no row exists; a disabled or pending
 * row and any read or decryption failure make the provider unavailable (`ENGINE_UNAVAILABLE` with a
 * typed reason and no key material, which the router reports as `no_key`). Eval never validates a
 * candidate key, so `useCandidate` is refused.
 */

type Provider = 'typesafe' | 'ollama';

function unavailable(provider: Provider, reason: string): AppError {
  return new AppError('ENGINE_UNAVAILABLE', `No usable ${provider} credential (${reason})`, {
    details: { provider, reason },
  });
}

export interface EvalCredentialOptions {
  db: Database;
  masterKeyId: string | undefined;
  masterKeys: string | undefined;
  envKeys: Partial<Record<Provider, string | undefined>>;
}

export function createEvalCredentialResolver(options: EvalCredentialOptions): CredentialResolver {
  const keyring = ProviderKeyring.parse(options.masterKeyId, options.masterKeys);
  const envKey = (provider: Provider): string | undefined => {
    const key = options.envKeys[provider];
    return typeof key === 'string' && key.trim() !== '' ? key : undefined;
  };

  return {
    async metadata(provider) {
      const row = await readCredentialMetadata(options.db, provider);
      if (row === null) {
        const source = envKey(provider) === undefined ? 'none' : 'env';
        return { source, enabled: source === 'env' };
      }
      return {
        source: 'db',
        enabled: row.enabled,
        revision: row.revision,
        ...(row.activeVersion === null ? {} : { activeVersion: row.activeVersion }),
      };
    },

    async useActive<T>(
      provider: Provider,
      _signal: AbortSignal,
      send: (auth: ProviderAuth) => Promise<T>,
    ): Promise<T> {
      let secret: Awaited<ReturnType<typeof readActiveCredentialSecret>>;
      try {
        secret = await readActiveCredentialSecret(options.db, provider);
      } catch {
        throw unavailable(provider, 'lookup_failed');
      }
      if (secret.state === 'missing') {
        const key = envKey(provider);
        if (key === undefined) throw unavailable(provider, 'none');
        return send({ apiKey: key, source: 'env' });
      }
      if (!secret.enabled || secret.activeVersion === null) {
        const pending = secret.activeVersion === null && secret.candidateVersion !== null;
        throw unavailable(provider, pending ? 'pending' : 'disabled');
      }
      if (!keyring.ok) throw unavailable(provider, 'keyring_unavailable');
      let apiKey: string;
      try {
        apiKey = decryptProviderSecret({
          keyring: keyring.keyring,
          provider,
          secretVersion: secret.activeVersion,
          envelope: secret.envelope,
        });
      } catch {
        throw unavailable(provider, 'decrypt_failed');
      }
      return send({ apiKey, source: 'db', credentialVersion: secret.activeVersion });
    },

    async useCandidate() {
      throw new AppError('VALIDATION_FAILED', 'eval never validates candidate credentials');
    },
  };
}
