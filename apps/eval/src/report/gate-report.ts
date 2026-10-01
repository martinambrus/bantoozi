import { policySummary, type ReportLane } from '../metrics/index.js';
import type { GateStatus } from './decision.js';
import {
  demotionOnTest,
  type GateSelection,
  type RunAssessment,
  type TestConfirmation,
} from './gate.js';
import { onSplit, type RatedItem } from './items.js';
import { ci, escapeCell, num, pct, signed, table } from './markdown.js';
import type { ReportModel } from './model.js';
import { policyLanes } from './policy.js';
import type { BootstrapSettings } from './ranking.js';
import type { Readiness } from './readiness.js';
import {
  contextName,
  CONFIGURED_CUTOFFS,
  renderCalibration,
  renderCounts,
  renderEnrichment,
  renderInformational,
  renderOperations,
  renderPolicy,
  renderRanking,
  renderRuns,
  type CutoffSet,
} from './render.js';

/**
 * The G1 report (spec 10 §1, §5): readiness, run eligibility, the development selection with its
 * lock, the test confirmation of the composed configuration, owner-review items, costs and the §4
 * tables. A gate that is not ready or cannot select writes an honest incomplete report and never
 * reveals the test split.
 */
export interface GateReportInput {
  model: ReportModel;
  readiness: Readiness;
  runs: ReadonlyMap<string, RunAssessment>;
  selection: GateSelection | null;
  confirmation: TestConfirmation | null;
  status: GateStatus;
  lockedAt: Date | null;
  generatedAt: Date;
  settings: BootstrapSettings;
  dryRun: boolean;
}

function scopeStatement(readiness: Readiness): string {
  if (readiness.profile === 'owner_pilot') {
    const contexts = readiness.perParticipant[0]?.contexts ?? 0;
    return (
      `Profile \`owner_pilot\`: ${readiness.participants} actual participant with ${contexts} reading context(s). ` +
      'This is one-person evidence: contexts are not independent humans, and a pass applies only to the ' +
      'measured owner/context/language population. It never means multi-person validation.'
    );
  }
  return `Profile \`multi_person_beta\`: ${readiness.participants} actual participants (participant keys, not persona rows).`;
}

export function renderGateReport(input: GateReportInput): string {
  const { model, readiness, selection, confirmation } = input;
  const parts: string[] = [];
  parts.push(
    `# Gate G1 — ${readiness.profile} — ${input.status.toUpperCase()}${input.dryRun ? ' (DRY RUN)' : ''}\n`,
  );
  parts.push(
    `Dataset \`${model.datasetVersion}\`; generated ${input.generatedAt.toISOString()}; ground truth from run ${
      model.reference === null ? '—' : `#${model.reference.id}`
    }; bootstrap seed \`${input.settings.seed}\`, ${input.settings.resamples ?? 1000} resamples.\n`,
  );
  parts.push(`${scopeStatement(readiness)}\n`);
  if (input.dryRun)
    parts.push('> Dry-run artifact on synthetic data: it can never authorize settings.\n');

  parts.push('## Readiness (label counts only)\n');
  parts.push(
    table(
      [
        'participant',
        'contexts',
        'distinct rated',
        'held-out',
        'held-out likes',
        'held-out dislikes',
      ],
      readiness.perParticipant.map((p) => [
        p.participantKey,
        String(p.contexts),
        String(p.distinctRated),
        String(p.heldOut),
        String(p.heldOutLikes),
        String(p.heldOutDislikes),
      ]),
    ),
  );
  parts.push(
    `\n${table(
      ['lang', 'test ratings', 'likes', 'dislikes', 'supported test cells', 'status'],
      readiness.perLanguage.map((l) => [
        l.lang,
        String(l.testRatings),
        String(l.likes),
        String(l.dislikes),
        String(l.supportedCells),
        l.supportedCells > 0 ? 'measured' : 'unmeasured (defaults kept; unvalidated)',
      ]),
    )}`,
  );
  parts.push(
    readiness.ready
      ? '\nReadiness: **met**.\n'
      : `\nReadiness: **not met** — ${readiness.reasons.map(escapeCell).join('; ')}.\n`,
  );

  parts.push('\n## Run eligibility\n');
  parts.push(
    table(
      ['experiment', 'run', 'eligible', 'reasons'],
      [...input.runs.values()].map((a) => [
        a.experiment,
        a.run?.id ?? '—',
        a.eligible ? 'yes' : 'no',
        a.reasons.join('; '),
      ]),
    ),
  );

  if (selection === null) {
    parts.push(
      '\n## Selection\n\nNo selection was made: readiness is not met. The test split was not revealed.\n',
    );
  } else {
    parts.push(renderSelection(model, selection, input.lockedAt));
  }

  if (confirmation === null || selection === null) {
    parts.push('\n## Test confirmation\n\nThe test split was not revealed (needs more data).\n');
  } else {
    parts.push(renderConfirmation(input, selection, confirmation));
  }

  parts.push('\n## Appendix: evaluation tables\n');
  parts.push(renderCounts(model, confirmation === null ? ['dev'] : ['dev', 'test']));
  parts.push('\n### Runs\n', renderRuns(model));
  if (selection !== null && confirmation !== null) {
    const views = [
      confirmation.composedView,
      ...(confirmation.baselineView === null ? [] : [confirmation.baselineView]),
    ];
    parts.push(
      '\n### Ranking (development)\n',
      renderRanking(model, views, confirmation.baselineView, 'dev', input.settings),
    );
    parts.push(
      '\n### Calibration (development)\n',
      renderCalibration(model, confirmation.composedView, 'dev'),
    );
    parts.push(
      '\n### Policy (development, selected thresholds)\n',
      renderPolicy(model, confirmation.composedView, 'dev', confirmation.policyConfig),
    );
  }
  parts.push(
    '\n### Enrichment (development)\n',
    renderEnrichment(model, 'dev', {
      configured: CONFIGURED_CUTOFFS,
      selected: selectedCutoffs(selection),
    }),
  );
  parts.push('\n### Operations\n', renderOperations(model));
  parts.push(
    '\n### Informational experiments (E6, E7; never gate inputs)\n',
    renderInformational(model, confirmation?.policyConfig, input.settings.resamples ?? 1000),
  );
  return `${parts.join('\n')}\n`;
}

function selectedCutoffs(selection: GateSelection | null): CutoffSet | undefined {
  if (selection === null) return undefined;
  return Object.fromEntries(
    selection.demotion.map((d) => [d.flag, d.value]),
  ) as unknown as CutoffSet;
}

function renderSelection(model: ReportModel, s: GateSelection, lockedAt: Date | null): string {
  const out: string[] = ['\n## Selection on development\n'];
  out.push(
    `Status: **${s.status}**${s.reasons.length > 0 ? ` — ${s.reasons.join('; ')}` : ''}. Locked baseline: **${s.baseline ?? '—'}**; E*: **${s.core ?? '—'}** (ties prefer the cheaper native variant; E4/E5 diagnostics, E6/E7 informational).\n`,
  );
  out.push(
    table(
      ['experiment', 'development macro AUC'],
      Object.entries(s.devMacro).map(([e, v]) => [e, num(v)]),
    ),
  );
  out.push(
    `\nCard text mode: **${s.cardMode.mode}** (${s.cardMode.status}; paired gain of English cards on non-English-card contexts ${signed(s.cardMode.gain)}; ≥0.02 required).\n`,
  );
  out.push(
    table(
      ['lang', 'mode', 'translation gain', 'bilingual English comparison', 'Laya track'],
      s.languages.map((l) => [
        l.lang,
        l.mode ?? 'unmeasured (current setting kept)',
        signed(l.translationGain),
        l.englishComparison,
        l.layaRecommended ? 'recommended' : '—',
      ]),
    ),
  );
  out.push(
    `\nTier-2 cap: **${s.tier2.cap}** (${s.tier2.status}; E4 gain over tier 1: ${
      Object.entries(s.tier2.gains)
        .map(([l, g]) => `${l} ${signed(g)}`)
        .join(', ') || '—'
    }; ≥0.05 for SK or CS required for 1000).\n`,
  );
  out.push(
    `\nComposed production configuration: ${Object.entries(s.composition)
      .map(([lang, e]) => `${lang} → ${e}${s.runs[e] === undefined ? '' : ` (#${s.runs[e]})`}`)
      .join(', ')}.\n`,
  );
  const thresholdRows = (rows: GateSelection['forYou']['rows']) =>
    rows.map((r) => [
      r.t.toFixed(2),
      num(r.likeRate),
      String(r.distinctItems),
      pct(r.coverage),
      String(r.participants),
      r.ok ? 'yes' : 'no',
    ]);
  out.push(
    `\n\`lanes.forYou\` = **${s.forYou.value}** (${s.forYou.status}${s.forYou.status === 'unmet' ? ': precision target unmet, default kept' : ''}):\n\n`,
  );
  out.push(
    table(
      ['t', 'weighted like-rate P≥t', 'distinct items', 'coverage', 'participants', 'qualifies'],
      thresholdRows(s.forYou.rows),
    ),
  );
  out.push(`\n\`lanes.maybe\` = **${s.maybe.value}** (${s.maybe.status}):\n\n`);
  out.push(
    table(
      ['t', 'weighted like-rate P<t', 'distinct items', 'share', 'participants', 'qualifies'],
      thresholdRows(s.maybe.rows),
    ),
  );
  out.push(
    `\n\`tiers\` = **[${s.tiers.value.join(', ')}]** (${s.tiers.status}; development ECE ${num(s.tiers.ece)}${
      s.tiers.cuts === null ? '' : `; isotonic cuts ${s.tiers.cuts.map((c) => num(c)).join(', ')}`
    }).\n`,
  );
  out.push(
    '\nDemotion cutoffs (adjudicated development facet labels; a candidate counts when it flags ≥20 articles):\n\n',
  );
  out.push(
    table(
      ['flag', 'value', 'default', 'status', 'counted candidates (t: precision, flagged)'],
      s.demotion.map((d) => [
        d.flag,
        String(d.value),
        String(d.default),
        d.status,
        d.candidates
          .filter((c) => c.flagged >= 20)
          .map((c) => `${c.cutoff}: ${num(c.precision, 2)} (${c.flagged})`)
          .join(', ') || '—',
      ]),
    ),
  );
  out.push(
    `\nBudget: measured $${num(s.budget.costPer1000Usd, 4)} per 1,000 authorized uncached article revisions × (${s.budget.dailyRevisions} expected daily authorized revisions ÷ 1000) × 2, rounded up to $0.50, minimum $1 → **$${s.budget.value.toFixed(2)}/day** (${s.budget.status}; ${s.budget.costBasis === 'per_language' ? 'per-language costs of each composed run' : "each composed run's whole uncached cost charged to the languages it serves (upper bound; no per-language costs recorded)"}). All-active/high-volume sensitivity (×5 revisions): $${Math.max(
      1,
      Math.ceil((s.budget.costPer1000Usd ?? 0) * ((5 * s.budget.dailyRevisions) / 1000) * 2 * 2) /
        2,
    ).toFixed(2)}/day. Off feeds add no authorized provider calls.\n`,
  );
  out.push(
    `\nSelection manifest: config sha \`${s.configSha}\`, locked ${lockedAt?.toISOString() ?? '— (not locked)'}, development runs ${s.developmentRunIds.join(', ') || '—'}. No output-derived retuning is allowed under this test manifest.\n`,
  );
  void model;
  return out.join('\n');
}

function renderConfirmation(input: GateReportInput, s: GateSelection, c: TestConfirmation): string {
  const { model } = input;
  const out: string[] = ['\n## Test confirmation (composed configuration vs locked baseline)\n'];
  out.push(
    `Macro AUC **${num(c.macro)}** vs ${s.baseline ?? '—'} ${num(c.baselineMacro)}: ΔAUC ${signed(c.delta.estimate)} ${ci(c.delta)} (paired story-group bootstrap). Decision: **${c.decision.status}**${
      c.decision.reasons.length > 0 ? ` — ${c.decision.reasons.join('; ')}` : ''
    }. Point estimates decide this small-beta gate; the intervals do not claim population-level certainty.\n`,
  );
  out.push(
    table(
      ['participant', 'composed AUC', 'baseline AUC', 'beats baseline'],
      [...c.participants].map(([key, v]) => [
        key,
        num(v.candidate),
        num(v.baseline),
        v.candidate !== null && v.baseline !== null && v.candidate > v.baseline ? 'yes' : 'no',
      ]),
    ),
  );
  const views = [c.composedView, ...(c.baselineView === null ? [] : [c.baselineView])];
  out.push(
    '\n### Per context and language (test)\n',
    renderRanking(model, views, c.baselineView, 'test', input.settings),
  );
  out.push('\n### Calibration (test)\n', renderCalibration(model, c.composedView, 'test'));
  out.push(
    '\n### Policy at the selected thresholds (test)\n',
    renderPolicy(model, c.composedView, 'test', c.policyConfig),
  );
  out.push(
    '\n### Demotion cutoffs (test precision and recall)\n',
    renderEnrichment(model, 'test', {
      configured: CONFIGURED_CUTOFFS,
      selected: selectedCutoffs(s),
    }),
  );
  const demotion = demotionOnTest(model, input.runs, s);
  out.push(
    '\nPooled over the composed configuration (test):\n',
    table(
      ['flag', 'labelled', 'configured', 'P / R at configured', 'selected', 'P / R at selected'],
      demotion.map((d) => [
        d.flag,
        String(d.samples),
        String(d.configured.cutoff),
        `${num(d.configured.precision)} / ${num(d.configured.recall)} (${d.configured.truePositives}/${d.configured.flagged})`,
        String(d.selected.cutoff),
        `${num(d.selected.precision)} / ${num(d.selected.recall)} (${d.selected.truePositives}/${d.selected.flagged})`,
      ]),
    ),
  );
  out.push('\n## Owner-review items\n', renderOwnerReview(input, s, c, demotion));
  out.push(
    '\n## Worst-ranked liked articles (composed configuration)\n',
    renderWorstLiked(model, c),
  );
  return out.join('\n');
}

function renderOwnerReview(
  input: GateReportInput,
  s: GateSelection,
  c: TestConfirmation,
  demotion: ReturnType<typeof demotionOnTest>,
): string {
  const items = onSplit(input.model.items, 'test');
  const lanes = policyLanes(
    items,
    c.composedView.runFor ?? (() => null),
    input.model.reference?.config.cards ?? [],
    c.policyConfig,
  );
  const summary = policySummary(
    items.map((i) => ({ liked: i.liked, lane: (lanes.get(i.key)?.lane ?? 'new') as ReportLane })),
  );
  const notes: string[] = [];
  const liked = summary.distribution.liked;
  notes.push(
    `Hard-hide false negatives on test: ${liked.counts.hidden}/${liked.n} (${pct(summary.hardHideFalseNegativeRate)}).`,
  );
  notes.push(
    `Liked items placed in Everything on test: ${liked.counts.everything}/${liked.n} (${pct(summary.likedInEverything)}).`,
  );
  if (s.forYou.status === 'unmet')
    notes.push('For You precision target unmet on development: default 0.65 kept.');
  if (s.maybe.status === 'unmet')
    notes.push('Maybe like-rate target unmet on development: default kept.');
  for (const d of s.demotion) {
    if (d.status !== 'selected')
      notes.push(`Demotion \`${d.flag}\` ${d.status}: default ${d.default} kept.`);
  }
  for (const d of demotion) {
    if (d.selected.precision === null || d.selected.precision < 0.8) {
      notes.push(
        `Demotion \`${d.flag}\` at ${d.selected.cutoff}: test precision ${num(d.selected.precision)} (${d.selected.truePositives}/${d.selected.flagged}) is below 0.80 or unmeasured.`,
      );
    }
  }
  for (const lang of input.readiness.unmeasuredLangs)
    notes.push(`Language ${lang} is unmeasured: defaults kept, quality unvalidated.`);
  return `${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

function renderWorstLiked(model: ReportModel, c: TestConfirmation): string {
  const byContext = new Map<string, RatedItem[]>();
  for (const item of model.items)
    byContext.set(item.contextId, [...(byContext.get(item.contextId) ?? []), item]);
  const ranked: { item: RatedItem; percentile: number; score: number | null }[] = [];
  for (const list of byContext.values()) {
    const scores = list.map((i) => c.composedView.score(i)).filter((s): s is number => s !== null);
    for (const item of list.filter((i) => i.liked)) {
      const score = c.composedView.score(item);
      const percentile =
        score === null ? 0 : scores.filter((s) => s < score).length / Math.max(1, scores.length);
      ranked.push({ item, percentile, score });
    }
  }
  ranked.sort((a, b) => a.percentile - b.percentile || a.item.key.localeCompare(b.item.key));
  return table(
    ['split', 'context', 'lang', 'article', 'score', 'rank percentile', 'title'],
    ranked
      .slice(0, 20)
      .map(({ item, percentile, score }) => [
        item.split === 'dev' ? 'development' : 'test',
        contextName(model, item.contextId),
        item.lang,
        item.articleId,
        num(score),
        pct(percentile, 0),
        (item.title ?? '').slice(0, 80),
      ]),
  );
}
