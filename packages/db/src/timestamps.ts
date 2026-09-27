/**
 * Raw `db.execute` rows carry `timestamptz` columns as the driver's text (node-postgres parses them
 * only for typed Drizzle selects), so repositories map every raw timestamp through these helpers
 * and keep `Date` in their public types.
 */
export type RawTimestamp = Date | string;

export const toDate = (value: RawTimestamp): Date =>
  value instanceof Date ? value : new Date(value);

export const toDateOrNull = (value: RawTimestamp | null): Date | null =>
  value === null ? null : toDate(value);
