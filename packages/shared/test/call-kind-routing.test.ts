import { describe, expect, expectTypeOf, it } from 'vitest';

import { ASK_KINDS, CALL_KIND_PROFILES, type AskCallKind } from '../src/call-kinds.js';
import type { ExternalCall } from '../src/ports.js';

// Eval can enter either API; its invocation router records both as eval.
describe('call kind routing', () => {
  it('preserves the ask and external unions, including eval in both', () => {
    expect(ASK_KINDS).toEqual(['enrich', 'match', 'cluster', 'suggest', 'eval']);
    expectTypeOf<AskCallKind>().toEqualTypeOf<
      'enrich' | 'match' | 'cluster' | 'suggest' | 'eval'
    >();
    expectTypeOf<ExternalCall['kind']>().toEqualTypeOf<
      'translate' | 'eval' | 'credential_probe' | 'card_draft' | 'model_probe'
    >();
  });
  it('classifies every current kind without changing either API', () => {
    const routes = {
      enrich: 'ask',
      match: 'ask',
      cluster: 'ask',
      suggest: 'ask',
      translate: 'external',
      eval: 'both',
      credential_probe: 'external',
      card_draft: 'external',
      model_probe: 'external',
    } as const;
    for (const [kind, route] of Object.entries(routes)) {
      expect(CALL_KIND_PROFILES[kind as keyof typeof routes], kind).toHaveProperty('route', route);
    }
  });
});
