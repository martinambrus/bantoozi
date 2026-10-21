import { describe, expect, it } from 'vitest';

import { enginePrecedence, isPrimaryAnswer, isReusableFacet } from '../../src/index.js';

const PIN = 'jev-1.14.0';

describe('reuse stays exact across releases of one Jev major', () => {
  it('does not treat an answer of another release as primary', () => {
    const older = { engine: 'typesafe', model: 'jev-1.13.0' };
    expect(isPrimaryAnswer(older, PIN)).toBe(false);
    expect(enginePrecedence(older, PIN)).toBe(0);
    expect(isPrimaryAnswer({ engine: 'typesafe', model: PIN }, PIN)).toBe(true);
  });

  it('does not reuse facets of another release', () => {
    const current = { articleRevision: '1', primaryModel: PIN };
    const stored = { articleRevision: '1', stateSha256: 'a', engine: 'typesafe' };
    expect(isReusableFacet({ ...stored, model: 'jev-1.13.0' }, current)).toBe(false);
    expect(isReusableFacet({ ...stored, model: PIN }, current)).toBe(true);
  });
});
