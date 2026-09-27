import {
  readActiveCredentialSecret,
  readCandidateCredentialSecret,
  readCredentialMetadata,
  sqlState,
  type Database,
} from '@bantoozi/db';
import { AppError } from '@bantoozi/shared';
import type { CredentialResolver, CredentialSource, ProviderAuth } from '@bantoozi/shared/server';
import {
  CredentialCryptoError,
  decryptProviderSecret,
  ProviderKeyring,
  type KeyringUnavailableReason,
} from '@bantoozi/shared/server/credential-crypto';

/**
 * The worker's server-only {@link CredentialResolver} (spec 04 §1.2): the encrypted
 * `provider_credentials` row, the host keyring (`PROVIDER_MASTER_KEY_ID`/`PROVIDER_MASTER_KEYS`) and
 * the optional bootstrap keys `TYPESAFE_API_KEY`/`OLLAMA_API_KEY`.
 *
 * - `useActive` re-reads the row immediately before every wire attempt and decrypts the active
 *   envelope in memory for that one `send`; plaintext is never cached between attempts.
 * - An environment key is used **only while no row exists** for that provider. A staged row without
 *   an active key is `pending`, a disabled (revoked) row is `disabled`: both are unavailable and
 *   deliberately block the environment fallback, as does any read or decryption failure (never an
 *   older key).
 * - Failures raise {@link CredentialUnavailableError} (`ENGINE_UNAVAILABLE` with a typed reason and
 *   no crypto, database or provider payload), which the router turns into `no_key`.
 * - `useCandidate` serves `provider.validate` only: the candidate envelope under its live lease.
 * - `metadata` reads no envelope; it is polled at most every `metadataTtlMs` (default 10 s) per
 *   provider, and `fresh` reads (and caches) the row at once. Admission never relies on the cache:
 *   `useActive` rechecks the row, and a refusal reads it fresh.
 */

export type CredentialProvider = 'typesafe' | 'ollama';

export const CREDENTIAL_UNAVAILABLE_REASONS = [
  /** No row and no bootstrap environment key. */
  'none',
  /** A disabled row or revocation tombstone: blocks the environment fallback. */
  'disabled',
  /** A staged candidate without an active key: blocks the environment fallback. */
  'pending',
  /** `PROVIDER_MASTER_KEY_ID`/`PROVIDER_MASTER_KEYS` missing or malformed on this host. */
  'keyring_unavailable',
  /** Unknown wrapping key id, or a modified or malformed envelope. */
  'decrypt_failed',
  /** The database read failed. */
  'lookup_failed',
  /** `useCandidate`: the validation lease is no longer this token's (revoked, re-staged, expired). */
  'lease_lost',
] as const;
export type CredentialUnavailableReason = (typeof CREDENTIAL_UNAVAILABLE_REASONS)[number];

/** A typed unavailable credential; carries no cause, key material or provider text. */
export class CredentialUnavailableError extends AppError {
  readonly provider: CredentialProvider;
  readonly reason: CredentialUnavailableReason;

  constructor(provider: CredentialProvider, reason: CredentialUnavailableReason) {
    super('ENGINE_UNAVAILABLE', `No usable ${provider} credential (${reason})`, {
      details: { provider, reason },
    });
    this.name = 'CredentialUnavailableError';
    this.provider = provider;
    this.reason = reason;
  }
}

export function isCredentialUnavailableError(error: unknown): error is CredentialUnavailableError {
  return error instanceof CredentialUnavailableError;
}

/** The host keyring without key bytes: ids only. */
export type KeyringState =
  | { ok: true; activeKeyId: string; keyIds: string[] }
  | { ok: false; reason: KeyringUnavailableReason };

export interface CredentialLogger {
  warn(obj: object, msg: string): void;
}

export interface WorkerCredentialResolverOptions {
  db: Database;
  /** `PROVIDER_MASTER_KEY_ID`: the wrapping key of new writes. */
  masterKeyId: string | undefined;
  /** `PROVIDER_MASTER_KEYS`: the raw JSON keyring (secret). */
  masterKeys: string | undefined;
  /** `TYPESAFE_API_KEY`/`OLLAMA_API_KEY`: bootstrap keys, used only while no row exists. */
  envKeys?: Partial<Record<CredentialProvider, string | undefined>>;
  logger?: CredentialLogger;
  /** Metadata poll interval per provider (spec 04 §1.2 step 5); 0 disables caching. Default 10 s. */
  metadataTtlMs?: number;
  /** Clock for the metadata cache (tests). */
  now?: () => number;
}

export interface WorkerCredentialResolver extends CredentialResolver {
  /** The keyring's state with ids only (status output, diagnostics). */
  keyring(): KeyringState;
}

export const DEFAULT_METADATA_TTL_MS = 10_000;

type Metadata = Awaited<ReturnType<CredentialResolver['metadata']>>;

function assertProvider(provider: string): asserts provider is CredentialProvider {
  if (provider !== 'typesafe' && provider !== 'ollama') {
    throw new AppError('VALIDATION_FAILED', 'Unknown provider');
  }
}

export function createWorkerCredentialResolver(
  options: WorkerCredentialResolverOptions,
): WorkerCredentialResolver {
  const { db } = options;
  const parsed = ProviderKeyring.parse(options.masterKeyId, options.masterKeys);
  const envKeys: Partial<Record<CredentialProvider, string>> = {};
  for (const provider of ['typesafe', 'ollama'] as const) {
    const key = options.envKeys?.[provider];
    if (typeof key === 'string' && key.trim() !== '') envKeys[provider] = key;
  }
  const ttlMs = options.metadataTtlMs ?? DEFAULT_METADATA_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('metadataTtlMs must be >= 0');
  const now = options.now ?? Date.now;
  const cache = new Map<CredentialProvider, { at: number; value: Metadata }>();
  /** The last unavailable reason logged per provider: a persistent failure is logged once. */
  const reported = new Map<CredentialProvider, string>();

  function unavailable(
    provider: CredentialProvider,
    reason: CredentialUnavailableReason,
    diagnostic: Record<string, string | null> = {},
  ): CredentialUnavailableError {
    // Operators need to see host problems (keyring, decryption, database) once, never a payload.
    if (reason !== 'none' && reason !== 'lease_lost') {
      const key = `${reason}:${JSON.stringify(diagnostic)}`;
      if (reported.get(provider) !== key) {
        reported.set(provider, key);
        options.logger?.warn(
          { provider, reason, ...diagnostic },
          'provider credential unavailable',
        );
      }
    }
    return new CredentialUnavailableError(provider, reason);
  }

  /** Decrypt one envelope for one send; failures are typed, without crypto detail. */
  function decrypt(provider: CredentialProvider, secretVersion: string, envelope: unknown): string {
    if (!parsed.ok) {
      throw unavailable(provider, 'keyring_unavailable', { keyring: parsed.reason });
    }
    try {
      const secret = decryptProviderSecret({
        keyring: parsed.keyring,
        provider,
        secretVersion,
        envelope,
      });
      reported.delete(provider);
      return secret;
    } catch (error) {
      throw unavailable(provider, 'decrypt_failed', {
        cryptoCode: error instanceof CredentialCryptoError ? error.code : 'UNKNOWN',
      });
    }
  }

  return {
    keyring(): KeyringState {
      return parsed.ok
        ? { ok: true, activeKeyId: parsed.keyring.activeKeyId, keyIds: parsed.keyring.keyIds }
        : { ok: false, reason: parsed.reason };
    },

    async metadata(provider, options) {
      assertProvider(provider);
      const hit = options?.fresh === true ? undefined : cache.get(provider);
      if (hit !== undefined && ttlMs > 0 && now() - hit.at < ttlMs) return { ...hit.value };
      const row = await readCredentialMetadata(db, provider);
      let value: Metadata;
      if (row === null) {
        const source: CredentialSource = envKeys[provider] === undefined ? 'none' : 'env';
        value = { source, enabled: source === 'env' };
      } else {
        value = {
          source: 'db',
          enabled: row.enabled,
          revision: row.revision,
          ...(row.activeVersion === null ? {} : { activeVersion: row.activeVersion }),
        };
      }
      cache.set(provider, { at: now(), value });
      return { ...value };
    },

    async useActive<T>(
      provider: CredentialProvider,
      _signal: AbortSignal,
      send: (auth: ProviderAuth) => Promise<T>,
    ): Promise<T> {
      assertProvider(provider);
      let secret: Awaited<ReturnType<typeof readActiveCredentialSecret>>;
      try {
        secret = await readActiveCredentialSecret(db, provider);
      } catch (error) {
        throw unavailable(provider, 'lookup_failed', { sqlState: sqlState(error) ?? null });
      }
      if (secret.state === 'missing') {
        const envKey = envKeys[provider];
        if (envKey === undefined) throw unavailable(provider, 'none');
        return send({ apiKey: envKey, source: 'env' });
      }
      if (!secret.enabled || secret.activeVersion === null) {
        const pending = secret.activeVersion === null && secret.candidateVersion !== null;
        throw unavailable(provider, pending ? 'pending' : 'disabled');
      }
      const apiKey = decrypt(provider, secret.activeVersion, secret.envelope);
      return send({ apiKey, source: 'db', credentialVersion: secret.activeVersion });
    },

    async useCandidate<T>(
      provider: CredentialProvider,
      candidateVersion: string,
      validationToken: string,
      _signal: AbortSignal,
      send: (auth: ProviderAuth) => Promise<T>,
    ): Promise<T> {
      assertProvider(provider);
      let candidate: Awaited<ReturnType<typeof readCandidateCredentialSecret>>;
      try {
        candidate = await readCandidateCredentialSecret(db, {
          provider,
          candidateVersion,
          validationToken,
        });
      } catch (error) {
        throw unavailable(provider, 'lookup_failed', { sqlState: sqlState(error) ?? null });
      }
      if (candidate === null) throw unavailable(provider, 'lease_lost');
      const apiKey = decrypt(provider, candidateVersion, candidate.envelope);
      return send({ apiKey, source: 'db', credentialVersion: candidateVersion });
    },
  };
}

/** The resolver of a worker/eval process from its configuration (spec 01 §3 variable names). */
export function credentialResolverFromConfig(
  db: Database,
  config: {
    providerMasterKeyId: string | undefined;
    providerMasterKeys: string | undefined;
    typesafeApiKey: string | undefined;
    ollamaApiKey: string | undefined;
  },
  logger?: CredentialLogger,
): WorkerCredentialResolver {
  return createWorkerCredentialResolver({
    db,
    masterKeyId: config.providerMasterKeyId,
    masterKeys: config.providerMasterKeys,
    envKeys: { typesafe: config.typesafeApiKey, ollama: config.ollamaApiKey },
    ...(logger === undefined ? {} : { logger }),
  });
}
