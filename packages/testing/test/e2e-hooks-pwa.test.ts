import { describe, expect, it } from 'vitest';

import { HookParamsError, runSqlHook, sqlHookNames, type HookDb } from '../src/e2e/hooks.js';
import { PWA_HOOKS } from '../src/e2e/hooks-pwa.js';

type Call = [string, unknown[]?];

function recordingDb(rows: unknown[] = []): { db: HookDb; calls: Call[] } {
  const calls: Call[] = [];
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

/** The statement and the values of the one query a hook ran. */
function onlyQuery(calls: Call[]): { text: string; values: unknown[] | undefined } {
  expect(calls).toHaveLength(1);
  const [text = '', values] = calls[0] ?? [];
  return { text, values };
}

const EMAIL = 'reader+pwa@example.com';

/** Parameters every hook must refuse before it queries, whatever its own fields are. */
const NOT_AN_OBJECT = [undefined, null, [], 'x', 1, true];

describe('PWA SQL hooks', () => {
  it('are registered once each, after articleStates', () => {
    const names = sqlHookNames();
    expect(names[0]).toBe('articleStates');
    expect(new Set(names).size).toBe(names.length);
    for (const [name] of PWA_HOOKS) expect(names).toContain(name);
    expect(PWA_HOOKS.map(([name]) => name)).toEqual(['feedbackEventFeatures']);
  });

  describe('feedbackEventFeatures', () => {
    it('returns the rows of one read-only query and binds the address', async () => {
      const rows = [
        { kind: 'open', articleId: '41', hasFeatures: false },
        { kind: 'rate', articleId: '41', hasFeatures: false },
      ];
      const { db, calls } = recordingDb(rows);
      await expect(runSqlHook(db, 'feedbackEventFeatures', { email: EMAIL })).resolves.toBe(rows);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL]);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('FROM feedback_events e');
      expect(text).toContain('u.email = $1');
      // Oldest first, and only whether the features are there, never what they hold.
      expect(text).toContain('ORDER BY e.id');
      expect(text).toContain("jsonb_exists(e.value, 'features')");
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/);
    });

    it('answers an unknown account with no rows', async () => {
      const { db } = recordingDb([]);
      await expect(runSqlHook(db, 'feedbackEventFeatures', { email: EMAIL })).resolves.toEqual([]);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: 1 },
        { email: null },
        { email: '' },
        { email: 'no-at-sign' },
        { email: 'white space@example.com' },
        { email: "x'; DROP TABLE users; --@example.com" },
        { email: `${'a'.repeat(250)}@example.com` },
        { email: EMAIL, userId: '1' },
      ]) {
        await expect(runSqlHook(db, 'feedbackEventFeatures', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });
});
