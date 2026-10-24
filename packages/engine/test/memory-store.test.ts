import {
  CALL_KINDS,
  kindMatchesAuthorization,
  type InferenceAuthorization,
} from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { createMemoryEngineStore } from './support/memory-store.js';

const authorizations: InferenceAuthorization[] = [
  { type: 'article', articleId: '1', articleRevision: '1', witnesses: [] },
  { type: 'suggest', userId: 'user', eligibleArticleIds: ['1'], leaseToken: 'lease' },
  { type: 'eval', runId: 'run' },
  {
    type: 'credential_probe',
    provider: 'typesafe',
    candidateVersion: 'candidate',
    validationToken: 'validation',
  },
  { type: 'card_draft', userId: 'user', draftId: 'draft' },
  { type: 'model_probe', model: 'jev-latest' },
];

describe('memory store authorization pairing', () => {
  for (const kind of CALL_KINDS) {
    it.each(authorizations)(`${kind} under $type matches the real store`, async (authorization) => {
      // Demand is deliberately authorized: this control isolates the kind/type pairing.
      const store = createMemoryEngineStore({ dailyBudgetUsd: 1 });
      const id = await store.reserveSpend({
        day: '2026-10-24',
        engine: 'typesafe',
        kind,
        estimateUsd: 0.01,
        priority: 'bulk',
        authorization,
      });
      const admitted = kindMatchesAuthorization(kind, authorization.type);
      expect(id !== null).toBe(admitted);
      expect(store.reservations).toHaveLength(admitted ? 1 : 0);
    });
  }

  it('still refuses an otherwise matching kind when live demand is lost', async () => {
    const store = createMemoryEngineStore({ dailyBudgetUsd: 1 });
    store.authorize = () => false;
    const id = await store.reserveSpend({
      day: '2026-10-24',
      engine: 'typesafe',
      kind: 'model_probe',
      estimateUsd: 0.01,
      priority: 'bulk',
      authorization: { type: 'model_probe', model: 'jev-latest' },
    });
    expect(id).toBeNull();
    expect(store.reservations).toHaveLength(0);
  });
});
