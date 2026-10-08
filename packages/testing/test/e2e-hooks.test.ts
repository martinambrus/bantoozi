import { describe, expect, it } from 'vitest';

import {
  HookParamsError,
  runSqlHook,
  sqlHookNames,
  UnknownHookError,
  type HookDb,
} from '../src/e2e/hooks.js';

function recordingDb(rows: unknown[] = []): { db: HookDb; calls: Array<[string, unknown[]?]> } {
  const calls: Array<[string, unknown[]?]> = [];
  return {
    calls,
    db: {
      async query(text, values) {
        calls.push(values === undefined ? [text] : [text, values]);
        return { rows };
      },
    },
  };
}

describe('SQL hooks', () => {
  it('start with articleStates', () => {
    expect(sqlHookNames()).toEqual(['articleStates']);
  });

  it('articleStates returns the rows of one parameterised query', async () => {
    const rows = [{ id: '1', title: 'T', pipelineState: 'extracted', contentRevision: '1' }];
    const { db, calls } = recordingDb(rows);
    const feedUrl = 'http://127.0.0.1:4601/feed.xml';
    await expect(runSqlHook(db, 'articleStates', { feedUrl })).resolves.toBe(rows);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual([feedUrl]);
    expect(calls[0]?.[0]).not.toContain(feedUrl);
  });

  it('fails with HookParamsError before querying when the parameters are invalid', async () => {
    const { db, calls } = recordingDb();
    for (const params of [undefined, null, [], 'x', {}, { feedUrl: 1 }, { feedUrl: 'x' }]) {
      await expect(runSqlHook(db, 'articleStates', params)).rejects.toBeInstanceOf(HookParamsError);
    }
    expect(calls).toEqual([]);
  });

  it('fails with UnknownHookError for a name that is not whitelisted', async () => {
    const { db, calls } = recordingDb();
    for (const name of [
      '',
      'articlestates',
      'drop',
      '__proto__',
      'constructor',
      'hasOwnProperty',
    ]) {
      await expect(runSqlHook(db, name, {})).rejects.toBeInstanceOf(UnknownHookError);
    }
    expect(calls).toEqual([]);
  });
});
