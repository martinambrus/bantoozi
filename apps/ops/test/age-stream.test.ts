import { generateIdentity, identityToRecipient } from 'age-encryption';
import { describe, expect, it } from 'vitest';

import { decryptBytes, decryptStream, encryptStream, parseIdentities } from '../src/age-stream.js';

async function* chunks(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe('age streams', () => {
  it('round-trips a multi-chunk stream larger than one age chunk and records the ciphertext checksum', async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plain = Buffer.alloc(200_000, 'PGDMP-like payload ');
    const cipher = await collect(
      encryptStream(recipient, chunks([plain.subarray(0, 70_000), plain.subarray(70_000)])),
    );
    expect(cipher.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(cipher.includes(Buffer.from('PGDMP'))).toBe(false);
    const tally: { value?: { size: number; sha256: string }; expectedSha256?: string } = {};
    const out = await collect(
      decryptStream([identity], chunks([cipher.subarray(0, 1000), cipher.subarray(1000)]), tally),
    );
    expect(out.equals(plain)).toBe(true);
    expect(tally.value?.size).toBe(cipher.length);
  });

  it('fails on one flipped ciphertext byte, a wrong identity and a truncated stream', async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plain = Buffer.alloc(300_000, 7);
    const cipher = await collect(encryptStream(recipient, chunks([plain])));
    const flipped = Buffer.from(cipher);
    const at = Math.floor(cipher.length / 2);
    flipped[at] = (flipped[at] ?? 0) ^ 1;
    await expect(collect(decryptStream([identity], chunks([flipped])))).rejects.toThrow();
    const other = await generateIdentity();
    await expect(collect(decryptStream([other], chunks([cipher])))).rejects.toThrow();
    await expect(
      collect(decryptStream([identity], chunks([cipher.subarray(0, cipher.length - 40)]))),
    ).rejects.toThrow();
  });

  it('rejects a ciphertext whose checksum differs from the manifest', async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const cipher = await collect(encryptStream(recipient, chunks([Buffer.from('small')])));
    await expect(
      collect(decryptStream([identity], chunks([cipher]), { expectedSha256: 'f'.repeat(64) })),
    ).rejects.toThrow(/checksum/u);
  });

  it('parses age-keygen identity files and decrypts small payloads', async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const file = `# created: now\n# public key: ${recipient}\n${identity}\n`;
    expect(parseIdentities(file)).toEqual([identity]);
    const cipher = await collect(encryptStream(recipient, chunks([Buffer.from('{"ok":true}')])));
    expect(Buffer.from(await decryptBytes([identity], cipher)).toString()).toBe('{"ok":true}');
  });
});
