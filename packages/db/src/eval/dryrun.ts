import { normalizeText } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import type { Transaction } from '../client.js';

/**
 * `eval dry-run` (spec 10 §3 "Other commands", M3a-T8): the separate dry-run database and its
 * synthetic collection. The database is (re)created from the migrated template through the test
 * admin connection, which the eval process uses for nothing else; only names starting with
 * {@link DRYRUN_DATABASE_PREFIX} are ever created or dropped, so no other database is touched.
 */

export const DRYRUN_DATABASE_PREFIX = 'bantoozi_eval_dryrun';

const NAME = /^bantoozi_eval_dryrun(?:_[a-z0-9_]{1,40})?$/;
/** The template lock and marker of `@bantoozi/testing` (spec 02 §1.1 test databases). */
const TEMPLATE_LOCK = "hashtext('bantoozi_template')";
const READY_MARKER = 'bantoozi-template-ready';

/** A dry-run database name (`bantoozi_eval_dryrun` or `bantoozi_eval_dryrun_<suffix>`). */
export function isDryRunDatabaseName(name: string): boolean {
  return NAME.test(name);
}

function assertDryRunName(name: string): void {
  if (!isDryRunDatabaseName(name)) {
    throw new Error(`refusing to touch database ${name}: not a dry-run database name`);
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'bantoozi-eval' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function terminate(admin: pg.Client, name: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [name],
  );
}

/**
 * Drop `name` when present and create it again as a copy of the ready `template` (owner
 * `bantoozi_owner`, CONNECT for the app and worker roles only), under the template lock so a
 * template rebuild never races the copy.
 */
export async function recreateDryRunDatabase(input: {
  adminUrl: string;
  name: string;
  template: string;
}): Promise<void> {
  assertDryRunName(input.name);
  if (!/^bantoozi_template_[0-9a-f]{12}$/.test(input.template)) {
    throw new Error(`invalid template name ${input.template}`);
  }
  await withAdmin(input.adminUrl, async (admin) => {
    await admin.query(`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`);
    try {
      const marker = await admin.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
        [input.template],
      );
      if (marker.rows[0]?.marker !== READY_MARKER) {
        throw new Error(`template ${input.template} is not ready`);
      }
      await terminate(admin, input.name);
      await admin.query(`DROP DATABASE IF EXISTS ${quote(input.name)}`);
      await admin.query(
        `CREATE DATABASE ${quote(input.name)} TEMPLATE ${quote(input.template)} OWNER bantoozi_owner`,
      );
      await admin.query(`REVOKE ALL ON DATABASE ${quote(input.name)} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quote(input.name)} TO bantoozi_app, bantoozi_worker`,
      );
    } finally {
      await admin.query(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`);
    }
  });
}

/** Drop a dry-run database (tests clean up their uniquely named one). */
export async function dropDryRunDatabase(input: { adminUrl: string; name: string }): Promise<void> {
  assertDryRunName(input.name);
  await withAdmin(input.adminUrl, async (admin) => {
    await terminate(admin, input.name);
    await admin.query(`DROP DATABASE IF EXISTS ${quote(input.name)}`);
  });
}

/** Mark a synthetic golden feed's language hint and title. */
export async function markSyntheticFeed(
  tx: Transaction,
  input: { feedId: string; langHint: string; title: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE feeds SET lang_hint = ${input.langHint}, title = ${input.title}
     WHERE id = ${input.feedId}::bigint`);
}

export interface SyntheticArticleInput {
  url: string;
  title: string;
  excerpt: string;
  lang: string;
  wordCount: number;
  publishedAt: Date;
  firstSeenAt: Date;
}

/**
 * An extracted synthetic article carried by `feedId` (one `feed_items` row), with its detected
 * language: the state the ingest-only collection leaves an article in (spec 10 §2.1).
 */
export async function insertSyntheticArticle(
  tx: Transaction,
  feedId: string,
  input: SyntheticArticleInput,
): Promise<string> {
  const urlKey = input.url.replace(/^https?:\/\//, '');
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, published_at,
                          first_seen_at, content_hash, content_revision, lang, pipeline_state,
                          word_count)
    VALUES (${input.url}, ${input.url}, ${urlKey}, ${input.title}, ${normalizeText(input.title)},
            ${input.excerpt}, ${input.publishedAt.toISOString()}::timestamptz,
            ${input.firstSeenAt.toISOString()}::timestamptz,
            ${sha256Hex(`${input.title}\n${input.excerpt}\n${input.url}`)}, 1, ${input.lang},
            'extracted', ${input.wordCount})
    RETURNING id::text AS id`);
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('article insert returned no row');
  await tx.execute(sql`
    INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES (${feedId}::bigint, ${id}::bigint, ${input.url},
            ${input.firstSeenAt.toISOString()}::timestamptz)`);
  return id;
}
