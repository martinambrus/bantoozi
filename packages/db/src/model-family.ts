import { isConcreteJevModel, modelFamily } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

// SQL equivalent of isConcreteJevModel: ASCII digits/word characters and the 64-character id limit.
const CONCRETE_JEV = String.raw`^jev-[0-9]+\.[0-9]+\.[0-9]+([-+.][A-Za-z0-9_.-]+)?$`;

function concreteJevSql(model: SQL): SQL {
  return sql`(length(${model}) <= 64 AND ${model} ~ ${CONCRETE_JEV})`;
}

/** SQL equivalent of modelFamily, without a database function or migration. */
export function modelFamilySql(model: SQL): SQL {
  return sql`(CASE WHEN ${concreteJevSql(model)} THEN split_part(${model}, '.', 1) ELSE ${model} END)`;
}

/** Compare a stored id to a pin using sameModelFamily, keeping bare ids such as `jev-1` distinct. */
export function sameModelFamilySql(model: SQL, pin: string): SQL {
  return isConcreteJevModel(pin)
    ? sql`(${concreteJevSql(model)} AND ${modelFamilySql(model)} = ${modelFamily(pin)})`
    : sql`(${model} = ${modelFamily(pin)})`;
}
