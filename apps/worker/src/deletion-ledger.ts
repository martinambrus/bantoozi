import { open } from 'node:fs/promises';

import type { DeletionLedgerEntry } from '@bantoozi/db';
import { Encrypter } from 'age-encryption';

/** The port `house.purge-users` appends to before a hard delete (spec 11 §5.1). */
export interface DeletionLedger {
  append(entry: DeletionLedgerEntry): Promise<void>;
}

/**
 * The production deletion ledger (spec 11 §5.1): each entry is JSON encrypted to an age
 * recipient (only the public key is on the box) and appended as one base64 line, fsynced before
 * the call returns. An append may repeat an entry id after a retry; a restore dedupes by id.
 */
export function createFileDeletionLedger(options: {
  path: string;
  recipient: string;
}): DeletionLedger {
  return {
    async append(entry) {
      const encrypter = new Encrypter();
      encrypter.addRecipient(options.recipient);
      const sealed = await encrypter.encrypt(JSON.stringify(entry));
      const line = `${Buffer.from(sealed).toString('base64')}\n`;
      const file = await open(options.path, 'a', 0o600);
      try {
        await file.appendFile(line);
        await file.sync();
      } finally {
        await file.close();
      }
    },
  };
}
