import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HOUR,
  MINUTE,
  RecordingMailer,
  iso,
} from './support/alerts-world.js';

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12));
const before = (ms: number, from: Date = NOW): Date => new Date(from.getTime() - ms);
const after = (ms: number, from: Date = NOW): Date => new Date(from.getTime() + ms);

let h: ClassifyHarness;
let w: AlertsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

async function openBreaker(): Promise<void> {
  const openedAt = before(MINUTE);
  await w.setting('engine.circuit', {
    typesafe: {
      state: 'open',
      reopenCount: 2,
      openedAt: iso(openedAt),
      openUntil: iso(after(HOUR, openedAt)),
      failingSince: iso(before(31 * MINUTE)),
    },
    llm: { state: 'closed', reopenCount: 0 },
    resetRequested: {},
  });
}

async function engineCall(createdAt: Date, overrides: Record<string, unknown> = {}): Promise<void> {
  await h.owner.query(
    `INSERT INTO engine_calls (engine, kind, model, logical_request_id, status, error, created_at, attempts)
     VALUES ('typesafe', 'enrich', 'jev-latest', $1, $2, $3, $4, 1)`,
    [
      randomUUID(),
      overrides['status'] ?? 'invalid_response',
      overrides['error'] === undefined ? 'model_mismatch:jev-1.13.0' : overrides['error'],
      createdAt,
    ],
  );
}

const resolution = (model = 'jev-1.14.0') => ({
  alias: 'jev-latest',
  model,
  resolvedAt: iso(before(2 * HOUR)),
  checkedAt: iso(before(10 * MINUTE)),
});

async function aliasWorld(): Promise<void> {
  await w.setting('engine.typesafe_model', 'jev-latest');
  await w.setting('engine.model_resolution', resolution());
  await w.setting('engine.model_pin', { model: 'jev-1.13.0', since: iso(before(3 * DAY)) });
}

async function scenario(mutate: () => Promise<void>): Promise<string> {
  await w.baseline(NOW);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query(
    `DELETE FROM settings WHERE key IN ('engine.typesafe_model', 'engine.model_pin', 'engine.model_resolution', 'engine.model_watch', 'engine.model_candidate')`,
  );
  await mutate();
  const mailer = new RecordingMailer();
  await w.run(NOW, { mailer });
  expect(mailer.to(ADMIN)).toHaveLength(1);
  return mailer.sent.map((message) => `${message.subject}\n${message.text}`).join('\n----\n');
}

const THREE = [
  'Configured model: jev-latest.',
  'Resolved model: jev-1.14.0.',
  'Pinned model: jev-1.13.0.',
];

function expectInOrder(text: string, pieces: string[], from = 0): void {
  let cursor = from;
  for (const piece of pieces) {
    const at = text.indexOf(piece, cursor);
    expect(at, `${piece} in order in:\n${text}`).toBeGreaterThanOrEqual(0);
    cursor = at + piece.length;
  }
}

const failures = async (): Promise<void> => {
  for (let i = 1; i <= 3; i += 1)
    await engineCall(before(i * MINUTE), { status: 'timeout', error: 'timeout' });
};

describe('house.alerts name the resolved Jev model', () => {
  it('a: the open breaker names configured, resolved and pinned model in order', async () => {
    const text = await scenario(async () => {
      await aliasWorld();
      await openBreaker();
    });
    expect(text).toContain('Classification engine failing');
    expectInOrder(text, THREE);
  });

  it('b: an outage without a breaker names the same three models', async () => {
    const text = await scenario(async () => {
      await aliasWorld();
      await failures();
    });
    expect(text).toContain('No TypeSafe classification call succeeded');
    expectInOrder(text, THREE);
  });

  it('c: the mismatch alert names the three models after the requested/answered sentence', async () => {
    const text = await scenario(async () => {
      await aliasWorld();
      await engineCall(before(5 * MINUTE));
    });
    expect(text).toContain('Jev answered with another model');
    const sentence = text.indexOf('requested jev-latest, answered jev-1.13.0');
    expect(sentence).toBeGreaterThanOrEqual(0);
    expectInOrder(text, THREE, sentence);
  });

  it('d: NEG a concrete configured model hides a leftover resolution row', async () => {
    const text = await scenario(async () => {
      await w.setting('engine.typesafe_model', 'jev-1.13.0');
      await w.setting('engine.model_resolution', resolution());
      await openBreaker();
    });
    expect(text).toContain('Configured model: jev-1.13.0.');
    expect(text).not.toContain('Resolved model');
  });

  it('d: NEG the alias without a resolution row shows no resolved model', async () => {
    const text = await scenario(async () => {
      await w.setting('engine.typesafe_model', 'jev-latest');
      await openBreaker();
    });
    expect(text).toContain('Configured model: jev-latest.');
    expect(text).not.toContain('Resolved model');
  });

  it('e: a failed newest model check is named in the breaker text', async () => {
    const at = iso(before(20 * MINUTE));
    const text = await scenario(async () => {
      await aliasWorld();
      await w.setting('engine.model_watch', {
        lastCheck: { at, ok: false, error: 'provider_unavailable' },
      });
      await openBreaker();
    });
    expect(text).toContain(`Last model check failed: provider_unavailable at ${at}.`);
  });

  it('e: NEG a successful newest model check is not mentioned', async () => {
    const text = await scenario(async () => {
      await aliasWorld();
      await w.setting('engine.model_watch', {
        lastCheck: { at: iso(before(20 * MINUTE)), ok: true },
      });
      await openBreaker();
    });
    expect(text).not.toContain('Last model check failed');
  });
});
