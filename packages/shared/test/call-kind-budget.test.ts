import { describe, expect, it } from 'vitest';

import { BUDGET_EXEMPT_KINDS, CALL_KINDS, CALL_KIND_PROFILES } from '../src/call-kinds.js';

describe('call kind budget exemption', () => {
  it('exempts only eval, while non-live probes still consume the production budget', () => {
    expect(BUDGET_EXEMPT_KINDS).toEqual(['eval']);
    for (const kind of CALL_KINDS) {
      expect(CALL_KIND_PROFILES[kind], kind).toHaveProperty('budgetExempt', kind === 'eval');
    }
  });
});
