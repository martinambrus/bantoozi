import { backupIdTime, failedExpired, ledgerExpired, planRetention } from './retention.js';
import { S3Client, type S3Config } from './s3.js';

/**
 * The bucket layout of the backups (spec 11 §4):
 *   <prefix><id>/dump.age | globals.age | manifest.age   encrypted parts, the manifest written last
 *   <prefix><id>/restore-tested.json                     written by a successful restore test
 *   <prefix><id>/backup-failed                           marker of a backup that stopped part-way
 *   <ledgerPrefix>deletion-ledger-<id>.age               the deletion ledger as of that backup
 * A backup is valid when its manifest exists and no failure marker does.
 */

export const MANIFEST_NAME = 'manifest.age';
export const DUMP_NAME = 'dump.age';
export const GLOBALS_NAME = 'globals.age';
export const TESTED_NAME = 'restore-tested.json';
export const FAILED_NAME = 'backup-failed';

export interface StoreConfig extends S3Config {
  prefix: string;
  ledgerPrefix: string;
}

const withSlash = (value: string): string =>
  value === '' || value.endsWith('/') ? value : `${value}/`;

/** Settings from the environment of the tools container (never from arguments). */
export function storeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  return {
    endpoint: need('BACKUP_S3_ENDPOINT'),
    bucket: need('BACKUP_S3_BUCKET'),
    region: env['BACKUP_S3_REGION'] || 'us-east-1',
    accessKey: need('S3_ACCESS_KEY'),
    secretKey: need('S3_SECRET_KEY'),
    prefix: withSlash(env['BACKUP_S3_PREFIX'] ?? 'backups/'),
    ledgerPrefix: withSlash(env['BACKUP_S3_LEDGER_PREFIX'] ?? 'ledger/'),
  };
}

export interface BackupListing {
  id: string;
  names: Set<string>;
}

export class BackupStore {
  readonly client: S3Client;
  readonly config: StoreConfig;

  constructor(config: StoreConfig, client?: S3Client) {
    this.config = config;
    this.client = client ?? new S3Client(config);
  }

  key(id: string, name: string): string {
    return `${this.config.prefix}${id}/${name}`;
  }

  ledgerKey(id: string): string {
    return `${this.config.ledgerPrefix}deletion-ledger-${id}.age`;
  }

  /** Backups in the bucket, oldest first, with the names of their objects. */
  async listBackups(): Promise<BackupListing[]> {
    const byId = new Map<string, Set<string>>();
    for (const key of await this.client.list(this.config.prefix)) {
      const rest = key.slice(this.config.prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const id = rest.slice(0, slash);
      if (backupIdTime(id) === undefined) continue;
      const names = byId.get(id) ?? new Set<string>();
      names.add(rest.slice(slash + 1));
      byId.set(id, names);
    }
    return [...byId.entries()]
      .map(([id, names]) => ({ id, names }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The newest valid backup id, or undefined. */
  async latestValid(): Promise<string | undefined> {
    const valid = (await this.listBackups()).filter(
      (b) => b.names.has(MANIFEST_NAME) && !b.names.has(FAILED_NAME),
    );
    return valid[valid.length - 1]?.id;
  }

  /** The ledger objects, oldest first (every copy is replayed; entries are deduplicated by id). */
  async ledgerKeys(): Promise<string[]> {
    return (await this.client.list(this.config.ledgerPrefix)).filter((key) =>
      /deletion-ledger.*\.age$/u.test(key),
    );
  }

  /**
   * Applies the retention policy as of `now` and deletes the rest (whole backups only). Failed
   * backups older than their grace and ledger copies past their retention go too. Returns the ids
   * and keys removed.
   */
  async prune(
    now: Date,
    dryRun = false,
  ): Promise<{ prunedIds: string[]; keptIds: string[]; deleted: number }> {
    const listing = await this.listBackups();
    // Only a backup with its manifest and no failure marker is a candidate for the retention slots;
    // failed ones and incomplete leftovers (a crash before the marker) go after the same grace.
    const valid = listing.filter((b) => b.names.has(MANIFEST_NAME) && !b.names.has(FAILED_NAME));
    const failed = listing.filter((b) => !b.names.has(MANIFEST_NAME) || b.names.has(FAILED_NAME));
    const plan = planRetention({
      ids: valid.map((b) => b.id),
      restoreTested: valid.filter((b) => b.names.has(TESTED_NAME)).map((b) => b.id),
      now,
    });
    const doomed = new Set(plan.prune);
    for (const backup of failed) if (failedExpired(backup.id, now)) doomed.add(backup.id);
    let deleted = 0;
    for (const id of [...doomed].sort()) {
      const names = listing.find((b) => b.id === id)?.names ?? new Set<string>();
      // The manifest goes first: from then on the backup is no longer offered for a restore.
      const ordered = [...names].sort((a, b) =>
        a === MANIFEST_NAME ? -1 : b === MANIFEST_NAME ? 1 : a < b ? -1 : 1,
      );
      for (const name of ordered) {
        if (!dryRun) await this.client.deleteObject(this.key(id, name));
        deleted += 1;
      }
    }
    for (const key of await this.ledgerKeys()) {
      const id = /(\d{8}T\d{6}Z)\.age$/u.exec(key)?.[1];
      if (id !== undefined && ledgerExpired(id, now)) {
        if (!dryRun) await this.client.deleteObject(key);
        deleted += 1;
      }
    }
    return { prunedIds: [...doomed].sort(), keptIds: [...plan.keep.keys()], deleted };
  }
}
