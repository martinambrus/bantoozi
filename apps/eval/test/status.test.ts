import { describe, expect, it } from 'vitest';

import { formatStatus } from '../src/commands/status.js';

/** M3a-T2: the `eval status` layout (spec 10 §2.1). */

describe('formatStatus', () => {
  it('prints per-language sample counts, per-rater progress and facet labels per language', () => {
    const text = formatStatus({
      dataset: {
        version: 'golden-v1',
        parentVersion: null,
        seed: 'golden-v1',
        params: {},
        manifest: null,
        snapshotSha: null,
        splitSha: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        frozenAt: null,
      },
      collected: [
        { lang: 'en', articles: 900, eligible: 800, pending: 50, stale: 40, failed: 10 },
        { lang: 'sk', articles: 600, eligible: 550, pending: 0, stale: 50, failed: 0 },
      ],
      sample: [
        { lang: 'en', dev: 350, test: 150 },
        { lang: 'sk', dev: 280, test: 120 },
      ],
      raters: [
        {
          raterId: '1',
          name: 'Owner',
          participantKey: '6f1c2d3e-0000-4000-8000-000000000001',
          contextName: 'web development',
          langs: ['sk', 'en'],
          cards: 7,
          neverCards: 1,
          feeds: 12,
          assigned: 300,
          rated: 120,
          skipped: 4,
          pending: 176,
          likes: 50,
          dislikes: 70,
          revoked: false,
        },
      ],
      facets: [{ labeler: 'owner', lang: 'en', articles: 40, labels: 240 }],
    });
    expect(text).toContain('dataset golden-v1, seed "golden-v1", open (no model run yet)');
    expect(text).toMatch(/en\s+900\s+800\s+500\s+350\s+150/);
    expect(text).toMatch(/sk\s+600\s+550\s+400\s+280\s+120/);
    expect(text).toMatch(/all\s+1500\s+1350\s+900\s+630\s+270/);
    expect(text).toMatch(
      /1\s+Owner \(web development\)\s+6f1c2d3e\s+sk,en\s+7\s+1\s+12\s+300\s+120\s+4\s+176\s+50\s+70/,
    );
    expect(text).toContain('1 context(s) of 1 participant(s)');
    expect(text).toMatch(/owner\s+en\s+40\s+240/);
  });

  it('says what to run first on an empty database', () => {
    const text = formatStatus({
      dataset: null,
      collected: null,
      sample: [],
      raters: [],
      facets: [],
    });
    expect(text).toContain('dataset: none yet (run `eval sample`)');
    expect(text).toContain('collection: no evaluation user (run `eval ingest-sample`)');
    expect(text).toContain('(no raters yet');
    expect(text).toContain('Facet labels per language\n(none yet)');
  });
});
