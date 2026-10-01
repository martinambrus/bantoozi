import { describe, expect, it } from 'vitest';

import {
  assessGateRuns,
  confirmOnTest,
  developmentInput,
  gateReadiness,
  selectOnDevelopment,
} from '../src/report/gate.js';
import { renderGateReport } from '../src/report/gate-report.js';
import { buildReportModel, latestRuns } from '../src/report/model.js';
import { renderEvaluationReport } from '../src/report/render.js';
import { parseRunData } from '../src/report/run-data.js';
import { reliabilitySvg } from '../src/report/svg.js';
import { calibration } from '../src/metrics/index.js';
import { buildFixture, DATASET, makeRun, standardRuns } from './gate-fixtures.js';

/** M3a-T7: the report renders every table of spec 10 §4 and one reliability SVG per language. */

const settings = { seed: 'report-test', resamples: 30 };
const generatedAt = new Date('2026-10-01T12:00:00Z');

function svgCount(markdown: string): number {
  return (markdown.match(/<svg /g) ?? []).length;
}

describe('eval report', () => {
  const fixture = buildFixture();
  const runs = [
    ...standardRuns(fixture),
    makeRun(fixture, { id: '30', experiment: 'E7', signal: () => 0.85 }),
  ];
  const model = buildReportModel({ datasetVersion: DATASET.version, runs, sample: fixture.sample });

  it('renders every §4 table for development only while the test split is sealed', () => {
    const markdown = renderEvaluationReport(model, {
      title: 'Evaluation report',
      splits: ['dev'],
      settings,
      sealedNote: 'The test split is sealed.',
      generatedAt,
    });
    for (const heading of [
      '## Runs',
      '## Counts and class prevalence',
      '## Ranking (development)',
      '## Calibration (development)',
      '## Enrichment accuracy (development)',
      '## Policy (development, configured thresholds)',
      '## Operations',
      '## Informational experiments (E6, E7)',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).not.toContain('(test)');
    // Ranking: macro with paired CI and ΔAUC, per context with P@10/P@20, per language.
    for (const column of [
      'macro AUC',
      'ΔAUC vs B1 (#12)',
      'participant wins',
      'missing-output sensitivity',
      'P@10 (n)',
      'P@20 (n)',
      'supported cells',
      // Calibration.
      'positive fraction',
      'ECE',
      'Brier',
      'logloss',
      // Enrichment.
      'content_type acc / macro-F1 (n)',
      'topic_l1 top-1 / top-2 (n)',
      'depth MAE / Spearman (n)',
      'clickbait AUC (n)',
      'P / R at configured',
      'Human agreement',
      // Policy.
      'For You precision [95%] (n)',
      'For You coverage (liked)',
      'Maybe share',
      'hard-hide FN [95%]',
      'liked by lane',
      'disliked by lane',
      // Operations.
      '$ / 1,000 articles (uncached)',
      'live latency p50/p95 by kind',
      'cache lookup p50/p95',
      'degraded (failed card answers)',
    ]) {
      expect(markdown).toContain(column);
    }
    // One reliability SVG per language (E1 is the calibrated scorer).
    expect(svgCount(markdown)).toBe(2);
    expect(markdown).toContain('Reliability en E1 (#14) development');
    expect(markdown).toContain('Reliability sk E1 (#14) development');
    expect(markdown).toContain('E7 steering text');
  });

  it('adds the test tables once the split is unsealed', () => {
    const markdown = renderEvaluationReport(model, {
      title: 'r',
      splits: ['dev', 'test'],
      settings,
      generatedAt,
    });
    expect(markdown).toContain('## Ranking (test)');
    expect(markdown).toContain('## Policy (test, configured thresholds)');
    expect(svgCount(markdown)).toBe(4);
  });

  it('places each rated item in exactly one lane per rater', () => {
    const markdown = renderEvaluationReport(model, {
      title: 'r',
      splits: ['dev'],
      settings,
      generatedAt,
    });
    const row = markdown.split('\n').find((l) => l.startsWith('| E1 (#14) | lang en |'));
    expect(row).toBeDefined();
    const cells = row!.split('|').map((c) => c.trim());
    const items = Number(cells[3]);
    const count = (text: string) =>
      [...text.matchAll(/(for_you|maybe|everything|hidden|new) (\d+)/g)].reduce(
        (s, m) => s + Number(m[2]),
        0,
      );
    expect(count(cells[8]!) + count(cells[9]!)).toBe(items);
  });

  it('prints unmeasured values as — and never fabricates a single-class AUC', () => {
    const tiny = buildFixture({ perLang: 6 });
    const tinyModel = buildReportModel({
      datasetVersion: DATASET.version,
      runs: standardRuns(tiny),
      sample: tiny.sample,
    });
    const markdown = renderEvaluationReport(tinyModel, {
      title: 'r',
      splits: ['dev'],
      settings,
      generatedAt,
    });
    expect(markdown).toContain('unmeasured');
    expect(markdown).not.toMatch(/\| E1 \(#14\) \| 0\.500 \|/);
  });
});

describe('G1 report', () => {
  it('renders readiness, eligibility, selection, the test confirmation and owner-review items', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture);
    const model = buildReportModel({
      datasetVersion: DATASET.version,
      runs,
      sample: fixture.sample,
    });
    const assessments = assessGateRuns(model, latestRuns(runs), DATASET);
    const readiness = gateReadiness(model, 'owner_pilot');
    const selection = selectOnDevelopment(
      developmentInput(model, assessments, 'owner_pilot', DATASET, 1000),
    );
    const confirmation = confirmOnTest(model, assessments, selection, settings);
    const markdown = renderGateReport({
      model,
      readiness,
      runs: assessments,
      selection,
      confirmation,
      status: confirmation.decision.status,
      lockedAt: generatedAt,
      generatedAt,
      settings,
      dryRun: true,
    });
    for (const text of [
      '# Gate G1 — owner_pilot — PASS (DRY RUN)',
      'one-person evidence',
      '## Readiness (label counts only)',
      '## Run eligibility',
      '## Selection on development',
      'Composed production configuration',
      '`lanes.forYou`',
      '`lanes.maybe`',
      '`tiers`',
      'Demotion cutoffs (adjudicated development facet labels',
      'Budget: measured',
      'Selection manifest: config sha',
      '## Test confirmation (composed configuration vs locked baseline)',
      '### Demotion cutoffs (test precision and recall)',
      'P / R at selected',
      '## Owner-review items',
      'Hard-hide false negatives on test',
      'Liked items placed in Everything on test',
      '## Worst-ranked liked articles (composed configuration)',
    ]) {
      expect(markdown).toContain(text);
    }
    expect(svgCount(markdown)).toBe(4);
  });

  it('writes an honest incomplete report without revealing the test split', () => {
    const fixture = buildFixture({ perLang: 50 });
    const runs = standardRuns(fixture);
    const model = buildReportModel({
      datasetVersion: DATASET.version,
      runs,
      sample: fixture.sample,
    });
    const markdown = renderGateReport({
      model,
      readiness: gateReadiness(model, 'owner_pilot'),
      runs: assessGateRuns(model, latestRuns(runs), DATASET),
      selection: null,
      confirmation: null,
      status: 'needs_more_data',
      lockedAt: null,
      generatedAt,
      settings,
      dryRun: false,
    });
    expect(markdown).toContain('NEEDS_MORE_DATA');
    expect(markdown).toContain('Readiness: **not met**');
    expect(markdown).toContain('The test split was not revealed');
    expect(markdown).not.toContain('(test)');
  });
});

describe('run data and the reliability SVG', () => {
  it('parses answers, counts malformed rows and keeps failed answers as unknown', () => {
    const run = parseRunData(
      {
        id: '5',
        experiment: 'E1',
        datasetVersion: 'v',
        gitSha: 'x',
        startedAt: generatedAt,
        finishedAt: null,
        config: {
          experiment: 'E1',
          datasetVersion: 'v',
          snapshotSha: null,
          splitSha: null,
          cohort: { articleIds: ['1'], sha: 's' },
        },
        results: { status: 'nonsense' },
      },
      [
        {
          articleId: '1',
          cardId: null,
          questionKey: 'score.r7',
          answer: { score: 0.4, source: 'cards' },
        },
        {
          articleId: '2',
          cardId: null,
          questionKey: 'score.r7',
          answer: { score: null, source: 'cards' },
        },
        {
          articleId: '1',
          cardId: '9',
          questionKey: 'card',
          answer: { ok: false, reason: 'timeout' },
        },
        { articleId: '1', cardId: '8', questionKey: 'card', answer: { ok: true, p: 1.5 } },
        { articleId: '1', cardId: null, questionKey: 'enrich.depth', answer: { garbage: true } },
      ],
    );
    expect(run.results).toBeNull();
    expect(run.scores.get('7')).toEqual(
      new Map([
        ['1', 0.4],
        ['2', null],
      ]),
    );
    expect(run.cards.get('1')?.get('9')).toEqual({ ok: false });
    expect(run.cards.get('1')?.get('8')).toEqual({ ok: false });
    expect(run.enrich.get('1')?.get('depth')).toBeNull();
    expect(run.malformed).toBe(1);
  });

  it('draws a self-contained SVG with escaped text', () => {
    const svg = reliabilitySvg(
      'a <b> & "c"',
      calibration([
        { p: 0.3, positive: true },
        { p: 0.7, positive: false },
      ]),
    );
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(svg).not.toMatch(/href|<script|https?:\/\/(?!www\.w3\.org)/);
    expect(svg).not.toContain('\n\n');
  });
});
