import { getRater, groupByParticipant, listRaters, participantRatingCounts } from '@bantoozi/db';
import { dropCreatedTestDatabases } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCli } from '../src/cli.js';
import { hashSecret } from '../src/rating-server/tokens.js';
import { createEvalRuntime, EvalCommandError } from '../src/runtime.js';
import {
  addArticles,
  addGoldenFeeds,
  setupRatingDb,
  type RatingDb,
} from './rating-server-support.js';

/**
 * M3a-T3 (spec 10 §2.2, §2.4): `eval rater add|token|revoke|list|show` against a test database,
 * and participant grouping (one human with several topic profiles is one participant).
 */

const PUBLIC_URL = 'https://rate.example.test';
const NOW = new Date('2026-10-01T08:00:00Z');

let rdb: RatingDb;

beforeAll(async () => {
  rdb = await setupRatingDb('eval-rater');
});

afterAll(async () => {
  await rdb?.close();
  await dropCreatedTestDatabases();
});

async function evalCli(args: string[]): Promise<string> {
  const out: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
  const program = buildCli({
    io,
    openRuntime: () =>
      createEvalRuntime({
        env: { DATABASE_URL_WORKER: rdb.testDb.urls.worker, EVAL_PUBLIC_URL: PUBLIC_URL },
        io,
        now: () => NOW,
        poolMax: 2,
      }),
  }).exitOverride();
  await program.parseAsync(['node', 'cli', ...args]);
  return out.join('');
}

const tokenOf = (output: string): string => {
  const match = /rating URL: +https:\/\/rate\.example\.test\/r\?t=([A-Za-z0-9_-]+)/u.exec(output);
  if (match?.[1] === undefined) throw new Error(`no URL in ${output}`);
  return match[1];
};
const idOf = (output: string): string => /rater (\d+) added/u.exec(output)?.[1] ?? '';
const keyOf = (output: string): string => /participant: ([0-9a-f-]{36})/u.exec(output)?.[1] ?? '';

describe('eval rater add', () => {
  it('prints a private URL built from EVAL_PUBLIC_URL and stores only the token hash', async () => {
    const output = await evalCli(['rater', 'add', '--name', 'Owner', '--langs', 'sk,EN, sk']);
    const token = tokenOf(output);
    expect(token).toHaveLength(43);
    expect(output).toContain(`${PUBLIC_URL}/facets?t=${token}`);
    expect(output).toContain('expires:     2026-10-31T08:00:00.000Z');
    const id = idOf(output);
    const rater = await getRater(rdb.db, id);
    expect(rater).toMatchObject({ name: 'Owner', langs: ['sk', 'en'], contextName: null });
    expect(rater?.participantKey).toBe(keyOf(output));
    const stored = await rdb.owner.query<{ token_hash: string; row: string }>(
      'SELECT token_hash, row_to_json(r)::text AS row FROM eval.raters r WHERE id = $1',
      [id],
    );
    expect(stored.rows[0]?.token_hash).toBe(hashSecret(token));
    expect(stored.rows[0]?.row).not.toContain(token);
  });

  it('honours --token-days and --context', async () => {
    const output = await evalCli([
      'rater',
      'add',
      '--name',
      'Friend',
      '--langs',
      'cs',
      '--context',
      'local news',
      '--token-days',
      '7',
    ]);
    expect(output).toContain('expires:     2026-10-08T08:00:00.000Z');
    expect(output).toContain('(context: local news)');
  });

  it('rejects bad languages, token days and unknown participant keys', async () => {
    await expect(evalCli(['rater', 'add', '--name', 'X', '--langs', 'slovak'])).rejects.toThrow(
      EvalCommandError,
    );
    await expect(
      evalCli(['rater', 'add', '--name', 'X', '--langs', 'sk', '--token-days', '0']),
    ).rejects.toThrow(EvalCommandError);
    await expect(
      evalCli([
        'rater',
        'add',
        '--name',
        'X',
        '--langs',
        'sk',
        '--participant',
        '00000000-0000-4000-8000-000000000000',
      ]),
    ).rejects.toThrow(/no rater has participant key/u);
  });
});

describe('eval rater token / revoke', () => {
  it('revoke marks the token revoked and deletes sessions; token issues a new one and clears it', async () => {
    const added = await evalCli(['rater', 'add', '--name', 'Revoked', '--langs', 'en']);
    const id = idOf(added);
    const oldHash = hashSecret(tokenOf(added));
    await rdb.owner.query(
      `INSERT INTO eval.rater_sessions (session_hash, rater_id, expires_at)
       VALUES ('s1', $1, now() + interval '1 day')`,
      [id],
    );
    expect(await evalCli(['rater', 'revoke', id])).toContain('token revoked and sessions ended');
    expect((await getRater(rdb.db, id))?.tokenRevokedAt?.toISOString()).toBe(NOW.toISOString());
    const sessions = () =>
      rdb.owner
        .query('SELECT 1 FROM eval.rater_sessions WHERE rater_id = $1', [id])
        .then((r) => r.rowCount);
    expect(await sessions()).toBe(0);

    await rdb.owner.query(
      `INSERT INTO eval.rater_sessions (session_hash, rater_id, expires_at)
       VALUES ('s2', $1, now() + interval '1 day')`,
      [id],
    );
    const reissued = await evalCli(['rater', 'token', id, '--token-days', '3']);
    const newToken = tokenOf(reissued);
    const after = await rdb.owner.query<{ token_hash: string }>(
      'SELECT token_hash FROM eval.raters WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.token_hash).toBe(hashSecret(newToken));
    expect(after.rows[0]?.token_hash).not.toBe(oldHash);
    expect((await getRater(rdb.db, id))?.tokenRevokedAt).toBeNull();
    expect(reissued).toContain('expires:     2026-10-04T08:00:00.000Z');
    expect(await sessions()).toBe(0);
  });

  it('fails for an unknown rater', async () => {
    await expect(evalCli(['rater', 'revoke', '999999'])).rejects.toThrow(/no rater 999999/u);
    await expect(evalCli(['rater', 'token', '999999'])).rejects.toThrow(/no rater 999999/u);
    await expect(evalCli(['rater', 'revoke', 'abc'])).rejects.toThrow(EvalCommandError);
  });
});

describe('participants: one human with science/cooking profiles', () => {
  it('stays one independent participant in grouping and rating counts', async () => {
    const science = await evalCli([
      'rater',
      'add',
      '--name',
      'Martin',
      '--langs',
      'en',
      '--context',
      'science',
    ]);
    const key = keyOf(science);
    const cooking = await evalCli([
      'rater',
      'add',
      '--name',
      'Martin',
      '--langs',
      'en',
      '--context',
      'cooking',
      '--participant',
      key,
    ]);
    expect(keyOf(cooking)).toBe(key);
    const scienceId = idOf(science);
    const cookingId = idOf(cooking);

    const groups = groupByParticipant(await listRaters(rdb.db)).filter(
      (g) => g.participantKey === key,
    );
    expect(groups).toEqual([
      expect.objectContaining({ participantKey: key, raterIds: [scienceId, cookingId] }),
    ]);

    // The same article rated in both contexts counts once toward participant readiness.
    const [feed] = await addGoldenFeeds(rdb, 'en', 1);
    const articles = await addArticles(rdb, feed!.id, 'en', 2, NOW);
    for (const [raterId, articleId, rating] of [
      [scienceId, articles[0], 1],
      [cookingId, articles[0], -1],
      [cookingId, articles[1], 1],
    ] as const) {
      await rdb.owner.query(
        'INSERT INTO eval.ratings (rater_id, article_id, rating) VALUES ($1, $2, $3)',
        [raterId, articleId, rating],
      );
    }
    const counts = (await participantRatingCounts(rdb.db)).find((c) => c.participantKey === key);
    expect(counts).toEqual({
      participantKey: key,
      contexts: 2,
      distinctRatedArticles: 2,
      ratings: 3,
      likes: 2,
      dislikes: 1,
    });

    const list = await evalCli(['rater', 'list']);
    const block = list.slice(list.indexOf(`participant ${key}`));
    expect(block).toContain(`rater ${scienceId}: Martin / science [en]`);
    expect(block).toContain(`rater ${cookingId}: Martin / cooking [en]`);
    const show = JSON.parse(await evalCli(['rater', 'show', cookingId])) as Record<string, unknown>;
    expect(show).toMatchObject({ participantKey: key, contextName: 'cooking' });
    expect(JSON.stringify(show)).not.toMatch(/token_?hash/iu);
  });
});
