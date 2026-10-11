import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOAD_FEED_COUNT, LOAD_POOL, loadFeedUrl, userFeedIndexes } from '../src/load/config.js';
import { loadEnvFile, parseBytes, parseStats } from '../src/load/docker.js';
import {
  PHASE_NAMES,
  buildPhaseReport,
  buildReport,
  hostCpuSeries,
  percentile,
  planPhases,
  raiseMax,
  renderMarkdown,
  type PhaseMeasure,
} from '../src/load/plan.js';
import { userCardIndexes } from '../src/load/seed.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(path.join(repo, file), 'utf8');

describe('planPhases', () => {
  it('splits the duration over the four phases in order and adds up exactly', () => {
    for (const minutes of [2, 6, 7.5, 60]) {
      const plan = planPhases(minutes);
      expect(plan.map((phase) => phase.name)).toEqual([...PHASE_NAMES]);
      expect(plan.reduce((sum, phase) => sum + phase.durationSec, 0)).toBe(
        Math.round(minutes * 60),
      );
      expect(plan.every((phase) => phase.durationSec >= 20)).toBe(true);
    }
    expect(planPhases(6).map((phase) => phase.durationSec)).toEqual([72, 108, 108, 72]);
    expect(planPhases(60).map((phase) => phase.durationSec)).toEqual([720, 1080, 1080, 720]);
  });

  it('rejects durations that cannot hold four phases', () => {
    expect(() => planPhases(1)).toThrow(RangeError);
    expect(() => planPhases(Number.NaN)).toThrow(RangeError);
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

function measure(name: PhaseMeasure['name'], overrides: Partial<PhaseMeasure> = {}): PhaseMeasure {
  return {
    name,
    startedAt: '2026-10-11T10:00:00.000Z',
    endedAt: '2026-10-11T10:01:00.000Z',
    durationSec: 60,
    articleLatenciesMs: Array.from({ length: 100 }, (_, i) => i + 1),
    actionRequests: 500,
    errors5xx: 0,
    non2xx: 3,
    cpuSamples: { api: [100, 200], worker: [50, 150] },
    memMaxBytes: { api: 200e6 },
    queueDepthMax: { 'article.extract': 12 },
    backlogAlert: false,
    backlogConditions: [],
    inferenceCalls: name === 'all-off' ? 0 : 40,
    providerRequests: name === 'all-off' ? 0 : 40,
    distinctQuestionsAdmitted: name === 'all-off' ? 0 : 30,
    servedCombinations: name === 'all-off' ? 0 : 120,
    newArticles: 30,
    ...overrides,
  };
}

const allMeasures = (): PhaseMeasure[] => PHASE_NAMES.map((name) => measure(name));

describe('report builder', () => {
  it('computes percentiles, host-normalised CPU and cache reuse per phase', () => {
    const phase = buildPhaseReport(measure('active-feeds'), 4);
    expect(phase.p50ArticlesMs).toBe(50);
    expect(phase.p95ArticlesMs).toBe(95);
    expect(phase.requests).toBe(100);
    // Samples add up across services (150, 350) and are divided by the 4 cores.
    expect(phase.cpuPctAvg).toBe(62.5);
    expect(phase.cpuPctMax).toBe(87.5);
    expect(phase.cpuPctByService['api']).toEqual({ avg: 150, max: 200 });
    expect(phase.cacheHits).toBe(90);
    expect(phase.cacheReuseRatio).toBe(0.75);
    expect(phase.arrivalsPerHour).toBe(1800);
    expect(buildPhaseReport(measure('all-off'), 4).cacheReuseRatio).toBe(0);
  });

  it('never reports negative cache hits', () => {
    const phase = buildPhaseReport(measure('active-feeds', { servedCombinations: 5 }), 2);
    expect(phase.cacheHits).toBe(0);
  });

  it('echoes the fixed configuration and the criteria', () => {
    const report = buildReport({
      host: { cpus: 8, memTotal: 16e9 },
      durationMin: 6,
      articles: 4000,
      traffic: { listRatePerUser: 3, actionRatePerUser: 2, listPageLimit: 30 },
      measures: allMeasures(),
      generatedAt: '2026-10-11T10:05:00.000Z',
    });
    expect(report).toMatchObject({
      users: 20,
      feedsPerUser: 50,
      cardsPerUser: 10,
      durationMin: 6,
      articles: 4000,
      questionsPerArticle: 10,
      config: { feedCount: 1000, itemsPerFeedPerHour: 5, providerLatencyMs: 300 },
      pool: LOAD_POOL,
      criteria: {
        p95Ok: true,
        backlogOk: true,
        allOffZeroInference: true,
        degradedReadingOk: true,
        cpuGated: false,
      },
    });
    expect(report.phases.map((phase) => phase.name)).toEqual([...PHASE_NAMES]);
  });

  it('fails the criteria that were missed', () => {
    const slow = measure('selected-training-slow', { articleLatenciesMs: [100, 450, 500] });
    const alert = measure('active-feeds', { backlogAlert: true });
    const chatty = measure('all-off', { inferenceCalls: 3, providerRequests: 3 });
    const broken = measure('provider-failing', { errors5xx: 2 });
    const report = buildReport({
      host: { cpus: 8, memTotal: 16e9 },
      durationMin: 6,
      articles: 10,
      traffic: { listRatePerUser: 3, actionRatePerUser: 2, listPageLimit: 30 },
      measures: [chatty, slow, alert, broken],
      generatedAt: 'x',
    });
    expect(report.criteria).toEqual({
      p95Ok: false,
      backlogOk: false,
      allOffZeroInference: false,
      degradedReadingOk: false,
      cpuGated: false,
    });
  });

  it('is not p95-ok when a phase is missing', () => {
    const report = buildReport({
      host: { cpus: 2, memTotal: 1 },
      durationMin: 2,
      articles: 0,
      traffic: { listRatePerUser: 1, actionRatePerUser: 1, listPageLimit: 1 },
      measures: [measure('all-off')],
      generatedAt: 'x',
    });
    expect(report.criteria.p95Ok).toBe(false);
  });

  it('renders a LOCAL note, the table and every phase', () => {
    const report = buildReport({
      host: { cpus: 8, memTotal: 16e9 },
      durationMin: 6,
      articles: 4000,
      traffic: { listRatePerUser: 3, actionRatePerUser: 2, listPageLimit: 30 },
      measures: allMeasures(),
      generatedAt: 'x',
    });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('LOCAL');
    expect(markdown).toContain('reported, not gated');
    for (const name of PHASE_NAMES) expect(markdown).toContain(`| ${name} |`);
    expect(markdown).toContain('p95 ms');
  });

  it('keeps helper maths right', () => {
    expect(hostCpuSeries({ a: [10, 20], b: [30] }, 2)).toEqual([20, 10]);
    const map: Record<string, number> = {};
    raiseMax(map, 'q', 3);
    raiseMax(map, 'q', 2);
    raiseMax(map, 'q', 9);
    expect(map).toEqual({ q: 9 });
  });
});

describe('docker helpers', () => {
  it('parses byte sizes in docker units', () => {
    expect(parseBytes('1MiB')).toBe(1024 ** 2);
    expect(parseBytes('1.5GiB / 6GiB')).toBe(1.5 * 1024 ** 3);
    expect(parseBytes('512kB')).toBe(512_000);
    expect(parseBytes('0B')).toBe(0);
    expect(parseBytes('n/a')).toBeNaN();
  });

  it('maps docker stats rows to services', () => {
    const output = [
      JSON.stringify({ ID: 'aaaabbbbcccc', CPUPerc: '12.50%', MemUsage: '100MiB / 768MiB' }),
      JSON.stringify({ ID: 'ddddeeeeffff', CPUPerc: '0.00%', MemUsage: '1GiB / 6GiB' }),
      'not json',
      JSON.stringify({ ID: '999999999999', CPUPerc: '1%', MemUsage: '1MiB' }),
    ].join('\n');
    const samples = parseStats(output, { api: 'aaaabbbbccccdddd', postgres: 'ddddeeeeffffgggg' });
    expect(samples).toEqual({
      api: { cpuPct: 12.5, memBytes: 100 * 1024 ** 2 },
      postgres: { cpuPct: 0, memBytes: 1024 ** 3 },
    });
  });

  it('generates distinct throwaway secrets for every run', () => {
    const a = loadEnvFile();
    const b = loadEnvFile();
    expect(a).not.toBe(b);
    const values = a
      .split('\n')
      .filter((line) => /PASSWORD=/u.test(line))
      .map((line) => line.split('=')[1]);
    expect(new Set(values).size).toBe(4);
    expect(a).toContain('PUBLIC_BASE_URL=http://127.0.0.1:18281');
  });
});

describe('simulated users', () => {
  it('give each user 50 feeds, overlapping with the neighbour and covering a shared set', () => {
    const covered = new Set<number>();
    for (let user = 0; user < 20; user += 1) {
      const feeds = userFeedIndexes(user);
      expect(new Set(feeds).size).toBe(50);
      expect(feeds.every((feed) => feed >= 0 && feed < LOAD_FEED_COUNT)).toBe(true);
      for (const feed of feeds) covered.add(feed);
    }
    expect(covered.size).toBe(620);
    const shared = userFeedIndexes(1).filter((feed) => userFeedIndexes(0).includes(feed));
    expect(shared).toHaveLength(20);
  });

  it('points feeds at the load-sim origins and gives 10 distinct overlapping cards', () => {
    expect(loadFeedUrl(0)).toBe('http://load-sim:8100/feed/0.xml');
    expect(loadFeedUrl(123)).toBe('http://load-sim:8123/feed/123.xml');
    expect(loadFeedUrl(999)).toBe('http://load-sim:8149/feed/999.xml');
    const mine = userCardIndexes(3, 166);
    expect(new Set(mine).size).toBe(10);
    expect(userCardIndexes(4, 166).filter((c) => mine.includes(c))).toHaveLength(6);
  });
});

describe('what the report claims about the stack', () => {
  it('uses the pool limits of the worker and the API', () => {
    const worker = read('apps/worker/src/health-server.ts');
    expect(worker).toContain(
      `WORKER_POOL_LIMITS = { query: ${LOAD_POOL.workerQuery}, feedLocks: ${LOAD_POOL.workerFeedLocks} }`,
    );
    const api = /createPool\(\{[^}]*max: (\d+)/u.exec(read('apps/api/src/main.ts'));
    expect(Number(api?.[1])).toBe(LOAD_POOL.apiMax);
  });

  it('relaxes the test settings only in the override, never in the production files', () => {
    const override = read('infra/load/compose.override.yml');
    for (const setting of [
      'NODE_ENV: test',
      "RATE_LIMITS_ENABLED: 'false'",
      "FETCH_ALLOW_PRIVATE: 'true'",
      "SIM_PROVIDER_LATENCY_MS: '300'",
      '127.0.0.1:18281:3000',
      '127.0.0.1:18644:8083',
    ]) {
      expect(override).toContain(setting);
    }
    // Only the added load-sim service sets a memory limit: the production budgets are untouched.
    expect(override.match(/mem_limit/gu)).toHaveLength(1);
    for (const file of ['infra/compose.yml', 'infra/env/prod.example.env']) {
      const text = read(file);
      expect(text).not.toContain('RATE_LIMITS_ENABLED');
      expect(text).not.toMatch(/FETCH_ALLOW_PRIVATE:\s*'?true/u);
      expect(text).not.toMatch(/NODE_ENV:\s*test/u);
      expect(text).not.toContain('load-sim');
    }
  });
});
