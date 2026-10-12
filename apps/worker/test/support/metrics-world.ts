import { randomUUID } from 'node:crypto';

import { parseJobPayload } from '@bantoozi/shared';
import { createArticle, createUser } from '@bantoozi/testing';
import type pg from 'pg';

import type { WorkerDeps } from '../../src/handlers/deps.js';
import { DAY, HOUR, MINUTE, type ClassifyHarness } from './classify.js';

export { DAY, HOUR, MINUTE };

export type Lane = 'new' | 'for_you' | 'maybe' | 'everything' | 'hidden';

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The title every article of the world carries; it must never reach a stored snapshot. */
export const SECRET_TITLE = 'Zebra-Quartz-Confidential headline';

export interface WorldUser {
  id: string;
  email: string;
}

export interface WorldArticle {
  id: string;
  title: string;
  url: string;
}

/**
 * Fixtures of the `house.metrics` tests (spec 10 §7): feedback events are written in plain SQL with
 * the `value.before` snapshot the API stores (spec 06 §8.2), so the tests never depend on the
 * current `user_article` lane, which a rerank may have changed since. The handler runs with a fake
 * clock through a dynamic import, so a missing module fails each test, not the whole file.
 */
export class MetricsWorld {
  constructor(readonly h: ClassifyHarness) {}

  get owner(): pg.Pool {
    return this.h.owner;
  }

  async run(now: Date): Promise<void> {
    const module = await import('../../src/handlers/house-metrics.js');
    const deps = { ...this.h.deps, now: () => now } as unknown as WorkerDeps;
    const handle = module.createMetricsHandler(deps);
    await handle(parseJobPayload('house.metrics', {}), {
      queue: 'house.metrics',
      jobId: 'direct',
    });
  }

  /** Remove everything a previous test left behind. */
  async reset(): Promise<void> {
    await this.owner.query('DELETE FROM feedback_events');
    await this.owner.query('DELETE FROM user_article');
    await this.owner.query("DELETE FROM settings WHERE key LIKE 'metrics.daily.%'");
  }

  async user(): Promise<WorldUser> {
    const user = await createUser(this.owner, { plan: 'beta' });
    return { id: user.id, email: user.email };
  }

  async article(): Promise<WorldArticle> {
    const seed = randomUUID();
    const url = `https://metrics.example.test/${seed}`;
    const article = await createArticle(this.owner, {
      title: `${SECRET_TITLE} ${seed}`,
      url,
      excerpt: `Excerpt Marmalade-Hedgehog ${seed}`,
    });
    return { id: article.id, title: `${SECRET_TITLE} ${seed}`, url };
  }

  /** The cached ranking of `article` for `user` (what a rerank leaves behind, not feedback time). */
  async cachedLane(user: WorldUser, article: WorldArticle, lane: Lane): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_article (user_id, article_id, lane)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, article_id) DO UPDATE SET lane = EXCLUDED.lane`,
      [user.id, article.id, lane],
    );
  }

  async event(
    user: WorldUser,
    article: WorldArticle,
    kind: string,
    at: Date,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [user.id, article.id, kind, JSON.stringify({ v: 1, ...value }), at],
    );
  }

  /** The `before` snapshot of spec 06 §8.2. */
  before(lane: Lane, tier: number | null = null): Record<string, unknown> {
    return {
      lane,
      pLike: tier === null ? null : tier / 5 - 0.1,
      tier,
      scoreVersion: '1:1',
      rankRevision: 1,
      scoredAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async rate(
    user: WorldUser,
    article: WorldArticle,
    rating: 1 | -1,
    lane: Lane | null,
    at: Date,
    tier: number | null = null,
  ): Promise<void> {
    await this.event(user, article, 'rate', at, {
      rating,
      reason: null,
      hide: false,
      signalOrigin: 'explicit',
      ...(lane === null ? {} : { before: this.before(lane, tier) }),
    });
  }

  /** A rating whose snapshot carries no lane (`before: {}`), unlike {@link rate} with `null`. */
  async rateWithEmptyBefore(
    user: WorldUser,
    article: WorldArticle,
    rating: 1 | -1,
    at: Date,
  ): Promise<void> {
    await this.event(user, article, 'rate', at, { rating, reason: null, hide: false, before: {} });
  }

  async unrate(user: WorldUser, article: WorldArticle, lane: Lane, at: Date): Promise<void> {
    await this.event(user, article, 'unrate', at, {
      rating: null,
      reason: null,
      hide: false,
      before: this.before(lane),
    });
  }

  /** The undo of a rating (spec 08: `action: 'rating'`); it does not name the rating it restored. */
  async undoRating(user: WorldUser, article: WorldArticle, at: Date): Promise<void> {
    await this.event(user, article, 'undo', at, {
      action: 'rating',
      restored: ['rating', 'reason', 'ratedAt'],
      signalOrigin: 'explicit',
    });
  }

  async open(user: WorldUser, article: WorldArticle, lane: Lane, at: Date): Promise<void> {
    await this.event(user, article, 'open', at, {
      signalOrigin: 'explicit',
      before: this.before(lane),
    });
  }

  async bookmark(user: WorldUser, article: WorldArticle, lane: Lane, at: Date): Promise<void> {
    await this.event(user, article, 'bookmark', at, { before: this.before(lane) });
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────────

  async setting(key: string, value: unknown): Promise<void> {
    await this.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async snapshotKeys(): Promise<string[]> {
    const result = await this.owner.query<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'metrics.daily.%' ORDER BY key",
    );
    return result.rows.map((row) => row.key);
  }

  async snapshot(day: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.owner.query<{ value: Record<string, unknown> }>(
      'SELECT value FROM settings WHERE key = $1',
      [`metrics.daily.${day}`],
    );
    return result.rows[0]?.value;
  }
}

/** The value at a dotted `path` of a stored snapshot, `undefined` when any step is missing. */
export function pick(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const step of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}
