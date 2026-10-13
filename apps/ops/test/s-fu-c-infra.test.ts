import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nextSchedule, type ScheduleFeed } from '@bantoozi/feeds';

import { PHASE_NAMES, buildReport, renderMarkdown, type PhaseMeasure } from '../src/load/plan.js';

/**
 * Lane C ruler (M8-F7, F8, F9, F13, F17). Static/unit checks only; the stack drill is
 * ~/.cache/bantoozi-m8/FU/C/drill-f7-f13.sh. Each test must fail until the follow-up is done.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(repo, file), 'utf8');
const lineOf = (text: string, re: RegExp): number => {
  const i = text.split('\n').findIndex((l) => re.test(l));
  return i < 0 ? Number.POSITIVE_INFINITY : i;
};

describe('F7: the http to https redirect keeps a non-default https port', () => {
  const caddyfile = read('infra/caddy/Caddyfile');
  const code = caddyfile
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  it('has an explicit http redirect carrying the published https port', () => {
    // Rule: an http:// site (or the global https_port option) whose redirect target embeds the
    // externally published port {$HTTPS_PORT}; Caddy's automatic redirect only knows the inner 443.
    expect(code).toMatch(/\{\$HTTPS_PORT/u);
    expect(code).toMatch(/\bredir\b/u);
  });
  it('hands HTTPS_PORT to the caddy container', () => {
    const compose = read('infra/compose.yml');
    const caddy = /\n {2}caddy:[\s\S]*?\n {2}[a-z][\w-]*:\n/u.exec(compose)?.[0] ?? '';
    const env = /environment:\n([\s\S]*?)\n {4}[a-z]+:/u.exec(caddy)?.[1] ?? '';
    expect(env).toMatch(/HTTPS_PORT:/u);
  });
});

describe('F8: deploy.sh pre-builds the backup-tools image before the pre-deploy backup', () => {
  const deploy = read('infra/scripts/deploy.sh');
  it('builds backup-tools ahead of the backup.sh call', () => {
    const build = lineOf(deploy, /build[^\n]*backup-tools/u);
    const backup = lineOf(deploy, /"\$BACKUP" --pre-deploy/u);
    expect(build).toBeLessThan(backup);
  });
  it('builds it with the tools profile (as ensure_tools_image does)', () => {
    expect(deploy).toMatch(
      /--profile tools[^\n]*build[^\n]*backup-tools|build[^\n]*--profile tools[^\n]*backup-tools/u,
    );
  });
});

describe('F9: backup_ok / restore_ok are retried, then the script exits non-zero', () => {
  const lib = read('infra/scripts/ops-lib.sh');
  const scripts = {
    backup: read('infra/scripts/backup.sh'),
    restore: read('infra/scripts/restore-test.sh'),
  };
  it('has a bounded retry helper around post_event', () => {
    // Rule: a function (e.g. post_event_retry) in ops-lib.sh loops a bounded number of times
    // (for/while with a numeric bound or an attempts variable) calling post_event.
    const m = /post_event_retry\(\)\s*\{[\s\S]*?\n\}/u.exec(lib)?.[0] ?? '';
    expect(m).toMatch(/post_event\b/u);
    expect(m).toMatch(/for\b[^\n]*(seq|\{1\.\.|in [0-9])|while\b[^\n]*(-lt|-le|<)|attempt/iu);
    expect(m).toMatch(/sleep/u);
  });
  it.each([
    ['backup', 'backup_ok'],
    ['restore', 'restore_ok'],
  ] as const)('%s.sh uses the retry and fails when the event is not posted', (which, kind) => {
    const text = scripts[which];
    const idx = text.search(new RegExp(`post_event_retry ${kind}`, 'u'));
    expect(idx).toBeGreaterThan(-1);
    const after = text.slice(idx, idx + 700);
    expect(after).toMatch(/exit [1-9]/u);
    expect(after).not.toMatch(/warning:[^\n]*could not be recorded[^\n]*\n(?![\s\S]*exit [1-9])/u);
  });
});

describe('F13: the rehearsal MinIO is ready before the bucket is created and before backup.sh', () => {
  const deploy = read('infra/scripts/deploy.sh');
  const compose = read('infra/compose.yml');
  const minio =
    /\n {2}minio:[\s\S]*?\n {2}[a-z][\w-]*:\n|\n {2}minio:[\s\S]*?\nvolumes:/u.exec(compose)?.[0] ??
    '';
  it('the minio service has a healthcheck', () => {
    expect(minio).toMatch(/healthcheck:/u);
  });
  it('deploy.sh waits for minio health instead of sleeping', () => {
    expect(deploy).toMatch(/up -d[^\n]*--wait[^\n]*minio|up -d[^\n]*minio[^\n]*--wait/u);
    expect(deploy).not.toMatch(/minio >\/dev\/null[^\n]*\n\s*sleep 2/u);
  });
  it('creates the bucket on every rehearsal deploy, also a fresh one, not only before a pre-deploy backup', () => {
    // The start of minio in the "replace application containers" step is the last one before a
    // drill runs backup.sh; the bucket must exist after it in rehearsal mode.
    const replace = lineOf(deploy, /step "replace application containers"/u);
    const lines = deploy.split('\n');
    const mk = lines.findIndex(
      (l, i) => i > replace && /mkdir -p "\/data\/\$\(envfile_get BACKUP_S3_BUCKET\)"/u.test(l),
    );
    expect(mk).toBeGreaterThan(replace);
  });
});

describe('F17: load realism', () => {
  /** Stored interval nextSchedule converges to for a feed that steadily yields `perHour` items/h. */
  const convergedIntervalS = (perHour: number): number => {
    const gapS = 3600 / perHour;
    let now = new Date('2026-10-01T00:00:00Z');
    const created = now;
    let feed: ScheduleFeed = {
      id: '17',
      createdAt: created,
      status: 'active',
      fetchIntervalS: 900,
      minIntervalS: 900,
      consecutiveErrors: 0,
      consecutiveEmpty: 0,
      quarantineCount: 0,
      totalFetches: 0,
      totalErrors: 0,
      totalEmpty: 0,
      lastNewItemAt: null,
      firstErrorAt: null,
      quarantinedUntil: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastError: null,
      lastErrorAt: null,
      etag: null,
      lastModified: null,
      recentGapsS: Array.from({ length: 20 }, () => gapS),
    };
    let seen = 0;
    const tail: number[] = [];
    for (let i = 0; i < 600; i += 1) {
      const published = Math.floor((now.getTime() - created.getTime()) / 1000 / gapS);
      const nNew = published - seen;
      seen = published;
      const out = nextSchedule(
        feed,
        nNew > 0
          ? { kind: 'success', nNew, etag: null, lastModified: null }
          : { kind: 'not_modified' },
        now,
      );
      feed = { ...feed, ...out, minIntervalS: feed.minIntervalS };
      if (i >= 500) tail.push(out.fetchIntervalS);
      now = out.nextFetchAt;
    }
    return Math.max(...tail);
  };

  it('feed window covers the items published between two polls at the converged interval (2x margin)', () => {
    const override = read('infra/load/compose.override.yml');
    const perHour = Number(/SIM_ITEMS_PER_FEED_PER_HOUR: '(\d+)'/u.exec(override)?.[1]);
    const intervalS = convergedIntervalS(perHour);
    const needed = Math.ceil((perHour * intervalS) / 3600) * 2;
    console.info(`F17 converged interval I=${intervalS}s, bound=${needed}`);
    const windows = [
      Number(/SIM_FEED_WINDOW: '(\d+)'/u.exec(override)?.[1]),
      Number(/num\('SIM_FEED_WINDOW', (\d+)\)/u.exec(read('apps/ops/src/load/sim-main.ts'))?.[1]),
      Number(/options\.window \?\? (\d+)/u.exec(read('packages/testing/src/load-feeds.ts'))?.[1]),
    ];
    for (const w of windows)
      expect(w, `I=${intervalS}s bound=${needed}`).toBeGreaterThanOrEqual(needed);
    expect(new Set(windows).size).toBe(1); // all three places agree
  });

  const measure = (name: PhaseMeasure['name']): PhaseMeasure => ({
    name,
    startedAt: '2026-10-11T10:00:00.000Z',
    endedAt: '2026-10-11T10:01:00.000Z',
    durationSec: 60,
    articleLatenciesMs: [10],
    actionRequests: 5,
    countsRequests: 0,
    errors5xx: 0,
    non2xx: 0,
    cpuSamples: { api: [100] },
    memMaxBytes: { api: 200e6 },
    queueDepthMax: {},
    backlogAlert: false,
    backlogConditions: [],
    inferenceCalls: 0,
    providerRequests: 0,
    distinctQuestionsAdmitted: 0,
    servedCombinations: 0,
    newArticles: 1,
  });
  it('the report records container restarts and renders them', () => {
    const input = {
      host: { cpus: 8, memTotal: 16e9 },
      durationMin: 6,
      articles: 10,
      profile: 'realistic',
      traffic: { listRatePerUser: 3, actionRatePerUser: 2, listPageLimit: 30 },
      measures: PHASE_NAMES.map(measure),
      generatedAt: 'x',
      restarts: [{ service: 'api', count: 1 }],
    };
    const report = buildReport(input as never) as unknown as { restarts?: unknown };
    expect(report.restarts).toEqual([{ service: 'api', count: 1 }]);
    const md = renderMarkdown(report as never);
    expect(md).toMatch(/restart/iu);
    expect(md).toMatch(/api/u);
  });
  it('the load run reads RestartCount from docker', () => {
    expect(read('apps/ops/src/load/docker.ts') + read('apps/ops/src/load/run.ts')).toMatch(
      /RestartCount/u,
    );
  });
});
