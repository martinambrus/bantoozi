import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, loadConfig } from '../src/server/index.js';

/** Spec 11 §7 "Logs": SMTP and database URLs are redacted centrally. */

const CREDENTIAL_URL = 'postgres://bantoozi_app:hunter2-secret@db.internal:5432/bantoozi';
const SMTP = 'smtp://mailer:smtp-pass-secret@mail.example.com:587';

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({
    destination: new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  });
  return { lines, logger };
}

describe('URL-with-credentials redaction', () => {
  const keys = [
    'smtpUrl',
    'databaseUrl',
    'databaseUrlWorker',
    'databaseUrlMigrate',
    'testAdminDatabaseUrl',
    'DATABASE_URL',
    'DATABASE_URL_WORKER',
    'DATABASE_URL_MIGRATE',
    'TEST_ADMIN_DATABASE_URL',
    'SMTP_URL',
  ];

  it.each(keys)('redacts %s at the top level and one level deep', (key) => {
    const { lines, logger } = capture();
    logger.info({ [key]: CREDENTIAL_URL, nested: { [key]: SMTP } }, 'x');
    const out = lines.join('');
    expect(out).not.toContain('hunter2-secret');
    expect(out).not.toContain('smtp-pass-secret');
    expect(out).toContain('[redacted]');
  });

  it('does not emit credentials when the config object is logged', () => {
    const config = loadConfig({
      process: 'api',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: CREDENTIAL_URL,
        SESSION_PEPPER: 'unit-pepper-0123456789abcdef0123456789abcdef',
        SMTP_URL: SMTP,
      },
    });
    const { lines, logger } = capture();
    logger.info({ config }, 'config');
    logger.info(config, 'config top level');
    const out = lines.join('');
    expect(out).not.toContain('hunter2-secret');
    expect(out).not.toContain('smtp-pass-secret');
  });
});
