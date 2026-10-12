import { createReadStream } from 'node:fs';

import type { Command } from 'commander';

import { decryptStream, encryptStream, readIdentities } from './age-stream.js';
import { BackupStore, DUMP_NAME, GLOBALS_NAME, storeConfigFromEnv } from './backup-store.js';
import { backupIdTime } from './retention.js';

/**
 * The `backup:*` commands run inside the `backup-tools` container by `infra/scripts/backup.sh` and
 * `restore-test.sh` (spec 11 §4). Settings and credentials come from the container environment,
 * never from arguments. Results go to stdout (JSON or `KEY=value` lines); a failure prints one
 * `error:` line to stderr and sets a nonzero exit code.
 */

const stdin = (): AsyncIterable<Uint8Array> =>
  process.stdin as unknown as AsyncIterable<Uint8Array>;

async function readAll(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

function recipientFromEnv(): string {
  const recipient = process.env['BACKUP_AGE_RECIPIENT'];
  if (recipient === undefined || !recipient.startsWith('age1')) {
    throw new Error('BACKUP_AGE_RECIPIENT is not an age recipient');
  }
  return recipient;
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${name}: ${message}\n`);
    process.exitCode = 1;
  }
}

function write(chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

export interface Manifest {
  version: 1;
  backupId: string;
  startedAt: string;
  finishedAt: string;
  commit: string;
  schemaVersion: number;
  images: Record<string, string>;
  bounds: Record<string, number>;
  objects: { name: string; size: number; sha256: string }[];
}

/** Checks the shape of a decrypted manifest (a hand-edited or foreign file fails the restore). */
export function parseManifest(text: string): Manifest {
  const value = JSON.parse(text) as Partial<Manifest> | null;
  const bad = (what: string): never => {
    throw new Error(`manifest is invalid: ${what}`);
  };
  if (value === null || typeof value !== 'object') return bad('not an object');
  if (value.version !== 1) bad('version');
  if (typeof value.backupId !== 'string' || backupIdTime(value.backupId) === undefined)
    bad('backupId');
  for (const field of ['startedAt', 'finishedAt'] as const) {
    if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field] as string)))
      bad(field);
  }
  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) < 0)
    bad('schemaVersion');
  if (!Array.isArray(value.objects)) return bad('objects');
  for (const object of value.objects) {
    if (
      typeof object?.name !== 'string' ||
      !Number.isInteger(object.size) ||
      !/^[0-9a-f]{64}$/u.test(object.sha256)
    ) {
      bad('object entry');
    }
  }
  const bounds = value.bounds ?? {};
  for (const [table, count] of Object.entries(bounds)) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(table) || !Number.isInteger(count) || count < 0) bad('bounds');
  }
  return {
    version: 1,
    backupId: value.backupId as string,
    startedAt: value.startedAt as string,
    finishedAt: value.finishedAt as string,
    commit: typeof value.commit === 'string' ? value.commit : 'unknown',
    schemaVersion: value.schemaVersion as number,
    images: value.images ?? {},
    bounds,
    objects: value.objects,
  };
}

export function registerBackupCommands(program: Command): void {
  const store = (): BackupStore => new BackupStore(storeConfigFromEnv());

  program
    .command('backup:check')
    .description('Check that the bucket answers with the credentials of this container')
    .action(() =>
      run(async () => {
        await store().client.list(storeConfigFromEnv().prefix, { pageSize: 1, limit: 1 });
        console.log('ok');
      }),
    );

  program
    .command('backup:put <key>')
    .description('Encrypt stdin to BACKUP_AGE_RECIPIENT, upload it, verify size and checksum')
    .action((key: string) =>
      run(async () => {
        const s = store();
        const result = await s.client.uploadStream(key, encryptStream(recipientFromEnv(), stdin()));
        await s.client.verifyObject(key, result);
        console.log(
          JSON.stringify({
            name: key.slice(key.lastIndexOf('/') + 1),
            size: result.size,
            sha256: result.sha256,
          }),
        );
      }),
    );

  program
    .command('backup:put-raw <key>')
    .description(
      'Upload stdin (or --file) as it is (markers, the already encrypted ledger) and verify it',
    )
    .option('--file <path>', 'read this file instead of stdin')
    .action((key: string, options: { file?: string }) =>
      run(async () => {
        const s = store();
        const source =
          options.file === undefined
            ? stdin()
            : (createReadStream(options.file) as AsyncIterable<Uint8Array>);
        const result = await s.client.uploadStream(key, source);
        await s.client.verifyObject(key, result);
        console.log(
          JSON.stringify({
            name: key.slice(key.lastIndexOf('/') + 1),
            size: result.size,
            sha256: result.sha256,
          }),
        );
      }),
    );

  program
    .command('backup:get <key>')
    .description('Write an object to stdout; --decrypt opens it with the identity file')
    .option('--decrypt', 'decrypt with --identity')
    .option('--identity <file>', 'age identity file', '/run/bantoozi/identity')
    .option('--sha256 <hex>', 'ciphertext checksum the manifest recorded')
    .action((key: string, options: { decrypt?: boolean; identity: string; sha256?: string }) =>
      run(async () => {
        const object = await store().client.getObject(key);
        if (options.decrypt !== true) {
          for await (const chunk of object) await write(chunk as Buffer);
          return;
        }
        const tally: { expectedSha256?: string } = {};
        if (options.sha256 !== undefined) tally.expectedSha256 = options.sha256;
        const plain = decryptStream(await readIdentities(options.identity), object, tally);
        for await (const chunk of plain) await write(chunk);
      }),
    );

  program
    .command('backup:newest')
    .description('Print the id of the newest valid backup')
    .action(() =>
      run(async () => {
        const id = await store().latestValid();
        if (id === undefined) throw new Error('the bucket holds no valid backup');
        console.log(id);
      }),
    );

  program
    .command('backup:manifest')
    .description('Read a decrypted manifest from stdin and print the values the restore needs')
    .option('--now <iso>', 'clock for BACKUP_AGE_S')
    .action((options: { now?: string }) =>
      run(async () => {
        const manifest = parseManifest((await readAll(stdin())).toString('utf8'));
        const now = options.now === undefined ? Date.now() : Date.parse(options.now);
        const object = (name: string) => manifest.objects.find((o) => o.name === name);
        const dump = object(DUMP_NAME);
        const globals = object(GLOBALS_NAME);
        if (dump === undefined || globals === undefined)
          throw new Error('manifest lacks the dump or the globals');
        console.log(`MANIFEST_BACKUP_ID=${manifest.backupId}`);
        console.log(`MANIFEST_SCHEMA_VERSION=${manifest.schemaVersion}`);
        console.log(`MANIFEST_DUMP_SHA256=${dump.sha256}`);
        console.log(`MANIFEST_GLOBALS_SHA256=${globals.sha256}`);
        console.log(
          `MANIFEST_BACKUP_AGE_S=${Math.max(0, Math.round((now - Date.parse(manifest.finishedAt)) / 1000))}`,
        );
      }),
    );

  program
    .command('backup:prune')
    .description('Apply the retention policy (7 daily, 4 weekly, 6 monthly) as of --now')
    .option('--now <iso>', 'clock override (tests)')
    .option('--dry-run', 'list without deleting')
    .action((options: { now?: string; dryRun?: boolean }) =>
      run(async () => {
        const now = options.now === undefined ? new Date() : new Date(options.now);
        if (Number.isNaN(now.getTime())) throw new Error('--now is not a date');
        const result = await store().prune(now, options.dryRun === true);
        console.log(
          `PRUNE kept=${result.keptIds.length} pruned=${result.prunedIds.length} deleted_objects=${result.deleted}`,
        );
      }),
    );

  program
    .command('ledger:fetch')
    .description('Print the deletion-ledger lines of every ledger copy in the bucket')
    .action(() =>
      run(async () => {
        const s = store();
        for (const key of await s.ledgerKeys()) {
          const text = (await readAll(await s.client.getObject(key))).toString('utf8');
          for (const line of text.split('\n'))
            if (line.trim() !== '') await write(Buffer.from(`${line.trim()}\n`));
        }
      }),
    );
}
