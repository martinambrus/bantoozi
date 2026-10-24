import { randomUUID } from 'node:crypto';

import { CALL_KINDS, DECISION_KINDS } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HOUR,
  MINUTE,
  RecordingMailer,
  hostHealth,
  iso,
  opsEvent,
} from './support/alerts-world.js';

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12));
const before = (ms: number, from: Date = NOW): Date => new Date(from.getTime() - ms);
const after = (ms: number, from: Date = NOW): Date => new Date(from.getTime() + ms);

const FAILING_TITLE = 'Classification engine failing';
const MISMATCH_TITLE = 'Jev answered with another model';

let h: ClassifyHarness;
let w: AlertsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

type BreakerKind = 'open' | 'half_open' | 'auth' | 'closed';

interface BreakerSpec {
  openedAt?: Date;
  failingSince?: Date;
  reopenCount?: number;
}

async function typesafeBreaker(state: BreakerKind, spec: BreakerSpec = {}): Promise<void> {
  const typesafe: Record<string, unknown> = { state, reopenCount: spec.reopenCount ?? 0 };
  if (spec.openedAt !== undefined) {
    typesafe['openedAt'] = iso(spec.openedAt);
    typesafe['openUntil'] = iso(after(HOUR, spec.openedAt));
  }
  if (spec.failingSince !== undefined) typesafe['failingSince'] = iso(spec.failingSince);
  await w.setting('engine.circuit', {
    typesafe,
    llm: { state: 'closed', reopenCount: 0 },
    resetRequested: {},
  });
}

interface CallRow {
  createdAt: Date;
  status?: string;
  error?: string | null;
  model?: string | null;
  engine?: string;
  kind?: string;
  logicalRequestId?: string;
  attempts?: number;
}

async function engineCall(row: CallRow): Promise<void> {
  await h.owner.query(
    `INSERT INTO engine_calls (engine, kind, model, logical_request_id, status, error, created_at, attempts)
     VALUES ($1, $7, $2, $3, $4, $5, $6, $8)`,
    [
      row.engine ?? 'typesafe',
      row.model === undefined ? 'jev-latest' : row.model,
      row.logicalRequestId ?? randomUUID(),
      row.status ?? 'invalid_response',
      row.error === undefined ? 'model_mismatch:jev-1.13.0' : row.error,
      row.createdAt,
      row.kind ?? 'enrich',
      row.attempts ?? 1,
    ],
  );
}

async function resetWorld(now: Date): Promise<void> {
  await w.baseline(now);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query(
    `DELETE FROM settings WHERE key IN ('engine.typesafe_model', 'engine.model_pin')`,
  );
}

async function scenario(mutate?: () => Promise<void>): Promise<RecordingMailer> {
  await resetWorld(NOW);
  await mutate?.();
  const mailer = new RecordingMailer();
  await w.run(NOW, { mailer });
  return mailer;
}

async function emails(mutate?: () => Promise<void>): Promise<number> {
  return (await scenario(mutate)).to(ADMIN).length;
}

async function tick(at: Date, mailer: RecordingMailer): Promise<void> {
  await w.liveness(at);
  await w.events([opsEvent('backup_ok', before(HOUR, at)), hostHealth(before(MINUTE, at))]);
  await w.run(at, { mailer });
}

const mailText = (mailer: RecordingMailer): string =>
  mailer.sent.map((message) => `${message.subject}\n${message.text}`).join('\n----\n');

describe('house.alerts engine breaker streak (JEV-6)', () => {
  const openFresh = (failingSinceAgo: number) => () =>
    typesafeBreaker('open', {
      openedAt: before(MINUTE),
      failingSince: before(failingSinceAgo),
      reopenCount: 7,
    });

  it('open with a fresh openedAt fires when failingSince is 31 minutes old', async () => {
    expect(await emails(openFresh(31 * MINUTE))).toBe(1);
  });

  it('NEG: open with a fresh openedAt stays silent when failingSince is 29 minutes old', async () => {
    expect(await emails(openFresh(29 * MINUTE))).toBe(0);
  });

  it('half_open with failingSince 31 minutes old fires', async () => {
    expect(
      await emails(() =>
        typesafeBreaker('half_open', {
          openedAt: before(MINUTE),
          failingSince: before(31 * MINUTE),
        }),
      ),
    ).toBe(1);
  });

  it('NEG: half_open with failingSince 29 minutes old stays silent', async () => {
    expect(
      await emails(() =>
        typesafeBreaker('half_open', {
          openedAt: before(MINUTE),
          failingSince: before(29 * MINUTE),
        }),
      ),
    ).toBe(0);
  });

  it('NEG: a closed breaker stays silent', async () => {
    expect(await emails(() => typesafeBreaker('closed'))).toBe(0);
  });

  it('a legacy open state without failingSince fires when openedAt is 31 minutes old', async () => {
    expect(await emails(() => typesafeBreaker('open', { openedAt: before(31 * MINUTE) }))).toBe(1);
  });

  it('NEG: a legacy open state without failingSince stays silent when openedAt is 29 minutes old', async () => {
    expect(await emails(() => typesafeBreaker('open', { openedAt: before(29 * MINUTE) }))).toBe(0);
  });

  it('auth fires immediately with and without timestamps', async () => {
    expect(await emails(() => typesafeBreaker('auth', { openedAt: before(MINUTE) }))).toBe(1);
    expect(await emails(() => typesafeBreaker('auth'))).toBe(1);
  });

  it('the failing mail names the streak start, the last failure, the configured and the pinned model', async () => {
    const failingSince = before(31 * MINUTE);
    const mailer = await scenario(async () => {
      await typesafeBreaker('open', {
        openedAt: before(MINUTE),
        failingSince,
        reopenCount: 7,
      });
      await engineCall({ createdAt: before(2 * MINUTE) });
      await w.setting('engine.typesafe_model', 'jev-latest');
      await w.setting('engine.model_pin', { model: 'jev-1.13.0', since: iso(before(3 * DAY)) });
    });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain(FAILING_TITLE);
    expect(text).toContain(iso(failingSince));
    expect(text).toContain('invalid_response');
    expect(text).toContain('model_mismatch:jev-1.13.0');
    expect(text).toContain('jev-latest');
    expect(text).toContain('jev-1.13.0');
  });
});

describe('house.alerts detail lookups of the engine breaker mail (JEV-6)', () => {
  it('still fires, without the models, when the stored pin and model setting do not parse', async () => {
    const failingSince = before(31 * MINUTE);
    const mailer = await scenario(async () => {
      await typesafeBreaker('open', { openedAt: before(MINUTE), failingSince });
      await w.setting('engine.typesafe_model', { not: 'a model name' });
      await w.setting('engine.model_pin', { model: 5 });
    });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain(FAILING_TITLE);
    expect(text).toContain(iso(failingSince));
  });
});

describe('house.alerts last failure of the engine breaker mail (JEV-6)', () => {
  it('names the last classification failure, not a newer failed credential check', async () => {
    const mailer = await scenario(async () => {
      await typesafeBreaker('open', {
        openedAt: before(MINUTE),
        failingSince: before(31 * MINUTE),
      });
      await engineCall({ createdAt: before(5 * MINUTE), error: 'model_mismatch:jev-1.13.0' });
      await engineCall({
        createdAt: before(MINUTE),
        kind: 'credential_probe',
        status: 'error',
        error: 'probe_marker_zzz',
      });
    });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain('model_mismatch:jev-1.13.0');
    expect(text).not.toContain('probe_marker_zzz');
  });
});

describe('house.alerts rule engine.model_mismatch (JEV-6)', () => {
  const row = (overrides: Partial<CallRow> & { ageMs: number }) => () =>
    engineCall({ createdAt: before(overrides.ageMs), ...overrides });

  it('a mismatch row 10 minutes old fires one mail naming both models', async () => {
    const mailer = await scenario(row({ ageMs: 10 * MINUTE }));
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain(MISMATCH_TITLE);
    expect(text).toContain('jev-latest');
    expect(text).toContain('jev-1.13.0');
  });

  it('a mismatch row 44 minutes old still fires: the window spans the longest breaker probe gap', async () => {
    expect(await emails(row({ ageMs: 44 * MINUTE }))).toBe(1);
  });

  it('NEG: a mismatch row 46 minutes old stays silent', async () => {
    expect(await emails(row({ ageMs: 46 * MINUTE }))).toBe(0);
  });

  it('NEG: an ok row stays silent', async () => {
    expect(
      await emails(row({ ageMs: 5 * MINUTE, status: 'ok', error: null, model: 'jev-latest' })),
    ).toBe(0);
  });

  it('NEG: invalid_response with response_not_json stays silent', async () => {
    expect(await emails(row({ ageMs: 5 * MINUTE, error: 'response_not_json' }))).toBe(0);
  });

  it('NEG: a mismatch row of engine llm stays silent', async () => {
    expect(await emails(row({ ageMs: 5 * MINUTE, engine: 'llm' }))).toBe(0);
  });

  it.each(DECISION_KINDS.filter((k) => k !== 'enrich'))(
    'a mismatch row of a %s call fires like an enrich call',
    async (kind) => {
      expect(await emails(row({ ageMs: 5 * MINUTE, kind }))).toBe(1);
    },
  );

  it.each(CALL_KINDS.filter((k) => !DECISION_KINDS.includes(k)))(
    'NEG: a mismatch row of a %s call is not classification work and stays silent',
    async (kind) => {
      expect(await emails(row({ ageMs: 5 * MINUTE, kind }))).toBe(0);
    },
  );

  it('NEG: no engine_calls rows stay silent', async () => {
    expect(await emails()).toBe(0);
  });

  it('both conditions at once send one digest with both titles and nothing new 5 minutes later', async () => {
    const mailer = new RecordingMailer();
    await resetWorld(NOW);
    await typesafeBreaker('open', {
      openedAt: before(MINUTE),
      failingSince: before(31 * MINUTE),
    });
    await engineCall({ createdAt: before(2 * MINUTE) });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain(FAILING_TITLE);
    expect(text).toContain(MISMATCH_TITLE);
    await tick(after(5 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);
  });

  it('the mismatch stays open across a 20 minute gap between probes, then clears with exactly one recovery mail', async () => {
    const mailer = new RecordingMailer();
    await resetWorld(NOW);
    await engineCall({ createdAt: before(10 * MINUTE) });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(await w.activeEntries()).toHaveLength(1);

    await tick(after(20 * MINUTE), mailer);
    await tick(after(30 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(await w.activeEntries()).toHaveLength(1);

    await tick(after(40 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(2);
    const recovery = mailer.sent[1]!;
    expect(recovery.subject).toContain('RECOVERED');
    expect(recovery.text).toContain(MISMATCH_TITLE);
    expect(await w.activeEntries()).toHaveLength(0);
    await tick(after(45 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(2);
  });

  it('the breaker incident clears with exactly one recovery mail when the breaker closes', async () => {
    const mailer = new RecordingMailer();
    await resetWorld(NOW);
    await typesafeBreaker('open', {
      openedAt: before(MINUTE),
      failingSince: before(31 * MINUTE),
    });
    await w.run(NOW, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(await w.activeEntries()).toHaveLength(1);

    await typesafeBreaker('closed');
    await tick(after(10 * MINUTE), mailer);
    expect(mailer.to(ADMIN)).toHaveLength(2);
    const recovery = mailer.sent[1]!;
    expect(recovery.subject).toContain('RECOVERED');
    expect(recovery.text).toContain(FAILING_TITLE);
    expect(await w.activeEntries()).toHaveLength(0);
  });
});

describe('house.alerts rule engine.breaker without an open breaker (JEV-6)', () => {
  const fail = (ageMs: number, overrides: Partial<CallRow> = {}) =>
    engineCall({
      createdAt: before(ageMs),
      status: 'timeout',
      error: 'timeout',
      ...overrides,
    });
  const failures = async (count: number, overrides: Partial<CallRow> = {}) => {
    for (let i = 0; i < count; i += 1) await fail((i + 1) * MINUTE, overrides);
  };

  it('3 failing requests and no ok call in 30 minutes fire the failing alert', async () => {
    const mailer = await scenario(() => failures(3));
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const text = mailText(mailer);
    expect(text).toContain(FAILING_TITLE);
    expect(text).toContain('No TypeSafe classification call succeeded in the last 30 minutes');
    expect(text).toContain('3 failed requests');
  });

  it('NEG: no calls stay silent', async () => {
    expect(await emails()).toBe(0);
  });

  it('NEG: 3 failures and 1 ok call stay silent', async () => {
    expect(
      await emails(async () => {
        await failures(3);
        await engineCall({ createdAt: before(10 * MINUTE), status: 'ok', error: null });
      }),
    ).toBe(0);
  });

  it('NEG: 2 failing requests with retries as extra attempts stay silent', async () => {
    expect(
      await emails(async () => {
        const a = randomUUID();
        const b = randomUUID();
        for (const [id, attempts] of [
          [a, 1],
          [a, 2],
          [a, 3],
          [b, 1],
          [b, 2],
        ] as const)
          await fail(5 * MINUTE, { logicalRequestId: id, attempts });
      }),
    ).toBe(0);
  });

  it.each(CALL_KINDS.filter((k) => !DECISION_KINDS.includes(k)))(
    'NEG: 3 failing %s requests stay silent',
    async (kind) => {
      expect(await emails(() => failures(3, { kind }))).toBe(0);
    },
  );

  it('NEG: an ok call of kind translate does not silence the outage', async () => {
    expect(
      await emails(async () => {
        await failures(3);
        await engineCall({
          createdAt: before(MINUTE),
          kind: 'translate',
          status: 'ok',
          error: null,
        });
      }),
    ).toBe(1);
  });

  it('NEG: failures older than 30 minutes stay silent', async () => {
    expect(
      await emails(async () => {
        for (let i = 0; i < 3; i += 1) await fail(31 * MINUTE + i * MINUTE);
      }),
    ).toBe(0);
  });

  it('an open breaker keeps precedence: one mail, one incident', async () => {
    const mailer = await scenario(async () => {
      await failures(3);
      await typesafeBreaker('open', {
        openedAt: before(MINUTE),
        failingSince: before(31 * MINUTE),
      });
    });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(mailText(mailer)).toContain('The decision engine has been failing for');
    expect(mailText(mailer)).not.toContain('No TypeSafe classification call succeeded');
  });
});
