import { describe, expect, it } from 'vitest';

import {
  databaseUrls,
  FEED_KEYS,
  ports as webPorts,
  runId as webRunId,
  URLS,
} from '../../../apps/web/e2e/support/env.js';
import {
  assertE2eDatabaseName,
  e2eDatabaseName,
  E2E_FEED_KEYS,
  e2ePorts,
  isE2eDatabaseName,
  isE2eFeedKey,
  requireRunId,
} from '../src/e2e/env.js';
import { roleUrl, testDbEnv } from '../src/index.js';

describe('e2ePorts', () => {
  it('uses the fixed ports of the environment by default', () => {
    expect(e2ePorts({})).toEqual({
      base: 0,
      preview: 4173,
      api: 3101,
      control: 4600,
      feeds: { tech: 4601, science: 4602, culture: 4603 },
      fake: 4610,
      dead: 4619,
    });
  });

  it('shifts every port by E2E_PORT_BASE, which may be negative', () => {
    const shifted = e2ePorts({ E2E_PORT_BASE: '100' });
    expect(shifted.base).toBe(100);
    expect(shifted.preview).toBe(4273);
    expect(shifted.feeds).toEqual({ tech: 4701, science: 4702, culture: 4703 });
    expect(e2ePorts({ E2E_PORT_BASE: '-101' }).api).toBe(3000);
    expect(e2ePorts({ E2E_PORT_BASE: ' 7 ' }).control).toBe(4607);
  });

  it('treats an empty or blank base as 0', () => {
    expect(e2ePorts({ E2E_PORT_BASE: '' }).base).toBe(0);
    expect(e2ePorts({ E2E_PORT_BASE: '  ' }).preview).toBe(4173);
  });

  it('gives every service its own port', () => {
    const { base: _base, feeds, ...rest } = e2ePorts({});
    const all = [...Object.values(rest), ...Object.values(feeds)];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(['abc', '1.5', '1e3', '+5', '12x', '0x10'])('rejects the base %j', (base) => {
    expect(() => e2ePorts({ E2E_PORT_BASE: base })).toThrow(/E2E_PORT_BASE must be an integer/);
  });

  it.each(['-3000', '-4000', '61000', '70000'])(
    'rejects the base %s, which moves a port out of range',
    (base) => {
      expect(() => e2ePorts({ E2E_PORT_BASE: base })).toThrow(/outside 1024-65535/);
    },
  );
});

describe('requireRunId', () => {
  it('accepts eight lower-case hex digits', () => {
    expect(requireRunId({ E2E_RUN_ID: '0123abcd' })).toBe('0123abcd');
    expect(requireRunId({ E2E_RUN_ID: 'ffffffff' })).toBe('ffffffff');
  });

  it.each([
    undefined,
    '',
    '0123abc',
    '0123abcde',
    '0123ABCD',
    '0123abcg',
    ' 0123abcd',
    '0123abcd\n',
  ])('rejects %j', (value) => {
    expect(() => requireRunId(value === undefined ? {} : { E2E_RUN_ID: value })).toThrow(
      /E2E_RUN_ID must be 8 lower-case hex digits/,
    );
  });
});

describe('the database name guard', () => {
  it.each(['bantoozi_e2e_0123abcd', 'bantoozi_e2e_ffffffff', 'bantoozi_e2e_00000000'])(
    'accepts %s',
    (name) => {
      expect(isE2eDatabaseName(name)).toBe(true);
      expect(assertE2eDatabaseName(name)).toBe(name);
    },
  );

  it.each([
    '',
    'postgres',
    'template1',
    'bantoozi_template_e434e568094e',
    'bantoozi_test_ab12cd34_db_x',
    'bantoozi_eval_dryrun',
    'bantoozi_e2e_',
    'bantoozi_e2e_0123ABCD',
    'bantoozi_e2e_0123abc',
    'bantoozi_e2e_0123abcde',
    'bantoozi_e2e_0123abcd_x',
    'xbantoozi_e2e_0123abcd',
    'bantoozi_e2e_0123abcd\n',
    'bantoozi_e2e_0123abcd; DROP DATABASE postgres',
    'bantoozi_e2e_0123abcd" ; DROP DATABASE postgres; --',
    'BANTOOZI_E2E_0123ABCD',
  ])('refuses %j', (name) => {
    expect(isE2eDatabaseName(name)).toBe(false);
    expect(() => assertE2eDatabaseName(name)).toThrow(/refusing to touch database/);
  });

  it('names the run database after its id', () => {
    expect(e2eDatabaseName('0123abcd')).toBe('bantoozi_e2e_0123abcd');
    expect(() => e2eDatabaseName('xyz')).toThrow(/8 lower-case hex digits/);
    expect(isE2eDatabaseName(e2eDatabaseName('89abcdef'))).toBe(true);
  });
});

describe('feed keys', () => {
  it('are tech, science and culture', () => {
    expect(E2E_FEED_KEYS).toEqual(['tech', 'science', 'culture']);
    expect(['tech', 'science', 'culture'].every(isE2eFeedKey)).toBe(true);
  });

  it.each(['Tech', '', 'news', 'constructor', '__proto__', undefined, 3])('rejects %j', (value) => {
    expect(isE2eFeedKey(value)).toBe(false);
  });
});

describe('apps/web/e2e/support/env.ts, the copy Playwright specs use', () => {
  it('has the feed keys of the testing package', () => {
    expect([...FEED_KEYS]).toEqual([...E2E_FEED_KEYS]);
  });

  it('computes the same ports, or fails for the same bases', () => {
    for (const base of [undefined, '', '0', '100', '-101', '2000', ' 7 ']) {
      const env = base === undefined ? {} : { E2E_PORT_BASE: base };
      expect(webPorts(env)).toEqual(e2ePorts(env));
    }
    for (const base of ['abc', '1.5', '-3000', '61000']) {
      expect(() => webPorts({ E2E_PORT_BASE: base })).toThrow();
      expect(() => e2ePorts({ E2E_PORT_BASE: base })).toThrow();
    }
  });

  it('spells the URLs from the ports of the current environment', () => {
    const ports = e2ePorts();
    expect(URLS.app).toBe(`http://localhost:${ports.preview}`);
    expect(URLS.api).toBe(`http://127.0.0.1:${ports.api}`);
    expect(URLS.control).toBe(`http://127.0.0.1:${ports.control}`);
    expect(URLS.fake).toBe(`http://127.0.0.1:${ports.fake}`);
    expect(URLS.dead).toBe(`http://127.0.0.1:${ports.dead}`);
    expect(URLS.feedOrigins.science).toBe(`http://127.0.0.1:${ports.feeds.science}`);
  });

  it('validates the run id like the testing package', () => {
    for (const id of ['0123abcd', '0123ABCD', '0123abc', '']) {
      const env = { E2E_RUN_ID: id };
      let expected: string | Error;
      try {
        expected = requireRunId(env);
      } catch (error) {
        expected = error as Error;
      }
      if (expected instanceof Error) expect(() => webRunId(env)).toThrow(expected.message);
      else expect(webRunId(env)).toBe(expected);
    }
  });

  it('builds the role URLs of testDbEnv()/roleUrl() for the run database', () => {
    const environments: Array<Record<string, string>> = [
      {},
      { PG_TEST_PORT: '5544' },
      { TEST_ADMIN_DATABASE_URL: 'postgres://admin:secret@db.example:6000/postgres' },
      {
        PG_TEST_PORT: '5434',
        BANTOOZI_APP_PASSWORD: 'p@ss/word',
        BANTOOZI_WORKER_PASSWORD: 'w:orker',
      },
    ];
    const name = e2eDatabaseName('0123abcd');
    for (const env of environments) {
      const testing = testDbEnv(env);
      expect(databaseUrls('0123abcd', env)).toEqual({
        app: roleUrl(testing, 'bantoozi_app', name),
        worker: roleUrl(testing, 'bantoozi_worker', name),
      });
    }
  });
});
