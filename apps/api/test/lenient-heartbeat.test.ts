import { expect, it } from 'vitest';

import { freshWorkerKeyrings } from '../src/routes/admin/shared.js';

it('reads a heartbeat keyring report with a future report field', async () => {
  const now = new Date();
  const entry = {
    at: now.toISOString(),
    queues: [],
    evalIngestOnly: false,
    envCredentials: [],
    runtime: { keyring: { status: 'ok', activeKeyId: 'k1', future: true } },
  };
  const db = { execute: async () => ({ rows: [{ value: { process: entry } }] }) } as never;
  expect(await freshWorkerKeyrings(db, now)).toEqual([
    { workerId: 'process', status: 'ok', activeKeyId: 'k1' },
  ]);
});

it('keeps a newer worker visible while dropping unknown queue and credential-provider names', async () => {
  const now = new Date();
  const entry = {
    at: now.toISOString(),
    queues: ['feed.fetch', 'article.extract', 'future.queue'],
    evalIngestOnly: false,
    envCredentials: ['typesafe', 'ollama', 'future-provider'],
  };
  const db = { execute: async () => ({ rows: [{ value: { process: entry } }] }) } as never;
  const { freshWorkers } = await import('../src/routes/admin/shared.js');
  expect(await freshWorkers(db, now)).toEqual([
    {
      queues: ['feed.fetch', 'article.extract'],
      envCredentials: ['typesafe', 'ollama'],
    },
  ]);
});
