import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { Decrypter, Encrypter } from 'age-encryption';

/**
 * Streaming age encryption for the backup tools (spec 11 §4): bytes go in and out chunk by chunk,
 * so a dump is never held in memory or on disk in the clear. The ciphertext hash is taken as it
 * passes, which is what the manifest records and the restore compares.
 */

export interface CiphertextTally {
  size: number;
  sha256: string;
}

/** Identities of an `age-keygen` file: the `AGE-SECRET-KEY-…` lines (comments are ignored). */
export function parseIdentities(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('AGE-SECRET-KEY-'));
}

export async function readIdentities(path: string): Promise<string[]> {
  const identities = parseIdentities(await readFile(path, 'utf8'));
  if (identities.length === 0) throw new Error('the identity file holds no AGE-SECRET-KEY line');
  return identities;
}

const toWeb = (source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> =>
  Readable.toWeb(Readable.from(source, { objectMode: false })) as ReadableStream<Uint8Array>;

/** The age ciphertext of `source` for `recipient` (an `age1…` public key), as it is produced. */
export async function* encryptStream(
  recipient: string,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(toWeb(source));
  for await (const chunk of encrypted as unknown as AsyncIterable<Uint8Array>) yield chunk;
}

/**
 * The plaintext of an age stream. `tally` is filled with the size and SHA-256 of every ciphertext
 * byte read; when `expectedSha256` is given a mismatch (or a truncated read) fails at the end.
 */
export async function* decryptStream(
  identities: readonly string[],
  source: AsyncIterable<Uint8Array>,
  tally?: { value?: CiphertextTally; expectedSha256?: string },
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  const iterator = source[Symbol.asyncIterator]();
  const tapped: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const result = await iterator.next();
        if (result.done !== true) {
          hash.update(result.value);
          size += result.value.length;
        }
        return result;
      },
    }),
  };
  const decrypter = new Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  const plain = await decrypter.decrypt(toWeb(tapped));
  for await (const chunk of plain as unknown as AsyncIterable<Uint8Array>) yield chunk;
  // The age reader stops at the final chunk: read to the end so the checksum covers every byte.
  for (;;) {
    const rest = await iterator.next();
    if (rest.done === true) break;
    hash.update(rest.value);
    size += rest.value.length;
  }
  const value = { size, sha256: hash.digest('hex') };
  if (tally !== undefined) tally.value = value;
  if (tally?.expectedSha256 !== undefined && tally.expectedSha256 !== value.sha256) {
    throw new Error('ciphertext checksum differs from the manifest');
  }
}

/** Decrypts a whole small age payload (manifest, a ledger line) to bytes. */
export async function decryptBytes(
  identities: readonly string[],
  data: Uint8Array,
): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  return decrypter.decrypt(data);
}
