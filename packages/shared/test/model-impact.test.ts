import { describe, expect, it } from 'vitest';

import {
  MODEL_PROBE_MAX_AGE_MS,
  MODEL_PROBE_MAX_SKEW_MS,
  concreteModelOf,
  judgeModelProbe,
  modelChangeImpact,
  modelPathImpact,
  planModelChange,
  type EngineModelProbe,
  type ModelState,
} from '../src/index.js';

/**
 * JEV-5: the save-time rules of the TypeSafe model editor, shared by the admin API (which enforces
 * them) and the web editor (which shows them): which probe confirms a model, what a change does to
 * ratings and personal models, and when the eval-replay acknowledgement is required.
 */

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function probe(
  requested: string,
  answered: string | undefined,
  options: { ok?: boolean; at?: string; error?: string } = {},
): EngineModelProbe {
  const ok = options.ok ?? answered !== undefined;
  return {
    requested,
    ...(answered === undefined ? {} : { answered }),
    ok,
    at: options.at ?? at(-1_000),
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

const probes = (...list: EngineModelProbe[]): Record<string, EngineModelProbe> =>
  Object.fromEntries(list.map((p) => [p.requested, p]));

describe('judgeModelProbe', () => {
  it('asks for a probe when none of this id is stored', () => {
    expect(judgeModelProbe(undefined, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
    expect(judgeModelProbe(null, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
    expect(judgeModelProbe({}, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
    const other = probes(probe('jev-1.13.0', 'jev-1.13.0'));
    expect(judgeModelProbe(other, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
  });

  it('never reads an inherited property as a probe', () => {
    const inherited = Object.create(probes(probe('jev-1.14.0', 'jev-1.14.0'))) as Record<
      string,
      EngineModelProbe
    >;
    expect(judgeModelProbe(inherited, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
    expect(judgeModelProbe({}, 'constructor', NOW)).toEqual({ state: 'required' });
  });

  it('confirms a concrete id that Jev answered as itself', () => {
    const stored = probes(probe('jev-1.14.0', 'jev-1.14.0'));
    expect(judgeModelProbe(stored, 'jev-1.14.0', NOW)).toEqual({
      state: 'ok',
      probe: stored['jev-1.14.0'],
      concrete: 'jev-1.14.0',
    });
  });

  it('refuses a concrete id that Jev answered as another id, naming the answer', () => {
    const stored = probes(
      probe('jev-1.14.0', 'jev-1.13.0', { ok: false, error: 'model_mismatch' }),
    );
    const verdict = judgeModelProbe(stored, 'jev-1.14.0', NOW);
    expect(verdict.state).toBe('failed');
    expect(verdict.state === 'failed' ? verdict.probe.answered : undefined).toBe('jev-1.13.0');
  });

  it('refuses an ok probe whose answer is another id than a concrete request', () => {
    const stored = probes(probe('jev-1.14.0', 'jev-fake', { ok: true }));
    expect(judgeModelProbe(stored, 'jev-1.14.0', NOW).state).toBe('failed');
  });

  it('trusts the ok flag, not the answer alone: a failed probe never confirms an id', () => {
    const failedSame = probes(
      probe('jev-1.14.0', 'jev-1.14.0', { ok: false, error: 'cost_overrun' }),
    );
    expect(judgeModelProbe(failedSame, 'jev-1.14.0', NOW).state).toBe('failed');
    const failedAlias = probes(probe('jev-latest', 'jev-1.14.0', { ok: false, error: 'timeout' }));
    expect(judgeModelProbe(failedAlias, 'jev-latest', NOW).state).toBe('failed');
  });

  it('refuses a failed probe and an ok probe without an answer', () => {
    const failed = probes(
      probe('jev-1.14.0', undefined, { ok: false, error: 'model_unavailable' }),
    );
    expect(judgeModelProbe(failed, 'jev-1.14.0', NOW).state).toBe('failed');
    const unanswered = probes(probe('jev-1.14.0', undefined, { ok: true }));
    expect(judgeModelProbe(unanswered, 'jev-1.14.0', NOW).state).toBe('failed');
  });

  it('confirms the alias only when Jev answered a concrete Jev release, and returns that release', () => {
    const resolved = probes(probe('jev-latest', 'jev-1.14.0'));
    expect(judgeModelProbe(resolved, 'jev-latest', NOW)).toEqual({
      state: 'ok',
      probe: resolved['jev-latest'],
      concrete: 'jev-1.14.0',
    });
    const echoed = probes(probe('jev-latest', 'jev-latest'));
    expect(judgeModelProbe(echoed, 'jev-latest', NOW).state).toBe('failed');
    const fake = probes(probe('jev-latest', 'jev-fake'));
    expect(judgeModelProbe(fake, 'jev-latest', NOW).state).toBe('failed');
    const unresolved = probes(
      probe('jev-latest', undefined, { ok: false, error: 'alias_unresolved' }),
    );
    expect(judgeModelProbe(unresolved, 'jev-latest', NOW).state).toBe('failed');
  });

  it('accepts a release with a suffix as the alias answer', () => {
    const stored = probes(probe('jev-latest', 'jev-1.14.0-rc1'));
    const verdict = judgeModelProbe(stored, 'jev-latest', NOW);
    expect(verdict.state === 'ok' ? verdict.concrete : undefined).toBe('jev-1.14.0-rc1');
  });

  it('is fresh up to ten minutes and not a millisecond longer', () => {
    const edge = probes(probe('jev-1.14.0', 'jev-1.14.0', { at: at(-MODEL_PROBE_MAX_AGE_MS) }));
    expect(judgeModelProbe(edge, 'jev-1.14.0', NOW).state).toBe('ok');
    const old = probes(probe('jev-1.14.0', 'jev-1.14.0', { at: at(-MODEL_PROBE_MAX_AGE_MS - 1) }));
    expect(judgeModelProbe(old, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
  });

  it('ages a failed probe the same way: an old failure asks for a new probe', () => {
    const old = probes(
      probe('jev-1.14.0', 'jev-1.13.0', { ok: false, at: at(-MODEL_PROBE_MAX_AGE_MS - 1) }),
    );
    expect(judgeModelProbe(old, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
  });

  it('tolerates a little clock skew into the future and no more', () => {
    const near = probes(probe('jev-1.14.0', 'jev-1.14.0', { at: at(MODEL_PROBE_MAX_SKEW_MS) }));
    expect(judgeModelProbe(near, 'jev-1.14.0', NOW).state).toBe('ok');
    const far = probes(probe('jev-1.14.0', 'jev-1.14.0', { at: at(MODEL_PROBE_MAX_SKEW_MS + 1) }));
    expect(judgeModelProbe(far, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
  });

  it('treats an unreadable time as no probe', () => {
    const broken = probes(probe('jev-1.14.0', 'jev-1.14.0', { at: 'yesterday' }));
    expect(judgeModelProbe(broken, 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
  });
});

describe('concreteModelOf', () => {
  it('is the id itself for a concrete setting, whatever the resolution and the pin say', () => {
    expect(concreteModelOf('jev-1.14.0', { model: 'jev-1.13.0' }, { model: 'jev-1.12.0' })).toBe(
      'jev-1.14.0',
    );
    expect(concreteModelOf('jev-fake', null, null)).toBe('jev-fake');
  });

  it('is the resolution for the alias, then the pin, then nothing', () => {
    expect(concreteModelOf('jev-latest', { model: 'jev-1.13.0' }, { model: 'jev-1.12.0' })).toBe(
      'jev-1.13.0',
    );
    expect(concreteModelOf('jev-latest', null, { model: 'jev-1.12.0' })).toBe('jev-1.12.0');
    expect(concreteModelOf('jev-latest', undefined, undefined)).toBeNull();
  });

  it('does not take an alias for a pinned release', () => {
    expect(concreteModelOf('jev-latest', null, { model: 'jev-latest' })).toBeNull();
    expect(concreteModelOf('jev-latest', { model: 'jev-1.13.0' }, { model: 'jev-latest' })).toBe(
      'jev-1.13.0',
    );
  });
});

describe('modelChangeImpact', () => {
  it('changes nothing when the concrete model stays', () => {
    expect(modelChangeImpact('jev-1.13.0', 'jev-1.13.0')).toBe('none');
  });

  it('keeps ratings and personal models inside one Jev major', () => {
    expect(modelChangeImpact('jev-1.13.0', 'jev-1.14.0')).toBe('kept');
    expect(modelChangeImpact('jev-1.14.0', 'jev-1.13.0')).toBe('kept');
    expect(modelChangeImpact('jev-1.14.0', 'jev-1.14.0-rc1')).toBe('kept');
  });

  it('restarts personal models across majors and for any other id', () => {
    expect(modelChangeImpact('jev-1.13.0', 'jev-2.0.0')).toBe('restart');
    expect(modelChangeImpact('jev-fake', 'jev-1.14.0')).toBe('restart');
    expect(modelChangeImpact('jev-1.13.0', 'jev-fake')).toBe('restart');
    expect(modelChangeImpact('other-1.13.0', 'jev-1.13.0')).toBe('restart');
  });

  it('never skips the acknowledgement on a guess: an unknown current model restarts', () => {
    expect(modelChangeImpact(null, 'jev-1.13.0')).toBe('restart');
  });

  it('does not treat the alias as a release: callers resolve it first', () => {
    expect(modelChangeImpact('jev-1.13.0', 'jev-latest')).toBe('restart');
  });
});

describe('modelPathImpact', () => {
  it('is the worst impact of the legs of a path', () => {
    expect(modelPathImpact('jev-1.13.0', 'jev-1.13.0')).toBe('none');
    expect(modelPathImpact('jev-1.13.0', 'jev-1.13.0', 'jev-1.14.0')).toBe('kept');
    expect(modelPathImpact('jev-1.14.0', 'jev-1.13.0', 'jev-2.0.0')).toBe('restart');
    expect(modelPathImpact('jev-2.0.0', 'jev-1.13.0', 'jev-1.14.0')).toBe('restart');
    expect(modelPathImpact('jev-1.14.0', 'jev-1.13.0', 'jev-1.14.0')).toBe('kept');
  });

  it('restarts when the starting point is unknown, and has no legs for no steps', () => {
    expect(modelPathImpact(null, 'jev-1.13.0')).toBe('restart');
    expect(modelPathImpact('jev-1.13.0')).toBe('none');
  });
});

describe('planModelChange', () => {
  const state = (over: Partial<ModelState> = {}): ModelState => ({
    setting: 'jev-1.13.0',
    resolution: null,
    pin: { model: 'jev-1.13.0' },
    probes: {},
    ...over,
  });

  it('asks for a probe, then refuses a probe that did not confirm the id', () => {
    expect(planModelChange(state(), 'jev-1.14.0', NOW)).toEqual({ state: 'required' });
    const wrong = probe('jev-1.14.0', 'jev-1.13.0', { ok: false, error: 'model_mismatch' });
    const plan = planModelChange(state({ probes: probes(wrong) }), 'jev-1.14.0', NOW);
    expect(plan).toEqual({ state: 'failed', probe: wrong });
  });

  it('keeps ratings inside one major and restarts across majors, for a concrete target', () => {
    const kept = planModelChange(
      state({ probes: probes(probe('jev-1.14.0', 'jev-1.14.0')) }),
      'jev-1.14.0',
      NOW,
    );
    expect(kept).toMatchObject({
      state: 'ok',
      current: 'jev-1.13.0',
      concrete: 'jev-1.14.0',
      impact: 'kept',
    });
    const restart = planModelChange(
      state({ probes: probes(probe('jev-2.0.0', 'jev-2.0.0')) }),
      'jev-2.0.0',
      NOW,
    );
    expect(restart).toMatchObject({ state: 'ok', impact: 'restart' });
  });

  it('moving between a release and the alias that resolves to it rebuilds nothing', () => {
    const toAlias = planModelChange(
      state({
        resolution: { model: 'jev-1.13.0' },
        probes: probes(probe('jev-latest', 'jev-1.13.0')),
      }),
      'jev-latest',
      NOW,
    );
    expect(toAlias).toMatchObject({ state: 'ok', concrete: 'jev-1.13.0', impact: 'none' });
    const fromAlias = planModelChange(
      state({
        setting: 'jev-latest',
        resolution: { model: 'jev-1.13.0' },
        probes: probes(probe('jev-1.13.0', 'jev-1.13.0')),
      }),
      'jev-1.13.0',
      NOW,
    );
    expect(fromAlias).toMatchObject({ state: 'ok', current: 'jev-1.13.0', impact: 'none' });
  });

  it('judges the alias by the release it answered now, not by the stored resolution alone', () => {
    const stored = state({ probes: probes(probe('jev-latest', 'jev-2.0.0')) });
    expect(planModelChange(stored, 'jev-latest', NOW)).toMatchObject({ impact: 'restart' });
    const same = state({ probes: probes(probe('jev-latest', 'jev-1.14.0')) });
    expect(planModelChange(same, 'jev-latest', NOW)).toMatchObject({ impact: 'kept' });
  });

  it('does not count a stale resolution: the restarting worker asks Jev before it pins a dormant row', () => {
    // Setting jev-2.0.0 (pin 2.0.0); the stored resolution still says 1.13.0; Jev now answers 2.0.0.
    const plan = planModelChange(
      state({
        setting: 'jev-2.0.0',
        pin: { model: 'jev-2.0.0' },
        resolution: { model: 'jev-1.13.0' },
        probes: probes(probe('jev-latest', 'jev-2.0.0')),
      }),
      'jev-latest',
      NOW,
    );
    expect(plan).toMatchObject({ state: 'ok', current: 'jev-2.0.0', concrete: 'jev-2.0.0' });
    expect(plan.state === 'ok' ? plan.impact : undefined).toBe('none');
    // Control: without a stored resolution the same switch is the same.
    const fresh = planModelChange(
      state({
        setting: 'jev-2.0.0',
        pin: { model: 'jev-2.0.0' },
        resolution: null,
        probes: probes(probe('jev-latest', 'jev-2.0.0')),
      }),
      'jev-latest',
      NOW,
    );
    expect(fresh).toMatchObject({ impact: 'none' });
  });

  it('restarts when nothing says which model is in use', () => {
    const plan = planModelChange(
      state({
        setting: 'jev-latest',
        pin: null,
        resolution: null,
        probes: probes(probe('jev-1.14.0', 'jev-1.14.0')),
      }),
      'jev-1.14.0',
      NOW,
    );
    expect(plan).toMatchObject({ state: 'ok', current: null, impact: 'restart' });
  });

  it('judges freshness at the time it is given', () => {
    const stored = state({ probes: probes(probe('jev-1.14.0', 'jev-1.14.0')) });
    expect(planModelChange(stored, 'jev-1.14.0', NOW).state).toBe('ok');
    expect(planModelChange(stored, 'jev-1.14.0', NOW + MODEL_PROBE_MAX_AGE_MS).state).toBe(
      'required',
    );
  });
});
