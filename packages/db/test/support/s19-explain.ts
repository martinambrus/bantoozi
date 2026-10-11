import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type pg from 'pg';

import type { Database } from '../../src/client.js';
import { tenantUserId, withTenant, type TenantTx } from '../../src/tenant.js';
import { asTenant } from './test-db.js';

/**
 * Capture the exact statement a repository function issues (the function is called for real; the
 * statement is recorded as it goes through `tx.execute`) and measure it with
 * EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) as the same tenant role.
 */

export interface RenderedQuery {
  text: string;
  params: unknown[];
}

const dialect = new PgDialect();

export function render(query: SQL): RenderedQuery {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { text, params };
}

/** The statements `fn` executes on its tenant transaction, in order. */
export async function captureStatements(
  db: Database,
  userId: string,
  fn: (tx: TenantTx) => Promise<unknown>,
): Promise<RenderedQuery[]> {
  const captured: RenderedQuery[] = [];
  await withTenant(db, userId, async (tx) => {
    const real = tx.execute.bind(tx) as (query: SQL) => Promise<unknown>;
    (tx as unknown as { execute: (query: SQL) => Promise<unknown> }).execute = (query) => {
      captured.push(render(query));
      return real(query);
    };
    expectTenant(tx);
    await fn(tx);
  });
  return captured.filter((q) => !/^\s*(begin|commit|rollback)\b/iu.test(q.text));
}

function expectTenant(tx: TenantTx): void {
  tenantUserId(tx);
}

/** `$n` replaced by quoted literals, for running a captured statement in psql or a script. */
export function inlineParams(query: RenderedQuery): string {
  return query.text.replace(/\$(\d+)\b/gu, (_match, n: string) => {
    const value = query.params[Number(n) - 1];
    if (value === null || value === undefined) return 'NULL';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return `'${text.replaceAll("'", "''")}'`;
  });
}

export interface BufferReport {
  /** Shared hit + read blocks of the executed plan. */
  execution: number;
  /** Shared hit + read blocks of planning. */
  planning: number;
  total: number;
  executionMs: number;
  planningMs: number;
}

interface PlanNode {
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
}

export async function explainBuffers(
  appPool: pg.Pool,
  userId: string,
  text: string,
  params: unknown[],
): Promise<BufferReport> {
  const result = await asTenant(appPool, userId, (client) =>
    client.query<{
      'QUERY PLAN': {
        Plan: PlanNode;
        Planning?: PlanNode;
        'Execution Time': number;
        'Planning Time': number;
      }[];
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, params),
  );
  const top = result.rows[0]?.['QUERY PLAN'][0];
  if (top === undefined) throw new Error('EXPLAIN returned no plan');
  const blocks = (node: PlanNode | undefined): number =>
    (node?.['Shared Hit Blocks'] ?? 0) + (node?.['Shared Read Blocks'] ?? 0);
  const execution = blocks(top.Plan);
  const planning = blocks(top.Planning);
  return {
    execution,
    planning,
    total: execution + planning,
    executionMs: top['Execution Time'],
    planningMs: top['Planning Time'],
  };
}

export { sql };
