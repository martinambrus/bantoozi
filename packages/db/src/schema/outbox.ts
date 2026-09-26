import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './accounts.js';
import { int8, tstz } from './columns.js';

/** Durable job intents (spec 02 §3.2): written in the state transaction, relayed by the worker. */
export const jobOutbox = pgTable(
  'job_outbox',
  {
    id: int8('id').primaryKey().generatedAlwaysAsIdentity(),
    queue: text('queue').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    availableAt: tstz('available_at').notNull().defaultNow(),
    deliveredAt: tstz('delivered_at'),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseUntil: tstz('lease_until'),
    lastError: text('last_error'),
  },
  (t) => [
    check('job_outbox_attempts_check', sql`attempts >= 0`),
    check('job_outbox_lease_check', sql`(lease_token IS NULL) = (lease_until IS NULL)`),
    check('job_outbox_payload_check', sql`jsonb_typeof(payload) = 'object'`),
    index('job_outbox_pending_idx')
      .on(t.availableAt, t.id)
      .where(sql`delivered_at IS NULL`),
    uniqueIndex('job_outbox_dedupe_idx')
      .on(t.queue, t.dedupeKey)
      .where(sql`delivered_at IS NULL AND dedupe_key IS NOT NULL`),
  ],
);
