import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STALE_GUARDED_QUEUES } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

const HANDLERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/handlers');

/** Self-recovering queues; interactive drafts keep immediate retries and a delayed stale intent. */
const EXEMPT = ['analysis.process', 'house.reconcile', 'card.draft'];

describe('stale-worker guarded queues', () => {
  it('lists every queue whose handler asks whether the worker is current', () => {
    const guarded = new Set<string>();
    for (const file of readdirSync(HANDLERS).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(HANDLERS, file), 'utf8');
      if (!/\b(assertWorkerCurrent|assertTranslationWorkerCurrent|workerStaleness)\(/.test(source))
        continue;
      const queues = [...source.matchAll(/QueueHandler<'([a-z.-]+)'>/g)].map((m) => m[1] as string);
      expect(queues.length, `${file} names no QueueHandler queue`).toBeGreaterThan(0);
      for (const queue of queues) guarded.add(queue);
    }
    expect([...guarded].length).toBeGreaterThan(0);
    const listed: readonly string[] = STALE_GUARDED_QUEUES;
    for (const queue of guarded) {
      if (EXEMPT.includes(queue)) continue;
      expect(listed, `${queue} is guarded but has no stale retry delay`).toContain(queue);
    }
  });
});
