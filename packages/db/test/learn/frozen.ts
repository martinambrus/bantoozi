import { randomUUID } from 'node:crypto';

import { withConnection } from '../support/test-db.js';

import type { Scenario } from './fixtures.js';

/** A completed request with a schema-valid frozen input and a typesafe result, for derived snapshots. */
export async function frozenRequest(
  s: Scenario,
  articleId: string,
  options: {
    publishedAt: Date | null;
    firstSeenAt: Date;
    cards: { cardId: string; kind: 'interest' | 'label'; strength: string | null; p?: number }[];
    facets: Record<string, number>;
  },
): Promise<{ requestId: string; inputSha: string }> {
  const requestId = randomUUID();
  const hex = (c: string) => c.repeat(64);
  const inputSnapshot = {
    v: 1,
    capturedAt: options.firstSeenAt.toISOString(),
    article: {
      id: articleId,
      revision: '1',
      title: 'Frozen title',
      author: 'Frozen Author',
      categories: [],
      excerpt: null,
      bodyLead: null,
      wordCount: 321,
      lang: 'cs',
      feed: { title: null, site: null },
      firstSeenAt: options.firstSeenAt.toISOString(),
      publishedAt: options.publishedAt?.toISOString() ?? null,
      hasImage: true,
      hasVideo: false,
      bodyImageCount: 2,
      storyClusterId: '77',
      clusterSize: 4,
    },
    languageMode: 'native',
    translation: null,
    questionSets: {
      enrich: { id: '1', version: 'e', sha256: hex('b') },
      match: { id: '2', version: 'm', sha256: hex('d') },
    },
    cardTextMode: 'as_written',
    model: { engine: 'typesafe', model: 'fixture-model' },
    cards: options.cards.map((c) => ({
      cardId: c.cardId,
      kind: c.kind,
      strength: c.strength,
      question: {},
      cardInputSha256: hex('f'),
    })),
  };
  return withConnection(s.ctx.owner, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.user_id', $1, true)", [s.userId]);
      const inserted = await client.query<{ input_sha: string }>(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         VALUES ($1, $2, $3, $4, 1, 1, $5::jsonb,
                 encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex'))
         RETURNING input_sha`,
        [requestId, s.userId, s.feedId, articleId, JSON.stringify(inputSnapshot)],
      );
      const inputSha = inserted.rows[0]!.input_sha;
      const result = {
        v: 1,
        requestId,
        inputSha,
        processedAt: new Date().toISOString(),
        article: { id: articleId, revision: '1' },
        model: { engine: 'typesafe', model: 'fixture-model' },
        translation: null,
        enrich: {
          questionSetSha: hex('b'),
          stateSha256: hex('c'),
          stateVariant: 'native',
          answers: {},
          features: options.facets,
        },
        match: {
          questionSetSha: hex('d'),
          stateSha256: hex('e'),
          stateVariant: 'native',
          cards: options.cards
            .filter((c) => c.p !== undefined)
            .map((c) => ({ cardId: c.cardId, cardInputSha256: hex('f'), p: c.p, answer: {} })),
          l2: [],
        },
      };
      await client.query(
        `UPDATE analysis_requests
            SET result_snapshot = $2::jsonb, result_sha = $3, status = 'complete',
                completed_at = now()
          WHERE id = $1`,
        [requestId, JSON.stringify(result), '9'.repeat(64)],
      );
      await client.query('COMMIT');
      return { requestId, inputSha };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
