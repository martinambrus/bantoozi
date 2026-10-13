import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { generateIdentity, identityToRecipient } from 'age-encryption';

export interface EnvInitOptions {
  envFile: string;
  template: string;
  production: boolean;
  addProviderKey: boolean;
}

export interface EnvInitResult {
  /** Variable names that were set or changed (never values). */
  changed: string[];
  /** Human-readable lines (names and paths only, never secret values). */
  notes: string[];
}

const isBlank = (value: string | undefined): boolean =>
  value === undefined || value === '' || value.startsWith('change-me');

const rand = (bytes: number): string => randomBytes(bytes).toString('base64url');

function refuseSymlink(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link (symlink); refusing to write through it`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

class EnvText {
  lines: string[];
  constructor(text: string) {
    this.lines = text.split('\n');
  }
  get(name: string): string | undefined {
    const prefix = `${name}=`;
    const line = this.lines.find((l) => l.startsWith(prefix));
    return line === undefined ? undefined : line.slice(prefix.length);
  }
  set(name: string, value: string): void {
    const prefix = `${name}=`;
    const index = this.lines.findIndex((l) => l.startsWith(prefix));
    if (index >= 0) {
      this.lines[index] = prefix + value;
      return;
    }
    const last = this.lines.length - 1;
    if (this.lines[last] === '') this.lines.splice(last, 0, prefix + value);
    else this.lines.push(prefix + value);
  }
  toString(): string {
    return this.lines.join('\n');
  }
}

function newKeyId(existing: string[]): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  for (;;) {
    const id = `k${date}-${randomBytes(3).toString('hex')}`;
    if (!existing.includes(id)) return id;
  }
}

function readKeys(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, string>;
  } catch {
    return undefined;
  }
}

/** Fill the host secrets of an env file (spec 11 §2). Only empty or `change-me*` values change. */
export async function initEnv(options: EnvInitOptions): Promise<EnvInitResult> {
  const envFile = resolve(options.envFile);
  refuseSymlink(envFile);
  const existed = existsSync(envFile);
  const source = existed ? envFile : resolve(options.template);
  const env = new EnvText(readFileSync(source, 'utf8'));
  const original = existed ? readFileSync(envFile, 'utf8') : undefined;
  const changed: string[] = [];
  const notes: string[] = [];
  const fill = (name: string, value: string): void => {
    env.set(name, value);
    changed.push(name);
  };

  if (isBlank(env.get('SESSION_PEPPER'))) fill('SESSION_PEPPER', rand(48));
  if (isBlank(env.get('METRICS_TOKEN'))) fill('METRICS_TOKEN', rand(32));
  if (isBlank(env.get('DELETION_HMAC_KEY')))
    fill('DELETION_HMAC_KEY', randomBytes(32).toString('hex'));

  if (options.production) {
    for (const name of [
      'POSTGRES_PASSWORD',
      'BANTOOZI_OWNER_PASSWORD',
      'BANTOOZI_APP_PASSWORD',
      'BANTOOZI_WORKER_PASSWORD',
    ]) {
      if (env.get(name) === '') fill(name, rand(24));
    }
  }

  // Provider wrapping keyring.
  const keys = readKeys(env.get('PROVIDER_MASTER_KEYS'));
  if (keys === undefined) {
    notes.push('PROVIDER_MASTER_KEYS is not valid JSON; left unchanged. Fix it by hand.');
  } else {
    const ids = Object.keys(keys);
    const activeId = env.get('PROVIDER_MASTER_KEY_ID') ?? '';
    if (options.addProviderKey || ids.length === 0) {
      const id = newKeyId(ids);
      keys[id] = randomBytes(32).toString('base64');
      fill('PROVIDER_MASTER_KEYS', JSON.stringify(keys));
      fill('PROVIDER_MASTER_KEY_ID', id);
    } else if (activeId === '') {
      fill('PROVIDER_MASTER_KEY_ID', ids[ids.length - 1]!);
    }
  }

  // Deletion ledger recipient and (dev only) identity.
  if (isBlank(env.get('DELETION_LEDGER_RECIPIENT'))) {
    if (options.production) {
      notes.push(
        'DELETION_LEDGER_RECIPIENT is empty. Run `age-keygen -o ledger-identity.txt` on a trusted machine, keep the identity off this host, and set DELETION_LEDGER_RECIPIENT to its public key (age1...).',
      );
    } else {
      const identity = await generateIdentity();
      const recipient = await identityToRecipient(identity);
      const dataDir = join(dirname(envFile), '.data');
      mkdirSync(dataDir, { recursive: true });
      const identityFile = join(dataDir, 'ledger-identity.txt');
      refuseSymlink(identityFile);
      atomicWrite(
        identityFile,
        `# bantoozi dev deletion-ledger identity (keep private)\n${identity}\n`,
      );
      fill('DELETION_LEDGER_RECIPIENT', recipient);
      notes.push(
        `Dev ledger identity written to ${identityFile} (mode 0600); it is not in the env file.`,
      );
      if (isBlank(env.get('DELETION_LEDGER_PATH')))
        fill('DELETION_LEDGER_PATH', '.data/deletion-ledger.age');
    }
  }

  const next = env.toString();
  if (original === undefined || next !== original) atomicWrite(envFile, next);
  else if ((lstatSync(envFile).mode & 0o777) !== 0o600) chmodSync(envFile, 0o600);

  if (changed.length > 0) {
    notes.unshift(`Set in ${envFile}: ${[...new Set(changed)].join(', ')}.`);
    if (changed.includes('PROVIDER_MASTER_KEYS')) {
      notes.push(
        'Back up PROVIDER_MASTER_KEYS: losing it makes stored provider credentials unreadable.',
      );
    }
    notes.push('Restart the api and worker so they pick up the new values.');
  } else {
    notes.push('Nothing to change.');
  }
  return { changed, notes };
}
