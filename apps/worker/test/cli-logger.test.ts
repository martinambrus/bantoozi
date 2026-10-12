import { describe, expect, it } from 'vitest';

import { createCliLogger, prettyLogsAvailable } from '../src/cli-logger.js';

const found = (): string => '/somewhere/pino-pretty/index.js';
const missing = (): string => {
  throw new Error("Cannot find module 'pino-pretty'");
};

describe('CLI logging in the production image', () => {
  it('is JSON in production even when pino-pretty could be resolved', () => {
    expect(prettyLogsAvailable({ NODE_ENV: 'production' }, found)).toBe(false);
  });

  it('is JSON whenever pino-pretty cannot be resolved (production dependencies only)', () => {
    expect(prettyLogsAvailable({ NODE_ENV: 'development' }, missing)).toBe(false);
    expect(prettyLogsAvailable({}, missing)).toBe(false);
  });

  it('is human-readable in development when pino-pretty resolves', () => {
    expect(prettyLogsAvailable({ NODE_ENV: 'development' }, found)).toBe(true);
    expect(prettyLogsAvailable({}, found)).toBe(true);
  });

  it('creates a logger without starting the pretty transport when it is not available', () => {
    const logger = createCliLogger(false);
    expect(typeof logger.warn).toBe('function');
    expect(() => logger.warn({ ok: true }, 'no transport needed')).not.toThrow();
  });

  it('resolves pino-pretty in this development checkout', () => {
    expect(prettyLogsAvailable({ NODE_ENV: 'test' })).toBe(true);
  });
});
