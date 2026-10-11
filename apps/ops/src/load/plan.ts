import {
  LOAD_CARDS_PER_USER,
  LOAD_FEED_COUNT,
  LOAD_FEEDS_PER_USER,
  LOAD_ITEMS_PER_FEED_PER_HOUR,
  LOAD_POOL,
  LOAD_PROVIDER_LATENCY_MS,
  LOAD_USERS,
} from './config.js';
import type { LoadProfile } from './profile.js';

/** Phase plan, percentiles and the report of the load sanity test (spec 11 §9, M8-T8). */

export const PHASE_NAMES = [
  'all-off',
  'selected-training-slow',
  'active-feeds',
  'provider-failing',
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

/** Share of the requested duration each phase gets; they add up to 1. */
export const PHASE_SHARES: Readonly<Record<PhaseName, number>> = {
  'all-off': 0.2,
  'selected-training-slow': 0.3,
  'active-feeds': 0.3,
  'provider-failing': 0.2,
};

export interface PlannedPhase {
  name: PhaseName;
  durationSec: number;
}

/** Splits `durationMin` minutes into the four phases (whole seconds, the last takes the rest). */
export function planPhases(durationMin: number): PlannedPhase[] {
  if (!Number.isFinite(durationMin) || durationMin < 2) {
    throw new RangeError('the load test needs a duration of at least 2 minutes');
  }
  const totalSec = Math.round(durationMin * 60);
  let used = 0;
  return PHASE_NAMES.map((name, index) => {
    const durationSec =
      index === PHASE_NAMES.length - 1
        ? totalSec - used
        : Math.round(totalSec * PHASE_SHARES[name]);
    used += durationSec;
    return { name, durationSec };
  });
}

/** Nearest-rank percentile (`p` in 0..100) of a list; NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (!(p >= 0 && p <= 100)) throw new RangeError('p must be between 0 and 100');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export const round1 = (value: number): number => Math.round(value * 10) / 10;

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Raises `map[key]` to `value` when it is larger. */
export function raiseMax(map: Record<string, number>, key: string, value: number): void {
  if (value > (map[key] ?? Number.NEGATIVE_INFINITY)) map[key] = value;
}

/** What one phase measured. `cpuSamples` are docker's per-core percentages per service. */
export interface PhaseMeasure {
  name: PhaseName;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  /** GET /api/v1/articles round-trip times from autocannon. */
  articleLatenciesMs: number[];
  /** Responses of the open/rate instance (any status). */
  actionRequests: number;
  /** GET /api/v1/articles/counts requests made (never part of the article latency sample). */
  countsRequests: number;
  errors5xx: number;
  non2xx: number;
  /** Docker CPU% samples per service; each sample list is aligned in time. */
  cpuSamples: Record<string, number[]>;
  memMaxBytes: Record<string, number>;
  /** Highest count of created+retry jobs seen per queue. */
  queueDepthMax: Record<string, number>;
  backlogAlert: boolean;
  backlogConditions: string[];
  /** engine_calls rows created in the window (every provider attempt). */
  inferenceCalls: number;
  /** Requests the fake provider received in the window. */
  providerRequests: number;
  /** card_answers rows written in the window: distinct article/card pairs. */
  distinctQuestionsAdmitted: number;
  /** User × article × card combinations that gained an answer in the window (demand served). */
  servedCombinations: number;
  /** Articles the pipeline ingested during the window (the arrival rate the feeds produced). */
  newArticles: number;
}

export interface PhaseReport {
  name: PhaseName;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  requests: number;
  actionRequests: number;
  countsRequests: number;
  p50ArticlesMs: number;
  p95ArticlesMs: number;
  maxArticlesMs: number;
  errors5xx: number;
  non2xx: number;
  /** All services together, in percent of the whole host (100 = every core busy). */
  cpuPctAvg: number;
  cpuPctMax: number;
  /** Per service, in docker's percent of one core. */
  cpuPctByService: Record<string, { avg: number; max: number }>;
  memMaxBytes: Record<string, number>;
  queueDepthMax: Record<string, number>;
  backlogAlert: boolean;
  backlogConditions: string[];
  inferenceCalls: number;
  providerRequests: number;
  distinctQuestionsAdmitted: number;
  servedCombinations: number;
  newArticles: number;
  /** newArticles scaled to one hour. */
  arrivalsPerHour: number;
  /** Combinations answered without a new provider question. */
  cacheHits: number;
  /** cacheHits / servedCombinations (0 when nothing was served). */
  cacheReuseRatio: number;
}

/** Sum across services at each sample index, as percent of `cpus` cores. */
export function hostCpuSeries(samples: Record<string, readonly number[]>, cpus: number): number[] {
  const length = Math.max(0, ...Object.values(samples).map((list) => list.length));
  return Array.from({ length }, (_, i) => {
    let total = 0;
    for (const list of Object.values(samples)) total += list[i] ?? 0;
    return total / cpus;
  });
}

export function buildPhaseReport(measure: PhaseMeasure, cpus: number): PhaseReport {
  const latencies = measure.articleLatenciesMs;
  const host = hostCpuSeries(measure.cpuSamples, cpus);
  const cpuPctByService: PhaseReport['cpuPctByService'] = {};
  for (const [service, list] of Object.entries(measure.cpuSamples)) {
    cpuPctByService[service] = { avg: round1(mean(list)), max: round1(Math.max(0, ...list)) };
  }
  // Each served combination beyond the distinct pairs asked reused an answer already there.
  const cacheHits = Math.max(0, measure.servedCombinations - measure.distinctQuestionsAdmitted);
  return {
    name: measure.name,
    startedAt: measure.startedAt,
    endedAt: measure.endedAt,
    durationSec: measure.durationSec,
    requests: latencies.length,
    actionRequests: measure.actionRequests,
    countsRequests: measure.countsRequests,
    p50ArticlesMs: round1(percentile(latencies, 50)),
    p95ArticlesMs: round1(percentile(latencies, 95)),
    maxArticlesMs: round1(latencies.length === 0 ? Number.NaN : Math.max(...latencies)),
    errors5xx: measure.errors5xx,
    non2xx: measure.non2xx,
    cpuPctAvg: round1(mean(host)),
    cpuPctMax: round1(Math.max(0, ...host)),
    cpuPctByService,
    memMaxBytes: measure.memMaxBytes,
    queueDepthMax: measure.queueDepthMax,
    backlogAlert: measure.backlogAlert,
    backlogConditions: measure.backlogConditions,
    inferenceCalls: measure.inferenceCalls,
    providerRequests: measure.providerRequests,
    distinctQuestionsAdmitted: measure.distinctQuestionsAdmitted,
    servedCombinations: measure.servedCombinations,
    newArticles: measure.newArticles,
    arrivalsPerHour: Math.round((measure.newArticles * 3600) / measure.durationSec),
    cacheHits,
    cacheReuseRatio:
      measure.servedCombinations === 0
        ? 0
        : Math.round((cacheHits / measure.servedCombinations) * 1000) / 1000,
  };
}

export const P95_LIMIT_MS = 300;

export interface LoadReport {
  profile: LoadProfile;
  host: { cpus: number; memTotal: number };
  durationMin: number;
  users: number;
  feedsPerUser: number;
  cardsPerUser: number;
  /** Distinct articles in the database at the end. */
  articles: number;
  /** Cards each user holds: the most questions one article can raise per user. */
  questionsPerArticle: number;
  /** Measured per user and second over all phases: requests / phase seconds / users. */
  listRatePerUser: number;
  countsRatePerUser: number;
  actionRatePerUser: number;
  config: {
    feedCount: number;
    itemsPerFeedPerHour: number;
    providerLatencyMs: number;
    /** Nominal stress rates; the measured rates are at the top level. */
    listRatePerUser: number;
    actionRatePerUser: number;
    listPageLimit: number;
  };
  pool: { workerQuery: number; workerFeedLocks: number; apiMax: number };
  phases: PhaseReport[];
  criteria: {
    /** realistic: the criteria decide the exit code; stress: reported only. */
    gated: boolean;
    p95Ok: boolean;
    backlogOk: boolean;
    allOffZeroInference: boolean;
    degradedReadingOk: boolean;
    cpuGated: false;
  };
  generatedAt: string;
}

export interface ReportInput {
  profile: LoadProfile;
  host: { cpus: number; memTotal: number };
  durationMin: number;
  articles: number;
  traffic: { listRatePerUser: number; actionRatePerUser: number; listPageLimit: number };
  measures: PhaseMeasure[];
  generatedAt: string;
}

export function buildReport(input: ReportInput): LoadReport {
  const phases = input.measures.map((measure) => buildPhaseReport(measure, input.host.cpus));
  const allOff = phases.find((phase) => phase.name === 'all-off');
  const failing = phases.find((phase) => phase.name === 'provider-failing');
  const totalSec = phases.reduce((sum, phase) => sum + phase.durationSec, 0);
  const perUserSec = (count: number): number =>
    totalSec === 0 ? 0 : Math.round((count / totalSec / LOAD_USERS) * 100_000) / 100_000;
  const sum = (pick: (phase: PhaseReport) => number): number =>
    phases.reduce((total, phase) => total + pick(phase), 0);
  return {
    profile: input.profile,
    host: input.host,
    durationMin: input.durationMin,
    users: LOAD_USERS,
    feedsPerUser: LOAD_FEEDS_PER_USER,
    cardsPerUser: LOAD_CARDS_PER_USER,
    articles: input.articles,
    listRatePerUser: perUserSec(sum((phase) => phase.requests)),
    countsRatePerUser: perUserSec(sum((phase) => phase.countsRequests)),
    actionRatePerUser: perUserSec(sum((phase) => phase.actionRequests)),
    questionsPerArticle: LOAD_CARDS_PER_USER,
    config: {
      feedCount: LOAD_FEED_COUNT,
      itemsPerFeedPerHour: LOAD_ITEMS_PER_FEED_PER_HOUR,
      providerLatencyMs: LOAD_PROVIDER_LATENCY_MS,
      ...input.traffic,
    },
    pool: { ...LOAD_POOL },
    phases,
    criteria: {
      gated: input.profile === 'realistic',
      p95Ok:
        phases.length === PHASE_NAMES.length &&
        phases.every((phase) => phase.p95ArticlesMs < P95_LIMIT_MS),
      backlogOk: phases.every((phase) => !phase.backlogAlert),
      allOffZeroInference:
        allOff !== undefined && allOff.inferenceCalls === 0 && allOff.providerRequests === 0,
      degradedReadingOk:
        failing !== undefined && failing.errors5xx === 0 && failing.p95ArticlesMs < P95_LIMIT_MS,
      cpuGated: false,
    },
    generatedAt: input.generatedAt,
  };
}

const MIB = 1024 * 1024;

export function renderMarkdown(report: LoadReport): string {
  const lines: string[] = [];
  lines.push('# Load sanity report (spec 11 §9, M8-T8)', '');
  lines.push(
    `Profile: ${report.profile}` +
      (report.criteria.gated
        ? ' (gated: a failed criterion fails the command).'
        : ' (synthetic stress, 1 list/s and 1 open or rate/s per user; criteria are reported, not gated).'),
    '',
  );
  lines.push(
    '> **LOCAL run on a production-like Compose stack (project `bantoozi-load`), not the target box.** ' +
      'CPU and memory are only reported (spec 11 §9: CPU < 70 % applies on the target box). ' +
      'The gated criteria are p95 `GET /api/v1/articles` < 300 ms and no queue-backlog alert.',
    '',
  );
  lines.push(
    `Host: ${report.host.cpus} CPUs, ${Math.round(report.host.memTotal / MIB / 1024)} GiB. ` +
      `Duration ${report.durationMin} min over four phases; ${report.users} users x ` +
      `${report.feedsPerUser} feeds x ${report.cardsPerUser} cards; ${report.config.feedCount} generated ` +
      `feeds at ${report.config.itemsPerFeedPerHour} items per hour; fake provider ` +
      `${report.config.providerLatencyMs} ms. Pools: worker query ${report.pool.workerQuery}, feed ` +
      `locks ${report.pool.workerFeedLocks}, API ${report.pool.apiMax}. ` +
      `Measured traffic per user: ${report.listRatePerUser} list/s, ${report.countsRatePerUser} counts/s and ${report.actionRatePerUser} open or rate/s.`,
    '',
  );
  lines.push(
    '| Phase | s | list req | p50 ms | p95 ms | 5xx | CPU avg / max % host | inference calls | distinct Qs | cache hits | reuse | backlog alert | arrivals/h | max queue depth |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const phase of report.phases) {
    const depth = Object.entries(phase.queueDepthMax)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([queue, value]) => `${queue} ${value}`)
      .join(', ');
    lines.push(
      `| ${phase.name} | ${phase.durationSec} | ${phase.requests} | ${phase.p50ArticlesMs} | ${phase.p95ArticlesMs} | ${phase.errors5xx} | ${phase.cpuPctAvg} / ${phase.cpuPctMax} | ${phase.inferenceCalls} | ${phase.distinctQuestionsAdmitted} | ${phase.cacheHits} | ${phase.cacheReuseRatio} | ${phase.backlogAlert ? 'YES' : 'no'} | ${phase.arrivalsPerHour} | ${depth || '-'} |`,
    );
  }
  lines.push('', '## Memory high-water mark per service (MiB)', '');
  const services = [
    ...new Set(report.phases.flatMap((phase) => Object.keys(phase.memMaxBytes))),
  ].sort();
  lines.push(`| Phase | ${services.join(' | ')} |`, `|---|${services.map(() => '---').join('|')}|`);
  for (const phase of report.phases) {
    lines.push(
      `| ${phase.name} | ${services.map((s) => Math.round((phase.memMaxBytes[s] ?? 0) / MIB)).join(' | ')} |`,
    );
  }
  lines.push('', '## Criteria', '');
  lines.push(
    `- p95 GET /articles < ${P95_LIMIT_MS} ms in every phase: ${report.criteria.p95Ok ? 'PASS' : 'FAIL'}`,
    `- no queue-backlog alert (real rule from apps/worker/src/alerts): ${report.criteria.backlogOk ? 'PASS' : 'FAIL'}`,
    `- all-off makes zero inference calls: ${report.criteria.allOffZeroInference ? 'PASS' : 'FAIL'}`,
    `- reading stays available (no 5xx, p95 under limit) while the provider fails: ${report.criteria.degradedReadingOk ? 'PASS' : 'FAIL'}`,
    '- CPU: reported only (LOCAL run)',
    '',
    `Articles in the database at the end: ${report.articles}. Distinct questions are article/card pairs ` +
      'that received an answer; cache hits are user x article x card combinations served without a ' +
      'new question (spec 05 shared cache).',
    '',
  );
  return lines.join('\n');
}
