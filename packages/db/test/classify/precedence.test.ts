import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { enginePrecedence, isPrimaryAnswer, precedenceOperator } from '../../src/index.js';

const PIN = 'jev-1.13.0';

describe('answer precedence (spec 05 §10)', () => {
  it.each([
    [{ engine: 'typesafe', model: PIN }, 2, true],
    [{ engine: 'typesafe', model: 'jev-1.12.0' }, 0, false],
    [{ engine: 'typesafe', model: null }, 0, false],
    [{ engine: 'llm', model: 'glm-strong' }, 1, false],
    [{ engine: 'prefilter', model: null }, 0, false],
    // Laya is not interchangeable with Jev until M9 gives it a precedence policy.
    [{ engine: 'laya', model: 'laya-multilingual' }, 0, false],
  ])('ranks %j at %i', (answer, precedence, primary) => {
    expect(enginePrecedence(answer, PIN)).toBe(precedence);
    expect(isPrimaryAnswer(answer, PIN)).toBe(primary);
  });

  it('replaces at equal precedence and fills only strictly lower entries', () => {
    const dialect = new PgDialect();
    const operator = (mode?: 'replace' | 'fill') =>
      dialect.sqlToQuery(
        precedenceOperator(
          mode === undefined ? { primaryModel: PIN } : { primaryModel: PIN, mode },
        ),
      ).sql;
    expect(operator()).toBe('<=');
    expect(operator('replace')).toBe('<=');
    expect(operator('fill')).toBe('<');
  });
});
