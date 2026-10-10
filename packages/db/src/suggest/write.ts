import { sql, type SQL } from 'drizzle-orm';

import type { Database, Executor } from '../client.js';
import { readStoredSetting, shareLockSettings } from '../settings.js';
import { SUGGEST_DISMISS_DAYS } from './evidence.js';

/**
 * The current model pin (spec 05 §7): `settings['engine.model_pin'].model` when written, else the
 * configured primary model.
 */
export async function readSuggestPin(db: Executor, fallbackModel: string): Promise<string> {
  const stored = await readStoredSetting(db, 'engine.model_pin');
  const model = (stored as { model?: unknown } | null | undefined)?.model;
  return typeof model === 'string' && model !== '' ? model : fallbackModel;
}

export interface SuggestFinish {
  userId: string;
  leaseToken: string;
  /**
   * Cards to store (a `none` win or no ask is an empty list, which clears the undismissed rows);
   * null stores nothing and keeps the undismissed rows (a discarded result).
   */
  results: readonly { cardId: string; score: number }[] | null;
  /** The suggest set and pin the answer was asked under; a change since discards the results. */
  asked?: { questionSetId: string; pin: string };
  fallbackModel: string;
}

/** `written`: results applied; `discarded`: cleanup only; `lost`: the lease was not ours, nothing done. */
export type SuggestFinishStatus = 'written' | 'discarded' | 'lost';

const HELD = (userId: string, cardId: SQL) => sql`
  (EXISTS (SELECT 1 FROM user_cards uc JOIN interest_cards h ON h.id = uc.card_id
            WHERE uc.user_id = ${userId}::uuid AND (uc.card_id = ${cardId} OR h.parent_card_id = ${cardId}))
   OR EXISTS (SELECT 1 FROM user_labels ul WHERE ul.user_id = ${userId}::uuid AND ul.card_id = ${cardId}))`;

/**
 * The finishing transaction of every run (spec 05 §7 steps 6–7): lock the user row and require our
 * lease token; read the active suggest set and the pin under the settings share lock; clean up
 * (undismissed rows of held cards, of another set or pin; dismissals older than 90 days); store the
 * results (an upsert that revives only rows not dismissed in the last 90 days, skipping held
 * cards) and delete the other undismissed rows; release the lease. Never stamps `last_suggested_at`.
 */
export async function finishSuggestRun(
  db: Database,
  input: SuggestFinish,
): Promise<SuggestFinishStatus> {
  const { userId, leaseToken } = input;
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM users
       WHERE id = ${userId}::uuid AND suggest_lease_token = ${leaseToken}::uuid FOR UPDATE`);
    if (locked.rows[0] === undefined) return 'lost';
    await shareLockSettings(tx, [{ key: 'question_sets.active', initial: {} }]);
    await tx.execute(sql`
      SELECT key FROM settings WHERE key = 'engine.model_pin' FOR SHARE`);
    const active = await tx.execute<{ id: string | null }>(sql`
      SELECT value->>'suggest' AS id FROM settings WHERE key = 'question_sets.active'`);
    const activeSet = active.rows[0]?.id ?? null;
    const pin = await readSuggestPin(tx, input.fallbackModel);

    await tx.execute(sql`
      DELETE FROM card_suggestions s
       WHERE s.user_id = ${userId}::uuid
         AND ((s.dismissed_at IS NULL
               AND (${HELD(userId, sql`s.card_id`)}
                    OR s.model_pin <> ${pin}
                    ${activeSet === null ? sql.empty() : sql`OR s.question_set_id <> ${activeSet}::bigint`}))
              OR s.dismissed_at <= now() - make_interval(days => ${SUGGEST_DISMISS_DAYS}))`);

    let status: SuggestFinishStatus = 'discarded';
    const current =
      input.asked !== undefined &&
      activeSet === input.asked.questionSetId &&
      pin === input.asked.pin;
    if (input.results !== null && (input.asked === undefined ? true : current)) {
      status = 'written';
      const stored: string[] = [];
      for (const result of input.results) {
        if (activeSet === null) break;
        const upsert = await tx.execute(sql`
          INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
          SELECT ${userId}::uuid, ${result.cardId}::bigint, ${activeSet}::bigint, ${pin},
                 ${result.score}::real
           WHERE NOT ${HELD(userId, sql`${result.cardId}::bigint`)}
          ON CONFLICT (user_id, card_id) DO UPDATE
             SET score = EXCLUDED.score, question_set_id = EXCLUDED.question_set_id,
                 model_pin = EXCLUDED.model_pin, created_at = now(), dismissed_at = NULL
           WHERE card_suggestions.dismissed_at IS NULL
              OR card_suggestions.dismissed_at <= now() - make_interval(days => ${SUGGEST_DISMISS_DAYS})`);
        if ((upsert.rowCount ?? 0) > 0) stored.push(result.cardId);
      }
      await tx.execute(sql`
        DELETE FROM card_suggestions
         WHERE user_id = ${userId}::uuid AND dismissed_at IS NULL
           AND card_id <> ALL(${sql.param(stored)}::bigint[])`);
    }
    await tx.execute(sql`
      UPDATE users SET suggest_lease_token = NULL, suggest_lease_until = NULL
       WHERE id = ${userId}::uuid AND suggest_lease_token = ${leaseToken}::uuid`);
    return status;
  });
}
