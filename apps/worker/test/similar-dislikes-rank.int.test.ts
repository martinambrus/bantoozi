import { scoreVersion } from '@bantoozi/ranker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DAY, ClassifyHarness } from './support/classify.js';
import {
  SIMPLE_MODEL,
  installModel,
  matched,
  rank,
  rankRow,
  reader,
  simpleP,
} from './support/rank-model-world.js';

/**
 * DPF-2 (black box): similar-dislike demotion in `user.rank`. Titles are raw `articles.title`
 * values; ratings and card answers are written through SQL; the real handler ranks.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

const OLD = [
  'Škoda 105 L zadné svetlo: 60',
  'Škoda 105 L blatník predný: 80',
  'Škoda 105 L sedadlá: 120',
];
const TARGET_TITLE = 'Škoda 105 L kapota: 90';
const MODERN = [
  'Škoda Octavia III 2.0 TDI 110kw: 12 900',
  'Škoda Superb 2 2.0TDI: 9 990',
  'Škoda Kodiaq 4x4 DSG: 24 500',
  'Škoda Fabia III 1.0 TSI: 8 400',
  'Škoda Karoq 2.0 TDI 4x4: 21 000',
];
const CONTROL_TITLE = 'Škoda Kamiq 1.5 TSI Style: 19 900';

async function rate(
  userId: string,
  articleId: string,
  rating: 1 | -1,
  ageMs: number,
  reason: string | null = null,
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, reason, rated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, article_id)
     DO UPDATE SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, rated_at = EXCLUDED.rated_at`,
    [userId, articleId, rating, reason, new Date(Date.now() - ageMs)],
  );
}

interface WorldOptions {
  prefs?: Record<string, unknown>;
  /** Ages of the three dislikes, oldest first. */
  dislikeAges?: number[];
  reason?: string | null;
  model?: boolean;
  fork?: boolean;
}

/** A reader with card C, 3 old-Škoda dislikes, 5 modern likes, an unrated target and control. */
async function world(options: WorldOptions = {}) {
  const r = await reader(h);
  let answerCard = r.cardId;
  let deciding = r.cardId;
  if (options.fork === true) {
    // Dislikes and likes were answered by fork X; the user now holds fork Y of the same parent.
    const parent = await h.card({ interest: 'used Skoda cars and parts' });
    const make = async (title: string) => {
      const made = await h.owner.query<{ id: string }>(
        `INSERT INTO interest_cards (kind, title, body, text_hash, lang, topic_ids, origin,
                                     visibility, owner_user_id, creator_user_id, parent_card_id)
         SELECT kind, $2, body, md5($2 || random()::text), lang, topic_ids, 'fork', 'private',
                $3::uuid, $3::uuid, id
           FROM interest_cards WHERE id = $1 RETURNING id::text AS id`,
        [parent, title, r.userId],
      );
      return made.rows[0]!.id;
    };
    answerCard = await make('Skoda fork X');
    deciding = await make('Skoda fork Y');
    await h.owner.query(`DELETE FROM user_cards WHERE user_id = $1`, [r.userId]);
    await h.hold(r.userId, deciding);
  }
  if (options.prefs !== undefined) {
    await h.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [r.userId, JSON.stringify(options.prefs)],
    );
  }
  if (options.model === true) await installModel(h, r.userId, SIMPLE_MODEL);
  const ages = options.dislikeAges ?? [5 * DAY, 3 * DAY, 1 * DAY];
  const dislikes: string[] = [];
  for (const [i, title] of OLD.entries()) {
    const id = await matched(h, r.feedId, answerCard, 0.9, { title });
    await rate(r.userId, id, -1, ages[i] ?? DAY, options.reason ?? null);
    dislikes.push(id);
  }
  for (const [i, title] of MODERN.entries()) {
    const id = await matched(h, r.feedId, answerCard, 0.9, { title });
    await rate(r.userId, id, 1, (i + 1) * DAY);
  }
  const target = await matched(h, r.feedId, deciding, 0.9, { title: TARGET_TITLE });
  const control = await matched(h, r.feedId, deciding, 0.9, { title: CONTROL_TITLE });
  await rank(h, r.userId, { full: true });
  return { ...r, cardId: deciding, dislikes, target, control, ages };
}

const ruleOf = (cardId: string) => `demote:similar:${cardId}`;

describe('similar-dislike demotion (DPF-2)', () => {
  it('W1 cards path: demotes the similar target by 0.6, not the modern control', async () => {
    const w = await world();
    const t = await rankRow(h, w.userId, w.target);
    const c = await rankRow(h, w.userId, w.control);
    expect(c.source).toBe('cards');
    expect(c.rules).not.toContain(ruleOf(w.cardId));
    expect(t.rules).toContain(ruleOf(w.cardId));
    expect(t.p).toBeCloseTo((c.p ?? 0) * 0.6, 3);
    const rule = t.explain?.rules?.find((x) => x.code === ruleOf(w.cardId));
    expect(rule).toMatchObject({ code: ruleOf(w.cardId), cardId: w.cardId });
    expect(Number(rule?.detail)).toBeGreaterThanOrEqual(2);
  });

  it("W2 prefs: demote.similar 'off' disables, 'on' applies", async () => {
    const off = await world({ prefs: { demote: { similar: 'off' } } });
    expect((await rankRow(h, off.userId, off.target)).rules).not.toContain(ruleOf(off.cardId));
    const on = await world({ prefs: { demote: { similar: 'on' } } });
    expect((await rankRow(h, on.userId, on.target)).rules).toContain(ruleOf(on.cardId));
  });

  it('W3 model path: demotes P by 0.6 and names the deciding card', async () => {
    const w = await world({ model: true });
    const t = await rankRow(h, w.userId, w.target);
    expect(t.source).toBe('model');
    expect(t.rules).toContain(ruleOf(w.cardId));
    expect(t.p).toBeCloseTo(simpleP(0.9) * 0.6, 3);
    expect(t.explain?.decidingCardId).toBe(w.cardId);
    const c = await rankRow(h, w.userId, w.control);
    expect(c.rules).not.toContain(ruleOf(w.cardId));
    expect(c.p).toBeCloseTo(simpleP(0.9), 3);
  });

  it('W4 age: dislikes older than 30 days do not count; fresh ones bound next_rank_at', async () => {
    const old = await world({ dislikeAges: [35 * DAY, 34 * DAY, 31 * DAY] });
    expect((await rankRow(h, old.userId, old.target)).rules).not.toContain(ruleOf(old.cardId));

    const fresh = await world({ dislikeAges: [20 * DAY, 10 * DAY, 2 * DAY] });
    const t = await rankRow(h, fresh.userId, fresh.target);
    expect(t.rules).toContain(ruleOf(fresh.cardId));
    const next = await h.owner.query<{ next_rank_at: Date | null }>(
      `SELECT next_rank_at FROM user_article WHERE user_id = $1 AND article_id = $2`,
      [fresh.userId, fresh.target],
    );
    const at = next.rows[0]?.next_rank_at;
    expect(at).not.toBeNull();
    // 2nd-newest similar dislike was rated 10 days ago.
    const limit = Date.now() - 10 * DAY + 30 * DAY + 5000;
    expect((at as Date).getTime()).toBeLessThanOrEqual(limit);
  });

  it('W5 reasons: clickbait dislikes are not evidence', async () => {
    const w = await world({ reason: 'clickbait' });
    expect((await rankRow(h, w.userId, w.target)).rules).not.toContain(ruleOf(w.cardId));
  });

  it('W6 family: dislikes answered by another fork of the same parent still count', async () => {
    const w = await world({ fork: true });
    const t = await rankRow(h, w.userId, w.target);
    expect(t.rules).toContain(ruleOf(w.cardId));
    const c = await rankRow(h, w.userId, w.control);
    expect(c.rules).not.toContain(ruleOf(w.cardId));
  });

  it('W7 version: ranked rows carry the current ranker version', async () => {
    const w = await world();
    const rows = await h.owner.query<{ score_version: string }>(
      `SELECT score_version FROM user_article
        WHERE user_id = $1 AND article_id = ANY($2::bigint[])`,
      [w.userId, [w.target, w.control]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows)
      expect(row.score_version.startsWith(`${scoreVersion(0).split(':')[0]}:`)).toBe(true);
  });
});
