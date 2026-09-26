import { bigint, customType, timestamp } from 'drizzle-orm/pg-core';

/** `citext` (extension installed by infra/postgres/init.sh). */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/** `bigint`, surfaced as JS `bigint` (never round-tripped through `number`, spec 01 §5). */
export const int8 = (name: string) => bigint(name, { mode: 'bigint' });

/** `timestamptz`. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
