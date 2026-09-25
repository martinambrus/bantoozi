import { readFileSync } from 'node:fs';

import { QUEUE_NAMES } from '@bantoozi/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG_BOSS_SCHEMA_VERSION, PG_BOSS_VERSION } from '../src/migrate/migrate.js';
import { setupDbTest, withConnection, type DbTestContext } from './support/test-db.js';

/**
 * Schema parity (spec 02 §8.1): the migrated catalog equals the hand-written expected-schema.json.
 * Table definitions are compared semantically: the expected columns, constraints, indexes, RLS
 * flags and policies are created from the spec text in a scratch schema and both sides are deparsed
 * by PostgreSQL, so spelling differences (`IN (…)` vs `= ANY (ARRAY[…])`) never matter but any
 * change in meaning does. Grants, functions and triggers are compared with the JSON directly.
 */

interface ExpectedColumn {
  type: string;
  nullable: boolean;
  default: string | null;
  identity?: 'always' | 'by default';
}
interface ExpectedTable {
  columns: Record<string, ExpectedColumn>;
  primaryKey: string[];
  unique: string[][];
  checks: string[];
  foreignKeys: {
    columns: string[];
    references: string;
    onDelete: string;
    deferrable: false | string;
  }[];
  indexes: Record<string, { unique: boolean; definition: string }>;
  rls: false | { forced: boolean };
  storage?: Record<string, { storage: string; compression: string }>;
}
interface ExpectedPolicy {
  table: string;
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}
interface ExpectedFunction {
  args: string;
  result: string;
  language: string;
  volatility: string;
  securityDefiner: boolean;
  config: string[];
  execute: string[];
}
interface ExpectedTrigger {
  table: string;
  timing: string;
  events: string[];
  columns: string[];
  function: string;
  args: string[];
  constraint: string | null;
  when: string | null;
}
interface ExpectedSchema {
  extensions: string[];
  tables: Record<string, ExpectedTable>;
  policies: ExpectedPolicy[];
  privileges: {
    bantoozi_app: {
      schemas: Record<string, string[]>;
      tables: Record<string, string[]>;
      columns: Record<string, Record<string, string[]>>;
      sequences: string[];
      drizzleMigrations: string[];
    };
    bantoozi_worker: {
      schemas: Record<string, string[]>;
      allTables: string[];
      allSequences: string[];
      pgbossTables: string[];
    };
  };
  functions: Record<string, ExpectedFunction>;
  triggers: Record<string, ExpectedTrigger>;
  pgBoss: { version: string; schemaVersion: number };
}

const expected = JSON.parse(
  readFileSync(new URL('./expected-schema.json', import.meta.url), 'utf8'),
) as ExpectedSchema;
const TABLES = Object.keys(expected.tables);
const EXPECTED_SCHEMA = 'parity_expected';
const PRIVILEGE_ORDER = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];
const byPrivilege = (a: string, b: string) =>
  PRIVILEGE_ORDER.indexOf(a) - PRIVILEGE_ORDER.indexOf(b);

/** DDL that recreates the expected tables, indexes, RLS and policies inside `schema`. */
function expectedDdl(schema: string): string[] {
  const statements: string[] = [];
  for (const [name, table] of Object.entries(expected.tables)) {
    const parts = Object.entries(table.columns).map(([column, c]) =>
      [
        column,
        c.type,
        c.identity === undefined ? '' : `GENERATED ${c.identity.toUpperCase()} AS IDENTITY`,
        c.nullable ? '' : 'NOT NULL',
        c.default === null ? '' : `DEFAULT ${c.default}`,
      ]
        .filter((p) => p !== '')
        .join(' '),
    );
    parts.push(`PRIMARY KEY (${table.primaryKey.join(', ')})`);
    for (const columns of table.unique) parts.push(`UNIQUE (${columns.join(', ')})`);
    for (const check of table.checks) parts.push(`CHECK (${check})`);
    statements.push(`CREATE TABLE ${schema}.${name} (${parts.join(', ')})`);
  }
  for (const [name, table] of Object.entries(expected.tables)) {
    for (const fk of table.foreignKeys) {
      const target = /^(\w+)\((.+)\)$/.exec(fk.references);
      if (target === null) throw new Error(`bad FK target ${fk.references}`);
      statements.push(
        `ALTER TABLE ${schema}.${name} ADD FOREIGN KEY (${fk.columns.join(', ')}) ` +
          `REFERENCES ${schema}.${target[1]}(${target[2]}) ON DELETE ${fk.onDelete}` +
          (fk.deferrable === false ? '' : ` DEFERRABLE ${fk.deferrable}`),
      );
    }
    for (const [index, spec] of Object.entries(table.indexes)) {
      statements.push(
        `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${index} ON ${schema}.${name} ${spec.definition}`,
      );
    }
    if (table.rls !== false) {
      statements.push(`ALTER TABLE ${schema}.${name} ENABLE ROW LEVEL SECURITY`);
      if (table.rls.forced)
        statements.push(`ALTER TABLE ${schema}.${name} FORCE ROW LEVEL SECURITY`);
    }
    for (const [column, s] of Object.entries(table.storage ?? {})) {
      statements.push(
        `ALTER TABLE ${schema}.${name} ALTER COLUMN ${column} SET STORAGE ${s.storage}`,
      );
      statements.push(
        `ALTER TABLE ${schema}.${name} ALTER COLUMN ${column} SET COMPRESSION ${s.compression}`,
      );
    }
  }
  for (const p of expected.policies) {
    statements.push(
      [
        `CREATE POLICY ${p.name} ON ${schema}.${p.table}`,
        p.command === 'ALL' ? '' : `FOR ${p.command}`,
        `TO ${p.roles.join(', ')}`,
        p.using === null ? '' : `USING (${p.using})`,
        p.withCheck === null ? '' : `WITH CHECK (${p.withCheck})`,
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
  }
  return statements;
}

interface DescribedTable {
  columns: {
    name: string;
    type: string;
    notNull: boolean;
    default: string | null;
    identity: string;
    storage: string;
    compression: string;
  }[];
  constraints: string[];
  indexes: Record<string, string>;
  rls: { enabled: boolean; forced: boolean };
  policies: Record<
    string,
    {
      cmd: string;
      permissive: boolean;
      roles: string[];
      using: string | null;
      check: string | null;
    }
  >;
}

/** The catalog of one schema, deparsed with that schema first on the search path. */
async function describeSchema(
  client: pg.PoolClient,
  schema: string,
): Promise<Record<string, DescribedTable>> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SET LOCAL search_path = ${schema === 'public' ? 'public' : `${schema}, public`}`,
    );
    const tables: Record<string, DescribedTable> = {};
    const rels = await client.query<{ name: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p') ORDER BY 1`,
      [schema],
    );
    for (const r of rels.rows) {
      tables[r.name] = {
        columns: [],
        constraints: [],
        indexes: {},
        rls: { enabled: r.enabled, forced: r.forced },
        policies: {},
      };
    }
    const table = (name: string): DescribedTable => {
      const t = tables[name];
      if (t === undefined) throw new Error(`unknown table ${name}`);
      return t;
    };
    const columns = await client.query<{
      table: string;
      name: string;
      type: string;
      not_null: boolean;
      default: string | null;
      identity: string;
      storage: string;
      compression: string;
    }>(
      `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default,
              a.attidentity::text AS identity, a.attstorage::text AS storage,
              a.attcompression::text AS compression
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
      [schema],
    );
    for (const c of columns.rows) {
      table(c.table).columns.push({
        name: c.name,
        type: c.type,
        notNull: c.not_null,
        default: c.default,
        identity: c.identity,
        storage: c.storage,
        compression: c.compression,
      });
    }
    const constraints = await client.query<{ table: string; def: string }>(
      `SELECT c.relname AS table, con.contype::text || ': ' || pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND con.contype <> 't' ORDER BY 1, 2`,
      [schema],
    );
    // Constraint triggers (contype 't') are compared with the trigger inventory below.
    for (const c of constraints.rows) table(c.table).constraints.push(c.def);
    const indexes = await client.query<{ table: string; name: string; def: string }>(
      `SELECT c.relname AS table, i.relname AS name,
              regexp_replace(pg_get_indexdef(x.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON \\S+ ', '\\1') AS def
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid
                                                          AND con.contype IN ('p','u'))`,
      [schema],
    );
    for (const i of indexes.rows) table(i.table).indexes[i.name] = i.def;
    const policies = await client.query<{
      table: string;
      name: string;
      cmd: string;
      permissive: boolean;
      roles: string[];
      using: string | null;
      check: string | null;
    }>(
      `SELECT c.relname AS table, p.polname AS name, p.polcmd::text AS cmd, p.polpermissive AS permissive,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END
                      FROM unnest(p.polroles) AS r ORDER BY 1) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1`,
      [schema],
    );
    for (const p of policies.rows) {
      table(p.table).policies[p.name] = {
        cmd: p.cmd,
        permissive: p.permissive,
        roles: p.roles,
        using: p.using,
        check: p.check,
      };
    }
    return tables;
  } finally {
    await client.query('ROLLBACK');
  }
}

let ctx: DbTestContext;
let actualTables: Record<string, DescribedTable>;
let expectedTables: Record<string, DescribedTable>;

beforeAll(async () => {
  ctx = await setupDbTest();
  await withConnection(ctx.owner, async (client) => {
    await client.query(`CREATE SCHEMA ${EXPECTED_SCHEMA}`);
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path = ${EXPECTED_SCHEMA}, public`);
    for (const statement of expectedDdl(EXPECTED_SCHEMA)) await client.query(statement);
    await client.query('COMMIT');
    actualTables = await describeSchema(client, 'public');
    expectedTables = await describeSchema(client, EXPECTED_SCHEMA);
  });
});

afterAll(async () => {
  await ctx.close();
});

describe('schema parity with expected-schema.json', () => {
  it('has exactly the expected public tables', () => {
    expect(Object.keys(actualTables).sort()).toEqual([...TABLES].sort());
  });

  it.each(TABLES)('table %s matches columns, constraints, indexes, RLS and policies', (name) => {
    expect(actualTables[name]).toEqual(expectedTables[name]);
  });

  it('installs the expected extensions', async () => {
    const result = await ctx.owner.query<{ extname: string }>(
      'SELECT extname FROM pg_extension ORDER BY 1',
    );
    expect(result.rows.map((r) => r.extname)).toEqual(expected.extensions);
  });

  it('has exactly the expected functions, owned by bantoozi_owner with explicit EXECUTE grants', async () => {
    const result = await ctx.owner.query<{
      name: string;
      owner: string;
      args: string;
      result: string;
      language: string;
      volatility: string;
      security_definer: boolean;
      config: string[];
      execute: string[];
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner)::text AS owner,
              pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
              l.lanname::text AS language, p.provolatile::text AS volatility,
              p.prosecdef AS security_definer, coalesce(p.proconfig, '{}') AS config,
              ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1) AS execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                                      AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
    );
    expect(new Set(result.rows.map((r) => r.owner))).toEqual(new Set(['bantoozi_owner']));
    const actual = Object.fromEntries(
      result.rows.map((r) => [
        r.name,
        {
          args: r.args,
          result: r.result,
          language: r.language,
          volatility: r.volatility,
          securityDefiner: r.security_definer,
          config: r.config,
          execute: r.execute,
        },
      ]),
    );
    expect(actual).toEqual(expected.functions);
  });

  it('has exactly the expected integrity triggers', async () => {
    const result = await ctx.owner.query<{
      name: string;
      table: string;
      type: number;
      function: string;
      columns: string[];
      args: Buffer;
      is_constraint: boolean;
      deferrable: boolean;
      deferred: boolean;
      def: string;
    }>(
      `SELECT t.tgname AS name, c.relname AS table, t.tgtype::int AS type, p.proname AS function,
              ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) AS u(attnum)
                      JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = u.attnum) AS columns,
              t.tgargs AS args, t.tgconstraint <> 0 AS is_constraint, t.tgdeferrable AS deferrable,
              t.tginitdeferred AS deferred, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
    );
    const actual = Object.fromEntries(
      result.rows.map((r) => {
        // pg_trigger.tgtype is a bit mask: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
        expect(r.type & 1).toBe(1);
        const timing = r.type & 2 ? 'BEFORE' : 'AFTER';
        const events = [
          ...(r.type & 4 ? ['INSERT'] : []),
          ...(r.type & 8 ? ['DELETE'] : []),
          ...(r.type & 16 ? ['UPDATE'] : []),
        ];
        const args = r.args.length === 0 ? [] : r.args.toString('utf8').split('\0').slice(0, -1);
        return [
          r.name,
          {
            table: r.table,
            timing,
            events: events.sort(),
            columns: [...r.columns].sort(),
            function: r.function,
            args,
            constraint: r.is_constraint
              ? `DEFERRABLE INITIALLY ${r.deferred ? 'DEFERRED' : 'IMMEDIATE'}`
              : null,
            when: /\bWHEN \((.*)\) EXECUTE FUNCTION\b/.exec(r.def)?.[1] ?? null,
          },
        ];
      }),
    );
    const normalized = Object.fromEntries(
      Object.entries(expected.triggers).map(([name, t]) => [
        name,
        { ...t, events: [...t.events].sort(), columns: [...t.columns].sort() },
      ]),
    );
    expect(actual).toEqual(normalized);
  });

  describe('privileges', () => {
    it('grants the API role exactly the explicit table and column privileges of §1.2', async () => {
      const tables = await ctx.owner.query<{ table: string; privileges: string[] }>(
        `SELECT c.relname AS table,
                ARRAY(SELECT a.privilege_type FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
                       WHERE a.grantee = 'bantoozi_app'::regrole) AS privileges
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
      );
      const actualTablePrivileges = Object.fromEntries(
        tables.rows.map((r) => [r.table, [...r.privileges].sort(byPrivilege)]),
      );
      const expectedTablePrivileges = Object.fromEntries(
        Object.entries(expected.privileges.bantoozi_app.tables).map(([t, p]) => [
          t,
          [...p].sort(byPrivilege),
        ]),
      );
      expect(actualTablePrivileges).toEqual(expectedTablePrivileges);

      const columns = await ctx.owner.query<{
        table: string;
        privilege: string;
        columns: string[];
      }>(
        `SELECT c.relname AS table, a.privilege_type AS privilege, array_agg(att.attname::text ORDER BY att.attname) AS columns
           FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(att.attacl) AS a
          WHERE n.nspname = 'public' AND att.attacl IS NOT NULL AND a.grantee = 'bantoozi_app'::regrole
          GROUP BY 1, 2`,
      );
      const actualColumns: Record<string, Record<string, string[]>> = {};
      for (const r of columns.rows) (actualColumns[r.table] ??= {})[r.privilege] = r.columns;
      const expectedColumns = Object.fromEntries(
        Object.entries(expected.privileges.bantoozi_app.columns).map(([t, byPriv]) => [
          t,
          Object.fromEntries(Object.entries(byPriv).map(([p, cols]) => [p, [...cols].sort()])),
        ]),
      );
      expect(actualColumns).toEqual(expectedColumns);
    });

    it('grants sequence and schema access only where §1.2 says so', async () => {
      const sequences = await ctx.owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S'
            AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) AS a
                         WHERE a.grantee = 'bantoozi_app'::regrole AND a.privilege_type = 'USAGE')
          ORDER BY 1`,
      );
      expect(sequences.rows.map((r) => r.name).sort()).toEqual(
        [...expected.privileges.bantoozi_app.sequences].sort(),
      );

      for (const [role, schemas] of Object.entries({
        bantoozi_app: expected.privileges.bantoozi_app.schemas,
        bantoozi_worker: expected.privileges.bantoozi_worker.schemas,
      })) {
        for (const [schema, privileges] of Object.entries(schemas)) {
          const result = await ctx.owner.query<{ usage: boolean; create: boolean }>(
            `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage, has_schema_privilege($1, $2, 'CREATE') AS create`,
            [role, schema],
          );
          expect({ role, schema, ...result.rows[0] }).toEqual({
            role,
            schema,
            usage: privileges.includes('USAGE'),
            create: false,
          });
        }
      }
      const migrations = await ctx.owner.query<{ privileges: string[] }>(
        `SELECT ARRAY(SELECT a.privilege_type FROM aclexplode(c.relacl) AS a
                       WHERE a.grantee = 'bantoozi_app'::regrole ORDER BY 1) AS privileges
           FROM pg_class c WHERE c.oid = 'drizzle.__drizzle_migrations'::regclass`,
      );
      expect(migrations.rows[0]?.privileges).toEqual(
        expected.privileges.bantoozi_app.drizzleMigrations,
      );
    });

    it('gives the worker DML on every table and sequence, and nothing to PUBLIC', async () => {
      const worker = expected.privileges.bantoozi_worker;
      const tables = await ctx.owner.query<{
        schema: string;
        table: string;
        privileges: string[];
        public: string[];
      }>(
        `SELECT n.nspname AS schema, c.relname AS table,
                ARRAY(SELECT a.privilege_type FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
                       WHERE a.grantee = 'bantoozi_worker'::regrole) AS privileges,
                ARRAY(SELECT a.privilege_type FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
                       WHERE a.grantee = 0) AS public
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public','pgboss') AND c.relkind IN ('r','p')`,
      );
      for (const r of tables.rows) {
        const wanted = r.schema === 'public' ? worker.allTables : worker.pgbossTables;
        expect({
          table: `${r.schema}.${r.table}`,
          privileges: [...r.privileges].sort(byPrivilege),
        }).toEqual({
          table: `${r.schema}.${r.table}`,
          privileges: [...wanted].sort(byPrivilege),
        });
        expect({ table: r.table, public: r.public }).toEqual({ table: r.table, public: [] });
      }
      const sequences = await ctx.owner.query<{ name: string; privileges: string[] }>(
        `SELECT c.relname AS name,
                ARRAY(SELECT a.privilege_type FROM aclexplode(c.relacl) AS a
                       WHERE a.grantee = 'bantoozi_worker'::regrole ORDER BY 1) AS privileges
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S'`,
      );
      for (const s of sequences.rows) expect(s.privileges).toEqual(worker.allSequences);
      const publicFunctions = await ctx.owner.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public','pgboss') AND has_function_privilege('public', p.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                                        AND d.objid = p.oid AND d.deptype = 'e')`,
      );
      expect(publicFunctions.rows).toEqual([]);
    });
  });

  it('runs the pinned pg-boss schema with every jobs.ts queue', async () => {
    expect(PG_BOSS_VERSION).toBe(expected.pgBoss.version);
    const version = await ctx.owner.query<{ version: number }>(
      'SELECT version FROM pgboss.version',
    );
    expect(version.rows[0]?.version).toBe(expected.pgBoss.schemaVersion);
    expect(PG_BOSS_SCHEMA_VERSION).toBe(expected.pgBoss.schemaVersion);
    const queues = await ctx.owner.query<{ name: string }>(
      'SELECT name FROM pgboss.queue ORDER BY 1',
    );
    expect(queues.rows.map((q) => q.name)).toEqual([...QUEUE_NAMES].sort());
  });
});
