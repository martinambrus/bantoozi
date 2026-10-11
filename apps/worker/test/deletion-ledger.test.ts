import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { afterAll, describe, expect, it } from 'vitest';

import { createFileDeletionLedger } from '../src/deletion-ledger.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('file deletion ledger (spec 11 §5.1)', () => {
  it('appends one base64 age-encrypted line per entry that only the identity reads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ledger-'));
    dirs.push(dir);
    const file = path.join(dir, 'ledger.age');
    const identity = await generateIdentity();
    const ledger = createFileDeletionLedger({
      path: file,
      recipient: await identityToRecipient(identity),
    });
    const first = {
      id: 'a'.repeat(64),
      userId: 'user-plaintext-marker-1',
      deletedAt: '2026-01-01T00:00:00.000Z',
      emailHmac: 'h1',
    };
    const second = {
      ...first,
      id: 'b'.repeat(64),
      userId: 'user-plaintext-marker-2',
      emailHmac: 'h2',
    };
    await ledger.append(first);
    await ledger.append(second);
    await ledger.append(first);

    const text = await readFile(file, 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    // Random base64 can contain any short string, so look for a long marker in the text and in the
    // decoded bytes of every line.
    expect(text).not.toContain('plaintext-marker');
    for (const line of lines) {
      expect(Buffer.from(line, 'base64').toString('latin1')).not.toContain('plaintext-marker');
    }
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const entries = [];
    for (const line of lines) {
      entries.push(JSON.parse(await decrypter.decrypt(Buffer.from(line, 'base64'), 'text')));
    }
    expect(entries).toEqual([first, second, first]);
  });
});
