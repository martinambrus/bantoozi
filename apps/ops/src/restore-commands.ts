import type { Command } from 'commander';
import pg from 'pg';

import { readIdentities } from './age-stream.js';
import { parseManifest } from './backup-commands.js';
import { decryptLedgerLines, formatReplay, replayLedger } from './ledger-replay.js';
import { formatRecovery, prepareRecovery } from './recovery-prepare.js';
import { verifyRestore } from './restore-verify.js';

/**
 * `restore:verify`, `ledger:replay` and `recovery:prepare`: run by `infra/scripts/restore-test.sh` in a container that
 * shares the network namespace of the throwaway Postgres (which has no other network). The database
 * is reached over loopback as the superuser of that throwaway instance only.
 */

const DEFAULT_URL = 'postgres://postgres@127.0.0.1:5432/bantoozi';

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts).toString('utf8');
}

async function withPool(action: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({
    connectionString: process.env['RESTORE_DATABASE_URL'] ?? DEFAULT_URL,
    max: 2,
  });
  try {
    await action(pool);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${name}: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

export function registerRestoreCommands(program: Command): void {
  program
    .command('restore:verify')
    .description('Verify a restored database; the decrypted manifest comes on stdin')
    .action(() =>
      withPool(async (pool) => {
        const manifest = parseManifest(await readStdin());
        const lines = await verifyRestore(pool, {
          expectedSchemaVersion: manifest.schemaVersion,
          bounds: manifest.bounds,
          keys: {
            keyId: process.env['PROVIDER_MASTER_KEY_ID'] || undefined,
            keysJson: process.env['PROVIDER_MASTER_KEYS'] || undefined,
          },
        });
        // Printed only when every check passed: a failed restore reports nothing as verified.
        for (const line of lines) console.log(line);
      }),
    );

  program
    .command('ledger:replay')
    .description('Replay the deletion ledger (base64 age lines on stdin) on the restored database')
    .option('--identity <file>', 'age identity file', '/run/bantoozi/identity')
    .action((options: { identity: string }) =>
      withPool(async (pool) => {
        const lines = (await readStdin()).split('\n');
        const entries = await decryptLedgerLines(await readIdentities(options.identity), lines);
        const key = process.env['DELETION_HMAC_KEY'];
        if (entries.length > 0 && (key === undefined || key.length < 32)) {
          throw new Error('DELETION_HMAC_KEY (the recovered key) is required to replay the ledger');
        }
        console.log(formatReplay(await replayLedger(pool, entries, key ?? '')));
      }),
    );

  program
    .command('recovery:prepare')
    .description(
      'After a restore: cancel stale active pg-boss jobs, reset outbox and origin leases (spec 11 §4.1 step 4)',
    )
    .action(() =>
      withPool(async (pool) => {
        console.log(formatRecovery(await prepareRecovery(pool)));
      }),
    );
}
