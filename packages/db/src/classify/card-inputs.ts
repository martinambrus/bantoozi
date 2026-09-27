import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDateOrNull, type RawTimestamp } from '../timestamps.js';

/** What the card/label question builders read about a card (spec 05 §5.1–§5.2). */
export interface CardInput {
  id: string;
  kind: 'interest' | 'label';
  /** The shared card's title: part of a label's semantic text (never `user_labels.name`). */
  title: string;
  body: {
    interest: string;
    not_for?: string | null;
    interest_en?: string | null;
    not_for_en?: string | null;
    examples_yes?: string[];
    examples_no?: string[];
  };
  lang: string;
  topicIds: string[];
  visibility: 'public' | 'shared' | 'private';
  ownerUserId: string | null;
  retiredAt: Date | null;
}

/** Card rows by id (missing ids are absent from the map). */
export async function loadCardInputs(
  db: Executor,
  cardIds: readonly string[],
): Promise<Map<string, CardInput>> {
  if (cardIds.length === 0) return new Map();
  const result = await db.execute<{
    id: string;
    kind: 'interest' | 'label';
    title: string;
    body: CardInput['body'];
    lang: string;
    topic_ids: string[];
    visibility: CardInput['visibility'];
    owner_user_id: string | null;
    retired_at: RawTimestamp | null;
  }>(sql`
    SELECT id::text AS id, kind, title, body, lang, topic_ids, visibility,
           owner_user_id::text AS owner_user_id, retired_at
      FROM interest_cards WHERE id = ANY(${sql.param([...new Set(cardIds)])}::bigint[])`);
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        lang: row.lang,
        topicIds: row.topic_ids,
        visibility: row.visibility,
        ownerUserId: row.owner_user_id,
        retiredAt: toDateOrNull(row.retired_at),
      },
    ]),
  );
}
