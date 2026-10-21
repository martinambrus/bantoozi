import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fingerprintCounters, guardedRegistration } from '../src/learn/fingerprints.js';

async function load() {
  return { fingerprintCounters, guardedRegistration };
}

beforeEach(() => {
  fingerprintCounters.evicted = 0;
  fingerprintCounters.failed = 0;
});

describe('guardedRegistration', () => {
  it('counts evicted entries and warns once', async () => {
    const { guardedRegistration, fingerprintCounters } = await load();
    const warn = vi.fn();
    const result = await guardedRegistration(async () => ({ registered: true, evicted: 2 }), {
      warn,
    });
    expect(result).toEqual({ registered: true, evicted: 2 });
    expect(fingerprintCounters).toEqual({ evicted: 2, failed: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { evicted: 2 },
      'rating fingerprint registry evicted entries',
    );
  });

  it('changes nothing and stays silent without evictions', async () => {
    const { guardedRegistration, fingerprintCounters } = await load();
    const warn = vi.fn();
    await guardedRegistration(async () => ({ registered: true, evicted: 0 }), { warn });
    expect(fingerprintCounters).toEqual({ evicted: 0, failed: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts a failure, warns and returns null', async () => {
    const { guardedRegistration, fingerprintCounters } = await load();
    const warn = vi.fn();
    const err = new Error('boom');
    const result = await guardedRegistration(async () => Promise.reject(err), { warn });
    expect(result).toBeNull();
    expect(fingerprintCounters).toEqual({ evicted: 0, failed: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ err }, 'rating fingerprint registration failed');
  });

  it('rethrows the same error after counting when asked', async () => {
    const { guardedRegistration, fingerprintCounters } = await load();
    const warn = vi.fn();
    const err = new Error('boom');
    await expect(
      guardedRegistration(async () => Promise.reject(err), { warn }, { rethrow: true }),
    ).rejects.toBe(err);
    expect(fingerprintCounters.failed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
