import { startFakeTypeSafe } from '@bantoozi/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { request, setup, JEV_KEY } from './support/router-fixtures.js';

/**
 * JEV-2 ruler (contract point 5): an alias as `typesafe.model` builds no Jev lane. The router
 * answers `no_key` / `typesafe:not_configured` with no HTTP request and no engine_calls row, logs
 * one warning, and reports `typesafeLane: 'unconfigured'` in its status. A concrete model on the
 * same fake is the control.
 */

beforeEach(() => {
  // Real HTTP to the loopback fake server: real timers.
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EngineRouter: typesafe.model is the alias jev-latest', () => {
  it('R1 non-production: ask is no_key, the fake sees nothing, no call row, one warning', async () => {
    const fake = await startFakeTypeSafe({ apiKey: JEV_KEY.apiKey });
    try {
      const { router, store, logger } = setup({
        typesafe: null,
        config: {
          typesafe: { baseUrl: fake.url, model: 'jev-latest', pricePerMTokUsd: 0.042 },
        },
      });
      const outcome = await router.ask(request());
      expect(outcome).toMatchObject({ ok: false, reason: 'no_key' });
      expect(outcome.ok ? '' : outcome.detail).toContain('typesafe:not_configured');
      expect(fake.requestCount()).toBe(0);
      expect(store.calls).toHaveLength(0);
      expect(store.reservations).toHaveLength(0);
      expect(logger.entries.filter((e) => e.level === 'warn')).not.toHaveLength(0);
      // a second ask changes nothing
      await router.ask(request());
      expect(fake.requestCount()).toBe(0);
      expect(store.calls).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('R1 production (https base url): the same answer, no row, a warning and no error log', async () => {
    const { router, store, logger } = setup({
      typesafe: null,
      config: {
        production: true,
        typesafe: {
          baseUrl: 'https://api.typesafe.example',
          model: 'jev-latest',
          pricePerMTokUsd: 0.042,
        },
      },
    });
    const outcome = await router.ask(request());
    expect(outcome).toMatchObject({ ok: false, reason: 'no_key' });
    expect(outcome.ok ? '' : outcome.detail).toContain('typesafe:not_configured');
    expect(store.calls).toHaveLength(0);
    expect(store.reservations).toHaveLength(0);
    expect(logger.entries.filter((e) => e.level === 'warn')).not.toHaveLength(0);
    // an alias is a configuration state, not an adapter failure
    expect(logger.entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('R2 control: a concrete model on the same fake reaches it and the lane is ready', async () => {
    const fake = await startFakeTypeSafe({ apiKey: JEV_KEY.apiKey });
    try {
      const { router, store, logger } = setup({
        typesafe: null,
        config: {
          typesafe: { baseUrl: fake.url, model: 'jev-1.13.0', pricePerMTokUsd: 0.042 },
        },
      });
      await router.ask(request());
      expect(fake.requestCount()).toBeGreaterThanOrEqual(1);
      expect(store.calls.length).toBeGreaterThanOrEqual(1);
      expect((await router.status()).typesafeLane).toBe('ready');
      expect(logger.entries.filter((e) => e.level === 'warn')).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it('R3 status: the alias is unconfigured, a concrete model is ready, an injected engine is ready', async () => {
    const alias = setup({
      typesafe: null,
      config: {
        typesafe: { baseUrl: 'http://127.0.0.1:9', model: 'jev-latest', pricePerMTokUsd: 0.042 },
      },
    });
    expect((await alias.router.status()).typesafeLane).toBe('unconfigured');
    const concrete = setup({
      typesafe: null,
      config: {
        typesafe: { baseUrl: 'http://127.0.0.1:9', model: 'jev-1.13.0', pricePerMTokUsd: 0.042 },
      },
    });
    expect((await concrete.router.status()).typesafeLane).toBe('ready');
    const injected = setup();
    expect((await injected.router.status()).typesafeLane).toBe('ready');
  });
});
