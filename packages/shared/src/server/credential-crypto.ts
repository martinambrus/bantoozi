import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { z } from 'zod';

import { canonicalJson } from '../text/canonical-json.js';

/**
 * Provider credential envelopes (spec 04 §1.2, format 1) — Node-only, never imported by the web
 * client (ESLint boundary, spec 01 §3). A fresh random 32-byte data key encrypts each secret with
 * AES-256-GCM; a host-only master key (selected by `key_id` from `PROVIDER_MASTER_KEYS`) wraps that
 * data key with AES-256-GCM. Both use independent fresh 12-byte nonces and 16-byte tags. The
 * authenticated data binds `{format, provider, secretVersion, purpose}`, so a ciphertext cannot be
 * replayed under another provider, version or purpose. Plaintext is never used before `final()`
 * has verified the tag. Errors never contain key material, plaintext or crypto library detail.
 */

export const ENVELOPE_FORMAT = 1;
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** API keys: at most 4 KiB of UTF-8 (spec 04 §1.2). */
export const MAX_SECRET_BYTES = 4096;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type CredentialProvider = 'typesafe' | 'ollama';

export type CredentialCryptoErrorCode =
  | 'KEYRING_UNAVAILABLE'
  | 'UNKNOWN_KEY_ID'
  | 'INVALID_ENVELOPE'
  | 'DECRYPT_FAILED'
  | 'INVALID_SECRET';

export class CredentialCryptoError extends Error {
  readonly code: CredentialCryptoErrorCode;
  constructor(code: CredentialCryptoErrorCode, message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
    this.code = code;
  }
}

const base64Bytes = (min: number, max: number) =>
  z
    .string()
    .regex(BASE64_PATTERN, 'must be base64')
    .refine((s) => {
      const n = Buffer.from(s, 'base64').length;
      return n >= min && n <= max;
    }, 'wrong length');

/** Envelope shape and byte lengths, validated before storage and before use. */
export const CredentialEnvelopeSchema = z
  .object({
    format: z.literal(ENVELOPE_FORMAT),
    key_id: z.string().regex(KEY_ID_PATTERN),
    nonce: base64Bytes(NONCE_BYTES, NONCE_BYTES),
    tag: base64Bytes(TAG_BYTES, TAG_BYTES),
    ciphertext: base64Bytes(1, MAX_SECRET_BYTES),
    wrapped_key: z
      .object({
        nonce: base64Bytes(NONCE_BYTES, NONCE_BYTES),
        tag: base64Bytes(TAG_BYTES, TAG_BYTES),
        ciphertext: base64Bytes(KEY_BYTES, KEY_BYTES),
      })
      .strict(),
  })
  .strict();
export type CredentialEnvelope = z.infer<typeof CredentialEnvelopeSchema>;

export type KeyringUnavailableReason = 'missing' | 'malformed' | 'active_key_missing';

/** Host keyring: key id → 32-byte AES key. Key bytes are private and never serialized. */
export class ProviderKeyring {
  readonly activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  private constructor(activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    this.activeKeyId = activeKeyId;
    this.#keys = keys;
  }

  /**
   * Parse `PROVIDER_MASTER_KEY_ID` and `PROVIDER_MASTER_KEYS` (JSON map of id → base64 32-byte key).
   * A missing or malformed keyring disables credential writes/decryption with a redacted reason;
   * it never fails the process (spec 01 §3).
   */
  static parse(
    activeKeyId: string | undefined,
    keysJson: string | undefined,
  ): { ok: true; keyring: ProviderKeyring } | { ok: false; reason: KeyringUnavailableReason } {
    if (activeKeyId === undefined || keysJson === undefined)
      return { ok: false, reason: 'missing' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysJson);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed' };
    }
    const keys = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!KEY_ID_PATTERN.test(id) || typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
        return { ok: false, reason: 'malformed' };
      }
      const key = Buffer.from(value, 'base64');
      if (key.length !== KEY_BYTES) return { ok: false, reason: 'malformed' };
      keys.set(id, key);
    }
    if (!KEY_ID_PATTERN.test(activeKeyId) || !keys.has(activeKeyId)) {
      return { ok: false, reason: 'active_key_missing' };
    }
    return { ok: true, keyring: new ProviderKeyring(activeKeyId, keys) };
  }

  get keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  /** @internal Used by this module only. */
  keyFor(keyId: string): Buffer {
    const key = this.#keys.get(keyId);
    if (key === undefined)
      throw new CredentialCryptoError('UNKNOWN_KEY_ID', 'Unknown wrapping key id');
    return key;
  }

  toJSON(): { activeKeyId: string; keyIds: string[] } {
    return { activeKeyId: this.activeKeyId, keyIds: this.keyIds };
  }

  [inspect.custom](): string {
    return `ProviderKeyring { activeKeyId: ${this.activeKeyId}, keys: [redacted] }`;
  }
}

/**
 * Reject empty/oversized keys and CR/LF/NUL before encryption (spec 04 §1.2). Throws without
 * echoing the value.
 */
export function validateProviderSecret(secret: string): void {
  if (secret.length === 0 || secret.trim().length === 0) {
    throw new CredentialCryptoError('INVALID_SECRET', 'API key is empty');
  }
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    throw new CredentialCryptoError('INVALID_SECRET', 'API key exceeds 4 KiB');
  }
  // eslint-disable-next-line no-control-regex -- API keys must not contain CR/LF/NUL (spec 04 §1.2)
  if (/[\r\n\u0000]/u.test(secret)) {
    throw new CredentialCryptoError('INVALID_SECRET', 'API key contains CR, LF or NUL');
  }
}

function aad(
  provider: CredentialProvider,
  secretVersion: string,
  purpose: 'payload' | 'wrap',
): Buffer {
  if (!/^[1-9]\d*$/.test(secretVersion)) {
    throw new CredentialCryptoError(
      'INVALID_ENVELOPE',
      'Secret version must be a positive integer',
    );
  }
  return Buffer.from(
    canonicalJson({ format: ENVELOPE_FORMAT, provider, secretVersion, purpose }),
    'utf8',
  );
}

function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, additional: Buffer) {
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function open(
  key: Buffer,
  nonce: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  additional: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(tag);
    const head = decipher.update(ciphertext);
    const tail = decipher.final(); // verifies the tag before any plaintext is used
    return Buffer.concat([head, tail]);
  } catch {
    throw new CredentialCryptoError('DECRYPT_FAILED', 'Credential authentication failed');
  }
}

export interface EncryptSecretInput {
  keyring: ProviderKeyring;
  provider: CredentialProvider;
  /** The exact next revision the secret is staged at (decimal string). */
  secretVersion: string;
  secret: string;
  /** Test hook; defaults to `crypto.randomBytes`. */
  randomBytes?: (size: number) => Buffer;
}

/** Encrypt an API key into a format-1 envelope under the keyring's active key. */
export function encryptProviderSecret(input: EncryptSecretInput): CredentialEnvelope {
  validateProviderSecret(input.secret);
  const random = input.randomBytes ?? nodeRandomBytes;
  const dataKey = random(KEY_BYTES);
  const plaintext = Buffer.from(input.secret, 'utf8');
  try {
    const nonce = random(NONCE_BYTES);
    const payload = seal(
      dataKey,
      nonce,
      plaintext,
      aad(input.provider, input.secretVersion, 'payload'),
    );
    const wrapNonce = random(NONCE_BYTES);
    const wrapped = seal(
      input.keyring.keyFor(input.keyring.activeKeyId),
      wrapNonce,
      dataKey,
      aad(input.provider, input.secretVersion, 'wrap'),
    );
    return {
      format: ENVELOPE_FORMAT,
      key_id: input.keyring.activeKeyId,
      nonce: nonce.toString('base64'),
      tag: payload.tag.toString('base64'),
      ciphertext: payload.ciphertext.toString('base64'),
      wrapped_key: {
        nonce: wrapNonce.toString('base64'),
        tag: wrapped.tag.toString('base64'),
        ciphertext: wrapped.ciphertext.toString('base64'),
      },
    };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

export interface DecryptSecretInput {
  keyring: ProviderKeyring;
  provider: CredentialProvider;
  secretVersion: string;
  envelope: unknown;
}

/** Decrypt an envelope; fails closed on an unknown key id or any modification. */
export function decryptProviderSecret(input: DecryptSecretInput): string {
  const envelope = parseEnvelope(input.envelope);
  const dataKey = unwrapDataKey(input.keyring, input.provider, input.secretVersion, envelope);
  try {
    const plaintext = open(
      dataKey,
      Buffer.from(envelope.nonce, 'base64'),
      Buffer.from(envelope.tag, 'base64'),
      Buffer.from(envelope.ciphertext, 'base64'),
      aad(input.provider, input.secretVersion, 'payload'),
    );
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Master-key rotation: rewrap the data key under the keyring's active key with a fresh nonce/tag.
 * The payload ciphertext is unchanged and never decrypted.
 */
export function rewrapProviderSecret(
  input: DecryptSecretInput & { randomBytes?: (size: number) => Buffer },
): CredentialEnvelope {
  const envelope = parseEnvelope(input.envelope);
  const dataKey = unwrapDataKey(input.keyring, input.provider, input.secretVersion, envelope);
  try {
    const wrapNonce = (input.randomBytes ?? nodeRandomBytes)(NONCE_BYTES);
    const wrapped = seal(
      input.keyring.keyFor(input.keyring.activeKeyId),
      wrapNonce,
      dataKey,
      aad(input.provider, input.secretVersion, 'wrap'),
    );
    return {
      ...envelope,
      key_id: input.keyring.activeKeyId,
      wrapped_key: {
        nonce: wrapNonce.toString('base64'),
        tag: wrapped.tag.toString('base64'),
        ciphertext: wrapped.ciphertext.toString('base64'),
      },
    };
  } finally {
    dataKey.fill(0);
  }
}

export function parseEnvelope(value: unknown): CredentialEnvelope {
  const result = CredentialEnvelopeSchema.safeParse(value);
  if (!result.success)
    throw new CredentialCryptoError('INVALID_ENVELOPE', 'Malformed credential envelope');
  return result.data;
}

function unwrapDataKey(
  keyring: ProviderKeyring,
  provider: CredentialProvider,
  secretVersion: string,
  envelope: CredentialEnvelope,
): Buffer {
  const wrapKey = keyring.keyFor(envelope.key_id);
  const dataKey = open(
    wrapKey,
    Buffer.from(envelope.wrapped_key.nonce, 'base64'),
    Buffer.from(envelope.wrapped_key.tag, 'base64'),
    Buffer.from(envelope.wrapped_key.ciphertext, 'base64'),
    aad(provider, secretVersion, 'wrap'),
  );
  if (dataKey.length !== KEY_BYTES) {
    dataKey.fill(0);
    throw new CredentialCryptoError('DECRYPT_FAILED', 'Credential authentication failed');
  }
  return dataKey;
}
