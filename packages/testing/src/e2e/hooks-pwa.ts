import { HookParamsError, record, runner, type Hook, type NamedHook } from './hooks-kit.js';

/**
 * SQL hooks of the PWA check of spec 09 §9 (pwa.pw.ts). The check reads from the database only what
 * no HTTP endpoint shows.
 */

function emailAddress(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new HookParamsError(`${name} must be an email address of at most 254 characters`);
  }
  return value;
}

export interface FeedbackEventFeaturesRow {
  kind: string;
  articleId: string;
  /** The value has a `features` entry; an `open` event gets one only under implicit feedback. */
  hasFeatures: boolean;
}

/**
 * The feedback events one account has written, oldest first, each with whether it stores
 * behavioural `features`. The values themselves are not returned.
 */
const feedbackEventFeatures: Hook<{ email: string }> = {
  parse: (params) => ({ email: emailAddress(record(params, ['email'])['email'], 'email') }),
  async run(db, { email }) {
    const { rows } = await db.query(
      `SELECT e.kind AS "kind", e.article_id::text AS "articleId",
              jsonb_exists(e.value, 'features') AS "hasFeatures"
         FROM feedback_events e
         JOIN users u ON u.id = e.user_id
        WHERE u.email = $1
        ORDER BY e.id`,
      [email],
    );
    return rows as FeedbackEventFeaturesRow[];
  },
};

export const PWA_HOOKS: readonly NamedHook[] = [
  ['feedbackEventFeatures', runner(feedbackEventFeatures)],
];
