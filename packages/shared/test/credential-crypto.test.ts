import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  CredentialCryptoError,
  CredentialEnvelopeSchema,
  ProviderKeyring,
  decryptProviderSecret,
  encryptProviderSecret,
  rewrapProviderSecret,
  validateProviderSecret,
  type CredentialEnvelope,
} from '../src/server/credential-crypto.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const SECRET = 'ts-live-3f9c1e0b7a55';

function keyring(active: string, keys: Record<string, string>): ProviderKeyring {
  const parsed = ProviderKeyring.parse(active, JSON.stringify(keys));
  if (!parsed.ok) throw new Error(`keyring: ${parsed.reason}`);
  return parsed.keyring;
}

const ringA = keyring('k1', { k1: KEY_A });

function expectCode(fn: () => unknown, code: CredentialCryptoError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CredentialCryptoError);
  expect((caught as CredentialCryptoError).code).toBe(code);
  expect(String((caught as Error).message)).not.toContain(SECRET);
}

function flipByte(b64: string, index = 0): string {
  const bytes = Buffer.from(b64, 'base64');
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('credential envelopes (spec 04 §1.2, format 1)', () => {
  const sealed = (): CredentialEnvelope =>
    encryptProviderSecret({
      keyring: ringA,
      provider: 'typesafe',
      secretVersion: '3',
      secret: SECRET,
    });

  it('round-trips and stores only ciphertext and metadata', () => {
    const envelope = sealed();
    expect(CredentialEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.format).toBe(1);
    expect(envelope.key_id).toBe('k1');
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(Buffer.from(envelope.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.wrapped_key.ciphertext, 'base64')).toHaveLength(32);
    expect(
      decryptProviderSecret({ keyring: ringA, provider: 'typesafe', secretVersion: '3', envelope }),
    ).toBe(SECRET);
  });

  it('uses a fresh data key and fresh nonces for every encryption', () => {
    const a = sealed();
    const b = sealed();
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrapped_key.nonce).not.toBe(b.wrapped_key.nonce);
    expect(a.wrapped_key.ciphertext).not.toBe(b.wrapped_key.ciphertext);
    expect(a.nonce).not.toBe(a.wrapped_key.nonce);
  });

  it('authenticates the ciphertext, tag and wrapped key', () => {
    const envelope = sealed();
    const open = (e: CredentialEnvelope) => () =>
      decryptProviderSecret({
        keyring: ringA,
        provider: 'typesafe',
        secretVersion: '3',
        envelope: e,
      });
    expectCode(open({ ...envelope, ciphertext: flipByte(envelope.ciphertext) }), 'DECRYPT_FAILED');
    expectCode(open({ ...envelope, tag: flipByte(envelope.tag) }), 'DECRYPT_FAILED');
    expectCode(open({ ...envelope, nonce: flipByte(envelope.nonce) }), 'DECRYPT_FAILED');
    expectCode(
      open({
        ...envelope,
        wrapped_key: {
          ...envelope.wrapped_key,
          ciphertext: flipByte(envelope.wrapped_key.ciphertext, 5),
        },
      }),
      'DECRYPT_FAILED',
    );
    expectCode(
      open({
        ...envelope,
        wrapped_key: { ...envelope.wrapped_key, tag: flipByte(envelope.wrapped_key.tag) },
      }),
      'DECRYPT_FAILED',
    );
  });

  it('binds provider, secret version and purpose through the AAD', () => {
    const envelope = sealed();
    expectCode(
      () =>
        decryptProviderSecret({ keyring: ringA, provider: 'ollama', secretVersion: '3', envelope }),
      'DECRYPT_FAILED',
    );
    expectCode(
      () =>
        decryptProviderSecret({
          keyring: ringA,
          provider: 'typesafe',
          secretVersion: '4',
          envelope,
        }),
      'DECRYPT_FAILED',
    );
    // A wrapped data key moved from another version's envelope does not authenticate.
    const other = encryptProviderSecret({
      keyring: ringA,
      provider: 'typesafe',
      secretVersion: '4',
      secret: SECRET,
    });
    expectCode(
      () =>
        decryptProviderSecret({
          keyring: ringA,
          provider: 'typesafe',
          secretVersion: '3',
          envelope: { ...envelope, wrapped_key: other.wrapped_key },
        }),
      'DECRYPT_FAILED',
    );
  });

  it('fails closed on unknown or missing key ids', () => {
    const envelope = sealed();
    const ringB = keyring('k2', { k2: KEY_B });
    expectCode(
      () =>
        decryptProviderSecret({
          keyring: ringB,
          provider: 'typesafe',
          secretVersion: '3',
          envelope,
        }),
      'UNKNOWN_KEY_ID',
    );
    // Same id, different key material: authentication fails.
    const impostor = keyring('k1', { k1: KEY_B });
    expectCode(
      () =>
        decryptProviderSecret({
          keyring: impostor,
          provider: 'typesafe',
          secretVersion: '3',
          envelope,
        }),
      'DECRYPT_FAILED',
    );
    expect(ProviderKeyring.parse(undefined, undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(ProviderKeyring.parse('k1', undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(ProviderKeyring.parse('k9', JSON.stringify({ k1: KEY_A }))).toEqual({
      ok: false,
      reason: 'active_key_missing',
    });
    expect(ProviderKeyring.parse('k1', '{not json')).toEqual({ ok: false, reason: 'malformed' });
    expect(
      ProviderKeyring.parse('k1', JSON.stringify({ k1: randomBytes(16).toString('base64') })),
    ).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(ProviderKeyring.parse('k1', JSON.stringify({ 'bad id!': KEY_A }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects malformed envelopes before use', () => {
    const envelope = sealed();
    const bad = [
      { ...envelope, format: 2 },
      { ...envelope, nonce: randomBytes(16).toString('base64') },
      { ...envelope, tag: 'not base64!' },
      { ...envelope, extra: 'x' },
      {
        ...envelope,
        wrapped_key: { ...envelope.wrapped_key, ciphertext: randomBytes(31).toString('base64') },
      },
      null,
    ];
    for (const e of bad) {
      expectCode(
        () =>
          decryptProviderSecret({
            keyring: ringA,
            provider: 'typesafe',
            secretVersion: '3',
            envelope: e,
          }),
        'INVALID_ENVELOPE',
      );
    }
  });

  it('rewraps the data key under a new master key without touching the payload', () => {
    const envelope = sealed();
    const both = keyring('k2', { k1: KEY_A, k2: KEY_B });
    const rewrapped = rewrapProviderSecret({
      keyring: both,
      provider: 'typesafe',
      secretVersion: '3',
      envelope,
    });
    expect(rewrapped.key_id).toBe('k2');
    expect(rewrapped.ciphertext).toBe(envelope.ciphertext);
    expect(rewrapped.wrapped_key.nonce).not.toBe(envelope.wrapped_key.nonce);
    const onlyNew = keyring('k2', { k2: KEY_B });
    expect(
      decryptProviderSecret({
        keyring: onlyNew,
        provider: 'typesafe',
        secretVersion: '3',
        envelope: rewrapped,
      }),
    ).toBe(SECRET);
    expectCode(
      () =>
        decryptProviderSecret({
          keyring: onlyNew,
          provider: 'typesafe',
          secretVersion: '3',
          envelope,
        }),
      'UNKNOWN_KEY_ID',
    );
  });

  it('validates API keys before encryption without echoing them', () => {
    expectCode(() => validateProviderSecret(''), 'INVALID_SECRET');
    expectCode(() => validateProviderSecret('   '), 'INVALID_SECRET');
    expectCode(() => validateProviderSecret(`${SECRET}\n`), 'INVALID_SECRET');
    expectCode(() => validateProviderSecret(`${SECRET}\r`), 'INVALID_SECRET');
    expectCode(() => validateProviderSecret(`${SECRET}\u0000`), 'INVALID_SECRET');
    expectCode(() => validateProviderSecret('x'.repeat(4097)), 'INVALID_SECRET');
    expect(() => validateProviderSecret('é'.repeat(2048))).not.toThrow();
    expectCode(() => validateProviderSecret('é'.repeat(2049)), 'INVALID_SECRET');
  });

  it('never serializes key material', () => {
    const ring = keyring('k1', { k1: KEY_A, k0: KEY_B });
    const shown = `${JSON.stringify(ring)} ${inspect(ring)}`;
    expect(shown).not.toContain(KEY_A);
    expect(shown).not.toContain(KEY_B);
    expect(JSON.parse(JSON.stringify(ring))).toEqual({ activeKeyId: 'k1', keyIds: ['k1', 'k0'] });
  });
});
