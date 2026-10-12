import { describe, expect, it } from 'vitest';

import { HookParamsError, runSqlHook, sqlHookNames, type HookDb } from '../src/e2e/hooks.js';
import { READER_HOOKS } from '../src/e2e/hooks-reader.js';

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

const FEED_URL = 'http://127.0.0.1:4602/feed.xml';
const EMAIL = 'reader+one@example.com';
const ID = '9007199254740993';

/** Parameters every hook must refuse before it queries, whatever its own fields are. */
const NOT_AN_OBJECT = [undefined, null, [], 'x', 1, true];

describe('reader SQL hooks', () => {
  it('are registered once each, after articleStates', () => {
    const names = sqlHookNames();
    expect(names[0]).toBe('articleStates');
    expect(new Set(names).size).toBe(names.length);
    for (const [name] of READER_HOOKS) expect(names).toContain(name);
    expect(READER_HOOKS.map(([name]) => name)).toEqual([
      'fetchFeedNow',
      'analysisRequests',
      'ageForColdMaintenance',
      'runPurgeBodies',
      'snapshotMaintenance',
      'clearArticleText',
      'engineCalls',
      'articleFeedback',
    ]);
  });

  describe('fetchFeedNow', () => {
    it('inserts one forced feed.fetch intent per feed and binds the URL', async () => {
      const { db, calls } = recordingDb([{ id: '7' }]);
      await expect(runSqlHook(db, 'fetchFeedNow', { feedUrl: FEED_URL })).resolves.toEqual({
        queued: 1,
      });
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([FEED_URL]);
      expect(text).not.toContain(FEED_URL);
      expect(text).toContain('INSERT INTO job_outbox');
      expect(text).toContain("'feed.fetch'");
      expect(text).toContain("'force', true");
    });

    it('reports an unknown feed as nothing queued', async () => {
      const { db } = recordingDb([]);
      await expect(runSqlHook(db, 'fetchFeedNow', { feedUrl: FEED_URL })).resolves.toEqual({
        queued: 0,
      });
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { feedUrl: 1 },
        { feedUrl: '' },
        { feedUrl: 'not a url' },
        { feedUrl: 'ftp://127.0.0.1/feed.xml' },
        { feedUrl: `http://127.0.0.1/${'a'.repeat(2048)}` },
        { feedUrl: FEED_URL, force: false },
      ]) {
        await expect(runSqlHook(db, 'fetchFeedNow', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('analysisRequests', () => {
    it('lists one account’s requests through a bound email', async () => {
      const rows = [{ id: 'u', articleId: '5', status: 'cancelled', errorCode: 'revoked' }];
      const { db, calls } = recordingDb(rows);
      await expect(runSqlHook(db, 'analysisRequests', { email: EMAIL })).resolves.toBe(rows);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL]);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('FROM analysis_requests');
      expect(text).toContain('ORDER BY');
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: 1 },
        { email: '' },
        { email: 'no-at-sign' },
        { email: 'two@@example.com' },
        { email: 'white space@example.com' },
        { email: "x'; DROP TABLE users; --@example.com" },
        { email: `${'a'.repeat(250)}@example.com` },
        { email: EMAIL, extra: 1 },
      ]) {
        await expect(runSqlHook(db, 'analysisRequests', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('ageForColdMaintenance', () => {
    it('moves the snapshot, body and carrier dates back and binds the id', async () => {
      const row = { snapshots: 1, bodies: 1, articles: 1 };
      const { db, calls } = recordingDb([row]);
      await expect(runSqlHook(db, 'ageForColdMaintenance', { snapshotId: ID })).resolves.toBe(row);
      // The immutability guard is off only around the one statement and always back on.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.[0]).toContain('DISABLE TRIGGER article_snapshots_guard');
      expect(calls[2]?.[0]).toContain('ENABLE TRIGGER article_snapshots_guard');
      const [text = '', values] = calls[1] ?? [];
      expect(values).toEqual([ID]);
      expect(text).not.toContain(ID);
      expect(text).toContain("captured_at - interval '31 days'");
      expect(text).toContain("extracted_at - interval '31 days'");
      // It only ages: marking cold and clearing bodies is the job's work.
      expect(text).not.toContain('cold_at');
      expect(text).not.toContain('body_text = NULL');
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { snapshotId: 1 },
        { snapshotId: '0' },
        { snapshotId: '1 OR 1=1' },
        { snapshotId: ID, articleId: '5' },
      ]) {
        await expect(runSqlHook(db, 'ageForColdMaintenance', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('runPurgeBodies', () => {
    it('queues one house.purge-bodies intent', async () => {
      const { db, calls } = recordingDb([{ id: '3' }]);
      await expect(runSqlHook(db, 'runPurgeBodies', {})).resolves.toEqual({ queued: 1 });
      const { text } = onlyQuery(calls);
      expect(text).toContain('INSERT INTO job_outbox');
      expect(text).toContain("'house.purge-bodies'");
    });

    it('refuses parameters', async () => {
      const { db, calls } = recordingDb();
      for (const params of [...NOT_AN_OBJECT, { x: 1 }]) {
        await expect(runSqlHook(db, 'runPurgeBodies', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('snapshotMaintenance', () => {
    it('reads the cold mark and the hot copy and binds the id', async () => {
      const row = { cold: true, hotCopy: false, snapshotHasText: true };
      const { db, calls } = recordingDb([row]);
      await expect(runSqlHook(db, 'snapshotMaintenance', { snapshotId: ID })).resolves.toBe(row);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([ID]);
      expect(text).not.toContain(ID);
      expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [...NOT_AN_OBJECT, {}, { snapshotId: '' }, { snapshotId: '1.5' }]) {
        await expect(runSqlHook(db, 'snapshotMaintenance', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('clearArticleText', () => {
    it('empties the excerpt and the stored body of one article and binds the id', async () => {
      const row = { articles: 1, bodies: 1 };
      const { db, calls } = recordingDb([row]);
      await expect(runSqlHook(db, 'clearArticleText', { articleId: '5' })).resolves.toBe(row);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual(['5']);
      expect(text).toContain('UPDATE articles SET excerpt = NULL, excerpt_html = NULL');
      expect(text).toContain('UPDATE article_bodies SET body_text = NULL, body_html = NULL');
      expect(text.match(/\$1::bigint/g)).toHaveLength(2);
      expect(text).not.toMatch(/DELETE|DROP|TRUNCATE/);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { articleId: 5 },
        { articleId: '0' },
        { articleId: '5; DROP TABLE articles' },
        { articleId: '5', snapshotId: '5' },
      ]) {
        await expect(runSqlHook(db, 'clearArticleText', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });

  describe('engineCalls', () => {
    it('lists the provider calls made for one account through a bound email', async () => {
      const rows = [
        { id: '3', articleId: '5', kind: 'enrich', engine: 'typesafe', status: 'ok' },
        { id: '4', articleId: '5', kind: 'match', engine: 'typesafe', status: 'ok' },
      ];
      const { db, calls } = recordingDb(rows);
      await expect(runSqlHook(db, 'engineCalls', { email: EMAIL })).resolves.toBe(rows);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL]);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('FROM engine_calls');
      expect(text).toContain('JOIN users');
      expect(text).toContain('ORDER BY');
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: 1 },
        { email: '' },
        { email: 'no-at-sign' },
        { email: "x'; DROP TABLE users; --@example.com" },
        { email: EMAIL, articleId: '5' },
      ]) {
        await expect(runSqlHook(db, 'engineCalls', params)).rejects.toBeInstanceOf(HookParamsError);
      }
      expect(calls).toEqual([]);
    });
  });

  describe('articleFeedback', () => {
    it('lists one account’s events of one article through bound values', async () => {
      const rows = [
        { id: '9', kind: 'rate', rating: 1, reason: null, analysisRequestId: 'u' },
        { id: '10', kind: 'unrate', rating: null, reason: null, analysisRequestId: null },
      ];
      const { db, calls } = recordingDb(rows);
      await expect(
        runSqlHook(db, 'articleFeedback', { email: EMAIL, articleId: ID }),
      ).resolves.toBe(rows);
      const { text, values } = onlyQuery(calls);
      expect(values).toEqual([EMAIL, ID]);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(ID);
      expect(text).toContain('FROM feedback_events');
      expect(text).toContain("e.value ->> 'analysisRequestId'");
      expect(text).toContain('$2::bigint');
      expect(text).toContain('ORDER BY');
      expect(text).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/);
    });

    it('refuses invalid parameters without querying', async () => {
      const { db, calls } = recordingDb();
      for (const params of [
        ...NOT_AN_OBJECT,
        {},
        { email: EMAIL },
        { articleId: ID },
        { email: 1, articleId: ID },
        { email: 'no-at-sign', articleId: ID },
        { email: EMAIL, articleId: 5 },
        { email: EMAIL, articleId: '0' },
        { email: EMAIL, articleId: '012' },
        { email: EMAIL, articleId: '5; DROP TABLE articles' },
        { email: EMAIL, articleId: ID, kind: 'rate' },
      ]) {
        await expect(runSqlHook(db, 'articleFeedback', params)).rejects.toBeInstanceOf(
          HookParamsError,
        );
      }
      expect(calls).toEqual([]);
    });
  });
});
