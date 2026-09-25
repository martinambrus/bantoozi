import { newUserId } from '@bantoozi/shared';
import { cardTextHash, sha256Hex } from '@bantoozi/shared/server';

/**
 * Data factories (spec 01 §6): user, feed, article, card and subscription rows through plain SQL,
 * so this package never depends on `@bantoozi/db` (which uses it for tests). Call them with an owner
 * or worker connection: they create fixtures, bypassing tenant RLS and API column grants.
 */

/** A node-postgres client or pool. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

let sequence = 0;
const nextSeq = (): number => {
  sequence += 1;
  return sequence;
};

export interface UserFixture {
  id: string;
  email: string;
}

export async function createUser(
  db: Queryable,
  overrides: {
    id?: string;
    email?: string;
    role?: 'user' | 'admin';
    plan?: string;
    locale?: 'en' | 'sk';
    createdAt?: Date;
    lastActiveAt?: Date | null;
    deletedAt?: Date | null;
  } = {},
): Promise<UserFixture> {
  const id = overrides.id ?? newUserId();
  const email = overrides.email ?? `user-${nextSeq()}-${id.slice(-8)}@example.test`;
  await db.query(
    `INSERT INTO users (id, email, role, plan, locale, created_at, last_active_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8)`,
    [
      id,
      email,
      overrides.role ?? 'user',
      overrides.plan ?? 'beta',
      overrides.locale ?? 'en',
      overrides.createdAt ?? null,
      overrides.lastActiveAt ?? null,
      overrides.deletedAt ?? null,
    ],
  );
  return { id, email };
}

export interface FeedFixture {
  id: string;
  url: string;
}

export async function createFeed(
  db: Queryable,
  overrides: { url?: string; title?: string; status?: string } = {},
): Promise<FeedFixture> {
  const url = overrides.url ?? `https://feeds.example.test/${nextSeq()}.xml`;
  const result = await db.query<{ id: string }>(
    `INSERT INTO feeds (url, fetch_url, title, status) VALUES ($1, $1, $2, $3) RETURNING id::text AS id`,
    [url, overrides.title ?? `Feed ${url}`, overrides.status ?? 'active'],
  );
  return { id: result.rows[0]!.id, url };
}

export interface ArticleFixture {
  id: string;
  urlKey: string;
  contentRevision: string;
}

/** An article, carried by the given feeds (`feed_items`). */
export async function createArticle(
  db: Queryable,
  overrides: {
    feedIds?: readonly string[];
    title?: string;
    url?: string;
    excerpt?: string | null;
    author?: string | null;
    publishedAt?: Date | null;
    contentRevision?: number;
    firstSeenAt?: Date;
  } = {},
): Promise<ArticleFixture> {
  const n = nextSeq();
  const url = overrides.url ?? `https://news.example.test/articles/${n}`;
  const title = overrides.title ?? `Article ${n}`;
  const urlKey = url.replace(/^https?:\/\//, '');
  const result = await db.query<{ id: string; content_revision: string }>(
    `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, author, excerpt, published_at,
                           first_seen_at, content_hash, content_revision)
     VALUES ($1, $1, $2, $3, lower($3), $4, $5, $6, coalesce($7, now()), $8, $9)
     RETURNING id::text AS id, content_revision::text AS content_revision`,
    [
      url,
      urlKey,
      title,
      overrides.author ?? null,
      overrides.excerpt === undefined ? `Excerpt of ${title}` : overrides.excerpt,
      overrides.publishedAt ?? null,
      overrides.firstSeenAt ?? null,
      sha256Hex(`${title}\n${url}`),
      overrides.contentRevision ?? 1,
    ],
  );
  const article = result.rows[0]!;
  for (const feedId of overrides.feedIds ?? []) {
    await db.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       VALUES ($1, $2, $3, coalesce($4, now()))`,
      [feedId, article.id, `guid-${n}`, overrides.firstSeenAt ?? null],
    );
  }
  return { id: article.id, urlKey, contentRevision: article.content_revision };
}

export interface CardFixture {
  id: string;
  textHash: string;
}

export async function createCard(
  db: Queryable,
  overrides: {
    kind?: 'interest' | 'label';
    visibility?: 'public' | 'shared' | 'private';
    origin?: 'library' | 'user' | 'fork';
    ownerUserId?: string | null;
    creatorUserId?: string | null;
    title?: string;
    interest?: string;
    notFor?: string | null;
    slug?: string | null;
    topicIds?: readonly string[];
    lang?: string;
  } = {},
): Promise<CardFixture> {
  const n = nextSeq();
  const kind = overrides.kind ?? 'interest';
  const visibility = overrides.visibility ?? 'shared';
  const ownerUserId = visibility === 'private' ? (overrides.ownerUserId ?? null) : null;
  const title = overrides.title ?? `Card ${n}`;
  const interest = overrides.interest ?? `Interest number ${n}`;
  const notFor = overrides.notFor ?? null;
  const origin =
    overrides.origin ??
    (visibility === 'private' ? 'fork' : visibility === 'public' ? 'library' : 'user');
  const textHash = cardTextHash({
    kind,
    title,
    interest,
    not_for: notFor,
    visibility,
    owner_user_id: ownerUserId,
  });
  const body = { interest, not_for: notFor, interest_en: null, not_for_en: null };
  const result = await db.query<{ id: string }>(
    `INSERT INTO interest_cards (kind, slug, title, body, text_hash, lang, topic_ids, origin, visibility,
                                 owner_user_id, creator_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
    [
      kind,
      overrides.slug ?? null,
      title,
      JSON.stringify(body),
      textHash,
      overrides.lang ?? 'en',
      overrides.topicIds ?? [],
      origin,
      visibility,
      ownerUserId,
      overrides.creatorUserId === undefined ? ownerUserId : overrides.creatorUserId,
    ],
  );
  return { id: result.rows[0]!.id, textHash };
}

/** A subscription; non-`off` modes start at version 1 (as after one explicit mode change). */
export async function createSubscription(
  db: Queryable,
  input: {
    userId: string;
    feedId: string;
    mode?: 'off' | 'training' | 'active';
    version?: number;
    activatedAt?: Date;
  },
): Promise<void> {
  const mode = input.mode ?? 'off';
  await db.query(
    `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version, inference_activated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'active' THEN coalesce($5, now()) END)`,
    [
      input.userId,
      input.feedId,
      mode,
      input.version ?? (mode === 'off' ? 0 : 1),
      input.activatedAt ?? null,
    ],
  );
}
