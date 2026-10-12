import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseManifest } from '../src/backup-commands.js';
import { BackupStore, type StoreConfig } from '../src/backup-store.js';
import { startFakeS3, type FakeS3 } from './support/fake-s3.js';

let s3: FakeS3;
let store: BackupStore;
const config = (): StoreConfig => ({
  endpoint: s3.endpoint,
  bucket: 'bucket',
  region: 'us-east-1',
  accessKey: 'ak',
  secretKey: 'sk',
  prefix: 'backups/',
  ledgerPrefix: 'ledger/',
});

beforeAll(async () => {
  s3 = await startFakeS3('bucket');
  store = new BackupStore(config());
});
afterAll(async () => {
  await s3.close();
});
beforeEach(() => {
  s3.objects.clear();
});

const put = (key: string, body = ''): void => {
  s3.objects.set(key, Buffer.from(body));
};
const backup = (id: string, ...names: string[]): void => {
  for (const name of names.length > 0 ? names : ['dump.age', 'globals.age', 'manifest.age'])
    put(`backups/${id}/${name}`);
};
const ids = (): string[] => [
  ...new Set(
    [...s3.objects.keys()]
      .filter((k) => k.startsWith('backups/'))
      .map((k) => k.split('/')[1] as string),
  ),
];

describe('backup store', () => {
  it('offers the newest valid backup: a manifest is required, a failure marker disqualifies', async () => {
    backup('20261009T023000Z');
    backup('20261010T023000Z', 'dump.age', 'globals.age'); // no manifest: incomplete
    backup('20261011T023000Z', 'dump.age', 'manifest.age', 'backup-failed');
    expect(await store.latestValid()).toBe('20261009T023000Z');
    s3.objects.clear();
    expect(await store.latestValid()).toBeUndefined();
  });

  it('prunes by the retention policy, removes whole backups and leaves the ledger objects alone', async () => {
    const days = [];
    for (
      let d = new Date('2026-08-01T00:00:00Z');
      d <= new Date('2026-10-11T00:00:00Z');
      d = new Date(d.getTime() + 86_400_000)
    ) {
      days.push(`${d.toISOString().slice(0, 10).replace(/-/gu, '')}T023000Z`);
    }
    for (const id of days) backup(id);
    put('backups/20260805T023000Z/restore-tested.json', '{}');
    put('ledger/deletion-ledger.age', 'line');
    put('ledger/deletion-ledger-20261011T023000Z.age', 'line');
    const result = await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect(result.prunedIds.length).toBe(days.length - ids().length);
    expect(ids()).toContain('20260805T023000Z'); // the last restore-tested one
    expect(ids()).toContain('20261011T023000Z');
    expect(ids()).not.toContain('20260820T023000Z');
    for (const id of ids()) expect(s3.objects.has(`backups/${id}/manifest.age`)).toBe(true);
    expect(s3.objects.has('ledger/deletion-ledger.age')).toBe(true);
    expect(s3.objects.has('ledger/deletion-ledger-20261011T023000Z.age')).toBe(true);
    const before = [...s3.objects.keys()].sort();
    await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect([...s3.objects.keys()].sort()).toEqual(before);
  });

  it('removes the leftovers of a failed backup after its grace and keeps them before', async () => {
    backup('20261011T023000Z');
    backup('20261005T023000Z', 'dump.age', 'backup-failed');
    backup('20261010T230000Z', 'dump.age', 'backup-failed');
    await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect(ids()).toContain('20261010T230000Z');
    expect(ids()).not.toContain('20261005T023000Z');
    // A failed backup never counts as a daily/weekly/monthly survivor of a valid one.
    expect(ids()).toContain('20261011T023000Z');
  });

  it('keeps every ledger copy from the oldest retained backup onwards, however old (R7)', async () => {
    backup('20260101T023000Z', 'dump.age', 'globals.age', 'manifest.age', 'restore-tested.json');
    backup('20261011T023000Z');
    put('ledger/deletion-ledger-20250101T023000Z.age', 'older than every backup');
    put('ledger/deletion-ledger-20260101T023000Z.age', 'the old backup');
    put('ledger/deletion-ledger-20260301T023000Z.age', 'between');
    put('ledger/deletion-ledger-20261001T023000Z.age', 'new');
    await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect(ids()).toContain('20260101T023000Z');
    expect(s3.objects.has('ledger/deletion-ledger-20250101T023000Z.age')).toBe(false);
    expect(s3.objects.has('ledger/deletion-ledger-20260101T023000Z.age')).toBe(true);
    expect(s3.objects.has('ledger/deletion-ledger-20260301T023000Z.age')).toBe(true);
    expect(s3.objects.has('ledger/deletion-ledger-20261001T023000Z.age')).toBe(true);
  });

  it('keeps all ledger copies when no valid backup remains (R7)', async () => {
    put('ledger/deletion-ledger-20250101T023000Z.age', 'old');
    await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect(s3.objects.has('ledger/deletion-ledger-20250101T023000Z.age')).toBe(true);
  });

  it('drops ledger copies past their retention only', async () => {
    backup('20261011T023000Z');
    put('ledger/deletion-ledger-20250101T023000Z.age', 'old');
    put('ledger/deletion-ledger-20261001T023000Z.age', 'new');
    await store.prune(new Date('2026-10-11T03:00:00Z'));
    expect(s3.objects.has('ledger/deletion-ledger-20250101T023000Z.age')).toBe(false);
    expect(s3.objects.has('ledger/deletion-ledger-20261001T023000Z.age')).toBe(true);
  });

  it('dry run deletes nothing', async () => {
    backup('20200102T023000Z');
    for (const day of ['05', '06', '07', '08', '09', '10', '11']) backup(`202610${day}T023000Z`);
    const result = await store.prune(new Date('2026-10-11T03:00:00Z'), true);
    expect(result.prunedIds).toEqual(['20200102T023000Z']);
    expect(ids()).toHaveLength(8);
  });
});

describe('incomplete leftovers', () => {
  it('never displace a valid daily and are pruned after the grace', async () => {
    const valid = [
      '20261005T023000Z',
      '20261006T023000Z',
      '20261007T023000Z',
      '20261008T023000Z',
      '20261009T023000Z',
      '20261010T023000Z',
      '20261011T023000Z',
    ];
    for (const id of valid) backup(id);
    backup('20261011T130000Z', 'dump.age', 'globals.age'); // newer, no manifest, no marker
    backup('20260901T023000Z', 'dump.age'); // old incomplete leftover
    const result = await store.prune(new Date('2026-10-11T14:00:00Z'));
    expect(ids()).toContain('20261005T023000Z');
    expect(ids()).toContain('20261011T130000Z'); // younger than the grace
    expect(ids()).not.toContain('20260901T023000Z');
    expect(result.keptIds).not.toContain('20261011T130000Z');
    expect(await store.latestValid()).toBe('20261011T023000Z');
  });
});

describe('manifest', () => {
  const valid = {
    version: 1,
    backupId: '20261011T023000Z',
    startedAt: '2026-10-11T02:30:00Z',
    finishedAt: '2026-10-11T02:31:00Z',
    commit: 'abc',
    schemaVersion: 19,
    images: {},
    bounds: { users: 3 },
    objects: [{ name: 'dump.age', size: 10, sha256: 'a'.repeat(64) }],
  };
  it('accepts a complete manifest', () => {
    expect(parseManifest(JSON.stringify(valid)).schemaVersion).toBe(19);
  });
  it.each([
    ['a wrong version', { ...valid, version: 2 }],
    ['a bad id', { ...valid, backupId: 'x' }],
    ['a bad checksum', { ...valid, objects: [{ name: 'dump.age', size: 1, sha256: 'zz' }] }],
    ['a bad bound name', { ...valid, bounds: { 'users; drop': 1 } }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseManifest(JSON.stringify(value))).toThrow(/manifest is invalid/u);
  });
});
