import { cardScore, DEFAULT_RANKER_CONFIG, laneFromP, type CardAnswers } from '@bantoozi/ranker';

import {
  calibration,
  policySummary,
  REPORT_LANES,
  rocAuc,
  wilsonInterval,
  type ReportLane,
} from '../metrics/index.js';
import {
  DEMOTION_FLAGS,
  demotionSamples,
  enrichmentMetrics,
  FLAG_KEYS,
  humanAgreement,
  precisionRecallAtCutoff,
  type DemotionFlag,
} from './enrichment.js';
import { onSplit, scoringCoverage, type RatedItem, type Split } from './items.js';
import { ci, num, pct, shortId, signed, table, usd } from './markdown.js';
import { latestRuns, runView, type ReportModel, type ScoreView } from './model.js';
import { policyLanes, rankCardsOf, type PolicyConfig } from './policy.js';
import {
  buildCells,
  cellAucWithCi,
  cellPrecisionAtK,
  macroAuc,
  macroAucWithCi,
  pairedMacroDelta,
  participantWins,
  sensitivityAuc,
  unknownCount,
  type BootstrapSettings,
  type ScoreFn,
} from './ranking.js';
import type { RunData } from './run-data.js';
import { reliabilitySvg } from './svg.js';

/**
 * The tables of spec 10 §4 as markdown, shared by `eval report` and the G1 report: counts and
 * prevalence, ranking (AUC with paired story-group CIs, ΔAUC, P@10/P@20, macros, wins),
 * calibration with one reliability SVG per language, enrichment accuracy with demotion cutoff
 * precision/recall and human κ, policy (For You precision/coverage, Maybe share, hard-hide false
 * negatives, the lane distribution of liked and disliked items) and operations. Every table
 * names its split; null values print as `—` (unmeasured), never as 0.
 */

export const DEFAULT_POLICY_CONFIG: PolicyConfig = DEFAULT_RANKER_CONFIG;

export type CutoffSet = Readonly<Record<DemotionFlag, number>>;

export const CONFIGURED_CUTOFFS: CutoffSet = {
  clickbait: DEFAULT_RANKER_CONFIG.demotion.clickbait,
  promotional: DEFAULT_RANKER_CONFIG.demotion.promotional,
  shallowDepth: DEFAULT_RANKER_CONFIG.demotion.shallowDepth,
  staleTimeSensitive: DEFAULT_RANKER_CONFIG.demotion.staleTimeSensitive,
};

const SPLIT_NAME: Record<Split, string> = { dev: 'development', test: 'test' };

export function renderRuns(model: ReportModel): string {
  const rows = model.runs.map((run) => {
    const coverage = run.results?.coverage;
    const cov = (entries: Record<string, { expected: number; valid: number }> | undefined) =>
      entries === undefined
        ? '—'
        : Object.entries(entries)
            .map(([k, v]) => `${k} ${v.valid}/${v.expected}`)
            .join(', ');
    return [
      run.id,
      run.experiment,
      run.config.variant === null || run.config.variant === undefined
        ? '—'
        : `${run.config.variant.state}/${run.config.variant.cards}`,
      run.results?.status ?? 'unfinished',
      cov(coverage?.byLang),
      run.config.engine?.model ?? '—',
      shortId(run.gitSha, 10),
      String(run.malformed),
    ];
  });
  return table(
    [
      'run',
      'experiment',
      'state/cards',
      'status',
      'coverage by language',
      'model',
      'git',
      'malformed answers',
    ],
    rows,
  );
}

export function renderCounts(model: ReportModel, splits: readonly Split[]): string {
  const rows: string[][] = [];
  const contexts = [...new Set(model.items.map((i) => i.contextId))].sort();
  for (const split of splits) {
    const items = onSplit(model.items, split);
    for (const contextId of contexts) {
      for (const lang of model.langs) {
        const cell = items.filter((i) => i.contextId === contextId && i.lang === lang);
        if (cell.length === 0) continue;
        const likes = cell.filter((i) => i.liked).length;
        rows.push([
          SPLIT_NAME[split],
          cell[0]?.participantKey.slice(0, 8) ?? '',
          contextName(model, contextId),
          lang,
          String(cell.length),
          String(likes),
          String(cell.length - likes),
          pct(likes / cell.length),
        ]);
      }
    }
  }
  let out = table(
    ['split', 'participant', 'context', 'lang', 'rated', 'likes', 'dislikes', 'prevalence'],
    rows,
  );
  if (model.assignmentCounts.size > 0) {
    out +=
      '\nAssignment status (live `eval.assignments`; skips are never counted as dislikes):\n\n';
    out += table(
      ['context', 'rated', 'skipped', 'pending', 'skip rate'],
      [...model.assignmentCounts.entries()].map(([raterId, c]) => [
        contextName(model, raterId),
        String(c.rated),
        String(c.skipped),
        String(c.pending),
        pct(c.rated + c.skipped === 0 ? null : c.skipped / (c.rated + c.skipped)),
      ]),
    );
  }
  return out;
}

export function contextName(model: ReportModel, raterId: string): string {
  const rater = model.reference?.config.raters.find((r) => r.raterId === raterId);
  return `${raterId}${rater?.contextName ? ` (${rater.contextName})` : ''}`;
}

/** Ranking tables of one split for several views against a baseline. */
export function renderRanking(
  model: ReportModel,
  views: readonly ScoreView[],
  baseline: ScoreView | null,
  split: Split,
  settings: BootstrapSettings,
): string {
  const items = onSplit(model.items, split);
  const contextCells = buildCells(items, 'context');
  const langCells = buildCells(items, 'context-lang');
  let out = `Macro AUC (${SPLIT_NAME[split]}; supported contexts averaged within each participant, then participants; ${settings.resamples ?? 1000} paired story-group resamples):\n\n`;
  const macroRows = views.map((view) => {
    const { macro, ci: interval } = macroAucWithCi(contextCells, view.score, {
      ...settings,
      seed: `${settings.seed}:${split}:${view.label}`,
    });
    const delta =
      baseline === null || baseline.label === view.label
        ? null
        : pairedMacroDelta(contextCells, view.score, baseline.score, {
            ...settings,
            seed: `${settings.seed}:${split}:delta:${view.label}`,
          });
    const wins =
      baseline === null ? null : participantWins(contextCells, view.score, baseline.score);
    const sensitivity = macroAucOf(contextCells, (cellItems) =>
      sensitivityAuc(cellItems, view.score),
    );
    return [
      view.label,
      num(macro.value),
      ci(interval),
      delta === null ? '—' : signed(delta.estimate),
      delta === null ? '—' : ci(delta),
      String(macro.participants),
      String(macro.contexts),
      wins === null ? '—' : `${wins.wins}/${wins.participants}`,
      String(unknownCount(items, view.score)),
      num(sensitivity),
    ];
  });
  out += table(
    [
      'scorer',
      'macro AUC',
      '95% CI',
      `ΔAUC vs ${baseline?.label ?? '—'}`,
      'Δ 95% CI',
      'participants',
      'contexts',
      'participant wins',
      'unknown scores',
      'missing-output sensitivity',
    ],
    macroRows,
  );
  out += `\nPer context (${SPLIT_NAME[split]}; a cell needs ≥20 ratings and ≥5 of each class for its AUC):\n\n`;
  const contextRows: string[][] = [];
  for (const view of views) {
    for (const cell of contextCells) {
      const { auc, ci: interval } = cellAucWithCi(cell, view.score, {
        ...settings,
        seed: `${settings.seed}:${split}:${view.label}`,
      });
      const p10 = cellPrecisionAtK(cell, view.score, 10);
      const p20 = cellPrecisionAtK(cell, view.score, 20);
      contextRows.push([
        view.label,
        cell.participantKey.slice(0, 8),
        contextName(model, cell.contextId),
        String(cell.items.length),
        pct(cell.likes / Math.max(1, cell.items.length)),
        cell.supported ? num(auc) : 'unmeasured',
        ci(interval),
        `${num(p10.value, 2)} (${p10.denominator})`,
        `${num(p20.value, 2)} (${p20.denominator})`,
      ]);
    }
  }
  out += table(
    [
      'scorer',
      'participant',
      'context',
      'n',
      'prevalence',
      'AUC',
      '95% CI',
      'P@10 (n)',
      'P@20 (n)',
    ],
    contextRows,
  );
  out += `\nPer language (${SPLIT_NAME[split]}; macro over supported context × language cells):\n\n`;
  const langRows: string[][] = [];
  for (const view of views) {
    for (const lang of model.langs) {
      const cells = langCells.filter((c) => c.lang === lang);
      if (cells.length === 0) continue;
      const macro = macroAuc(cells, view.score);
      const supported = cells.filter((c) => c.supported).length;
      langRows.push([
        view.label,
        lang,
        num(macro.value),
        `${supported}/${cells.length}`,
        String(cells.reduce((s, c) => s + c.items.length, 0)),
        supported === 0 ? 'unmeasured' : '',
      ]);
    }
  }
  out += table(['scorer', 'lang', 'macro AUC', 'supported cells', 'ratings', 'note'], langRows);
  return out;
}

function macroAucOf(
  cells: ReturnType<typeof buildCells>,
  auc: (items: RatedItem[]) => number | null,
): number | null {
  const byParticipant = new Map<string, number[]>();
  for (const cell of cells) {
    if (!cell.supported) continue;
    const value = auc(cell.items);
    if (value === null) continue;
    byParticipant.set(cell.participantKey, [
      ...(byParticipant.get(cell.participantKey) ?? []),
      value,
    ]);
  }
  const means = [...byParticipant.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  return means.length === 0 ? null : means.reduce((a, b) => a + b, 0) / means.length;
}

/** Calibration of a probabilistic view per language, with its reliability SVG. */
export function renderCalibration(model: ReportModel, view: ScoreView, split: Split): string {
  const items = onSplit(model.items, split);
  let out = '';
  for (const lang of model.langs) {
    const preds = items
      .filter((i) => i.lang === lang)
      .map((i) => ({ p: view.score(i), positive: i.liked }))
      .filter((x): x is { p: number; positive: boolean } => x.p !== null && x.p >= 0 && x.p <= 1);
    const cal = calibration(preds);
    out += `\n**${lang}** (${view.label}, ${SPLIT_NAME[split]}): n=${cal.n}, prevalence ${pct(cal.prevalence)}, ECE ${num(cal.ece)}, Brier ${num(cal.brier)}, logloss ${num(cal.logloss)}\n\n`;
    out += table(
      ['bin', 'count', 'mean score', 'positive fraction'],
      cal.bins.map((b) => [
        `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`,
        String(b.count),
        num(b.meanScore),
        num(b.positiveFraction),
      ]),
    );
    out += `\n${reliabilitySvg(`Reliability ${lang} ${view.label} ${SPLIT_NAME[split]}`, cal)}\n`;
  }
  return out;
}

/** Enrichment accuracy per Call A state (one run per state variant) and language. */
export function renderEnrichment(
  model: ReportModel,
  split: Split,
  cutoffs: { configured: CutoffSet; selected?: CutoffSet | undefined },
): string {
  const latest = latestRuns(model.runs);
  const stateRuns: RunData[] = [];
  const seenStates = new Set<string>();
  for (const experiment of ['E1', 'E3', 'E4', 'E2', 'E3b']) {
    const run = latest.get(experiment);
    const state = run?.config.variant?.state;
    if (
      run === undefined ||
      state === undefined ||
      seenStates.has(state) ||
      run.enrich.size === 0
    ) {
      continue;
    }
    seenStates.add(state);
    stateRuns.push(run);
  }
  if (stateRuns.length === 0) return '_no Call A answers_\n';
  const articlesOf = (lang: string) =>
    [...model.sample.values()]
      .filter((s) => s.lang === lang && s.split === split)
      .map((s) => s.articleId);
  const rows: string[][] = [];
  const cutRows: string[][] = [];
  for (const run of stateRuns) {
    const answerOf = (articleId: string, key: string) => run.enrich.get(articleId)?.get(key);
    for (const lang of model.langs) {
      const ids = articlesOf(lang);
      const m = enrichmentMetrics(ids, model.labels, answerOf);
      if (m.articles === 0) continue;
      rows.push([
        `${run.experiment} (${run.config.variant?.state ?? '—'})`,
        lang,
        String(m.articles),
        `${num(m.contentType.accuracy)} / ${num(m.contentType.macroF1)} (${m.contentType.n})`,
        `${num(m.topic.top1)} / ${num(m.topic.top2)} (${m.topic.n})`,
        `${num(m.depth.mae, 2)} / ${num(m.depth.spearman)} (${m.depth.n})`,
        ...FLAG_KEYS.map((k) => `${num(m.flags[k].auc)} (${m.flags[k].n})`),
        `${m.excluded.uncertain}/${m.excluded.unresolved}/${m.excluded.failedAnswers}`,
      ]);
      for (const { flag, direction } of DEMOTION_FLAGS) {
        const samples = demotionSamples(flag, ids, model.labels, answerOf);
        const at = (cutoff: number) => precisionRecallAtCutoff(samples, cutoff, direction);
        const configured = at(cutoffs.configured[flag]);
        const selected = cutoffs.selected === undefined ? null : at(cutoffs.selected[flag]);
        cutRows.push([
          run.experiment,
          lang,
          flag,
          String(samples.length),
          `${direction === 'gte' ? '≥' : '≤'} ${cutoffs.configured[flag]}`,
          `${num(configured.precision)} / ${num(configured.recall)} (${configured.truePositives}/${configured.flagged}, pos ${configured.positives})`,
          selected === null ? '—' : `${direction === 'gte' ? '≥' : '≤'} ${selected.cutoff}`,
          selected === null
            ? '—'
            : `${num(selected.precision)} / ${num(selected.recall)} (${selected.truePositives}/${selected.flagged}, pos ${selected.positives})`,
        ]);
      }
    }
  }
  let out = `Call A vs adjudicated facet labels (${SPLIT_NAME[split]}; uncertain/not-applicable and unresolved labels excluded):\n\n`;
  out += table(
    [
      'run (state)',
      'lang',
      'labelled',
      'content_type acc / macro-F1 (n)',
      'topic_l1 top-1 / top-2 (n)',
      'depth MAE / Spearman (n)',
      'clickbait AUC (n)',
      'promotional AUC (n)',
      'time_sensitive AUC (n)',
      'excluded uncertain/unresolved/failed',
    ],
    rows,
  );
  out += `\nDemotion cutoffs (${SPLIT_NAME[split]}): precision / recall against the facet label (true positives/flagged, labelled positives):\n\n`;
  out += table(
    [
      'run',
      'lang',
      'flag',
      'labelled',
      'configured',
      'P / R at configured',
      'selected',
      'P / R at selected',
    ],
    cutRows,
  );
  const agreement = humanAgreement(model.reference?.config.facetLabels ?? []);
  out +=
    '\nHuman agreement (an agreement reference, not a model-accuracy ceiling; weighted κ for depth):\n\n';
  out +=
    agreement === null
      ? '_only one labeller: no agreement reference_\n'
      : table(
          ['labellers', ...Object.keys(agreement.byKey)],
          [
            [
              agreement.labelers.join(' vs '),
              ...Object.values(agreement.byKey).map((v) => `${num(v.kappa)} (${v.n})`),
            ],
          ],
        );
  return out;
}

/** Policy metrics of a card-based view under a config, by language and by context. */
export function renderPolicy(
  model: ReportModel,
  view: ScoreView,
  split: Split,
  config: PolicyConfig,
): string {
  if (view.runFor === null) return '';
  const items = onSplit(model.items, split);
  const lanes = policyLanes(items, view.runFor, model.reference?.config.cards ?? [], config);
  const laneOf = (item: RatedItem): ReportLane => lanes.get(item.key)?.lane ?? 'new';
  const row = (scope: string, subset: readonly RatedItem[]) => {
    const summary = policySummary(subset.map((i) => ({ liked: i.liked, lane: laneOf(i) })));
    const fy = wilsonInterval(
      Math.round((summary.forYouPrecision ?? 0) * summary.forYou),
      summary.forYou,
    );
    const liked = summary.distribution.liked;
    const disliked = summary.distribution.disliked;
    const hidden = wilsonInterval(liked.counts.hidden, liked.n);
    const dist = (d: typeof liked) =>
      REPORT_LANES.map((lane) => `${lane} ${d.counts[lane]} (${pct(d.shares[lane], 0)})`).join(
        ', ',
      );
    return [
      view.label,
      scope,
      String(summary.total),
      `${pct(summary.forYouPrecision)} ${fy === null ? '' : `[${pct(fy.lo, 0)}, ${pct(fy.hi, 0)}]`} (${summary.forYou})`,
      `${pct(summary.forYouCoverage)} (${liked.n})`,
      pct(summary.maybeShare),
      `${pct(summary.hardHideFalseNegativeRate)} ${hidden === null ? '' : `[${pct(hidden.lo, 0)}, ${pct(hidden.hi, 0)}]`}`,
      `${dist(liked)}`,
      `${dist(disliked)}`,
    ];
  };
  const rows: string[][] = [];
  for (const lang of model.langs) {
    const subset = items.filter((i) => i.lang === lang);
    if (subset.length > 0) rows.push(row(`lang ${lang}`, subset));
  }
  for (const contextId of [...new Set(items.map((i) => i.contextId))].sort()) {
    rows.push(
      row(
        `context ${contextName(model, contextId)}`,
        items.filter((i) => i.contextId === contextId),
      ),
    );
  }
  return (
    `Policy view (${SPLIT_NAME[split]}; lanes ${config.lanes.forYou}/${config.lanes.maybe}; never/must/floor/cap precedence; unknown answers stay in New and are counted):\n\n` +
    table(
      [
        'scorer',
        'scope',
        'items',
        'For You precision [95%] (n)',
        'For You coverage (liked)',
        'Maybe share',
        'hard-hide FN [95%]',
        'liked by lane',
        'disliked by lane',
      ],
      rows,
    )
  );
}

/** The share of items moving lanes when only the thresholds change (replay helper). */
export function laneOfScore(p: number | null, config: Pick<PolicyConfig, 'lanes'>): ReportLane {
  return p === null ? 'new' : laneFromP(Math.min(1, Math.max(0, p)), config);
}

/** Tokens, cost per 1,000 distinct processed articles, latency, coverage and failures per run. */
export function renderOperations(model: ReportModel): string {
  const rows = model.runs.map((run) => {
    const cost = run.results?.cost;
    const articles = processedArticles(run);
    const uncached = uncachedUsd(run);
    const cardRows = [...run.cards.values()].flatMap((m) => [...m.values()]);
    const failed = cardRows.filter((r) => !r.ok).length;
    const cov = scoringCoverage(run, model.items);
    const expected = [...cov.byLang.values()].reduce((s, c) => s + c.expected, 0);
    const valid = [...cov.byLang.values()].reduce((s, c) => s + c.valid, 0);
    const latency = Object.entries(run.results?.latencyMs ?? {})
      .map(([kind, l]) => `${kind} ${num(l.p50, 0)}/${num(l.p95, 0)} ms (${l.n})`)
      .join(', ');
    const lookup = run.results?.cacheLookupMs;
    return [
      `${run.experiment} (#${run.id})`,
      cost?.tokens === null || cost?.tokens === undefined
        ? '—'
        : `${cost.tokens.input}/${cost.tokens.output}`,
      usd(cost?.estimatedUsd),
      usd(cost?.billedUsd),
      `${usd(cost?.cacheSavingsUsd)} (${cost?.cacheHits ?? '—'} hits / ${cost?.cacheMisses ?? '—'} misses)`,
      usd(cost?.failedCallUsd),
      String(articles),
      usd(uncached === null || articles === 0 ? null : (uncached / articles) * 1000),
      latency === '' ? '—' : latency,
      lookup === null || lookup === undefined
        ? '—'
        : `${num(lookup.p50, 1)}/${num(lookup.p95, 1)} ms`,
      `${valid}/${expected}`,
      pct(cardRows.length === 0 ? null : failed / cardRows.length),
    ];
  });
  return table(
    [
      'run',
      'tokens in/out',
      'estimated',
      'billed',
      'cache savings',
      'failed-call charges',
      'distinct articles',
      '$ / 1,000 articles (uncached)',
      'live latency p50/p95 by kind',
      'cache lookup p50/p95',
      'valid scores',
      'degraded (failed card answers)',
    ],
    rows,
  );
}

/** Distinct articles a run processed (any answer row). */
export function processedArticles(run: RunData): number {
  const ids = new Set<string>([...run.enrich.keys(), ...run.cards.keys()]);
  for (const scores of run.scores.values()) for (const id of scores.keys()) ids.add(id);
  return ids.size;
}

/** What the run would have cost without the cache: billed plus cache savings. */
export function uncachedUsd(run: RunData): number | null {
  const cost = run.results?.cost;
  if (cost === null || cost === undefined) return null;
  if (cost.billedUsd === null || cost.billedUsd === undefined) return cost.estimatedUsd ?? null;
  return cost.billedUsd + (cost.cacheSavingsUsd ?? 0);
}

/**
 * The E6 score of an item: its `score.r<raterId>` row when the run wrote one, else the card score
 * over the rater's rerun answers (`e6.r<raterId>`, card_id = the card; E6 writes no `card` rows).
 */
export function e6Score(run: RunData, config: PolicyConfig = DEFAULT_POLICY_CONFIG): ScoreFn {
  return (item) => {
    const stored = run.scores.get(item.raterId)?.get(item.articleId);
    if (stored !== undefined) return stored;
    const results = run.extra.get(`e6.r${item.raterId}`)?.get(item.articleId);
    if (results === undefined) return null;
    const answers: Record<string, { p: number; engine: 'typesafe' | 'llm' | 'laya' }> = {};
    for (const [cardId, result] of results) {
      if (
        result.ok &&
        (result.engine === 'typesafe' || result.engine === 'llm' || result.engine === 'laya')
      ) {
        answers[cardId] = { p: result.p, engine: result.engine };
      }
    }
    const cards = rankCardsOf(run.config.cards, item.raterId);
    return cardScore(cards, { cardAnswers: answers as CardAnswers, inferenceFeedIds: [] }, config)
      ?.score ?? null;
  };
}

/** Runs that are never a scorer of their own in the tables (informational, replays, gate locks). */
export function isTableRun(run: RunData): boolean {
  return (
    !['E6', 'E7', 'G1-gate'].includes(run.experiment) && !run.experiment.startsWith('replay:')
  );
}

/**
 * E6 and E7 (informational, development only; never gate inputs). E7's lane share uses `config`:
 * the selected configuration in the G1 report, the configured defaults in `eval report`.
 */
export function renderInformational(
  model: ReportModel,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
): string {
  const latest = latestRuns(model.runs);
  const e1 = latest.get('E1');
  let out = '';
  const e6 = latest.get('E6');
  if (e6 !== undefined && e1 !== undefined) {
    const later = new Set(e6.results?.e6?.laterArticleIds ?? []);
    const items = onSplit(model.items, 'dev').filter((i) => later.has(i.articleId));
    const cells = buildCells(items, 'context');
    const delta = pairedMacroDelta(cells, e6Score(e6), runView(e1).score, {
      seed: `${e6.id}:e6`,
      resamples: 1000,
    });
    const added = Object.entries(e6.results?.e6?.examplesAdded ?? {});
    out += `**E6 card examples** (#${e6.id}, later development half, ${items.length} ratings): paired ΔAUC vs E1 ${signed(delta.estimate)} ${ci(delta)}; examples added: ${
      added.length === 0
        ? 'none'
        : added.map(([card, v]) => `card ${card} +${v.yes}/−${v.no}`).join(', ')
    }\n\n`;
  }
  const e7 = latest.get('E7');
  if (e7 !== undefined && e1 !== undefined) {
    const cards = model.reference?.config.cards ?? [];
    const rows: string[][] = [];
    for (const variant of ['e7.targeted', 'e7.generic'] as const) {
      const answers = e7.extra.get(variant);
      for (const lang of model.langs) {
        const deltas: number[] = [];
        let risen = 0;
        let below = 0;
        for (const item of e7.results?.e7?.items ?? []) {
          if (model.sample.get(item.articleId)?.lang !== lang) continue;
          const variantAnswers = answers?.get(item.articleId);
          if (variantAnswers === undefined) continue;
          const raterCards = cards.filter(
            (c) => c.raterId === item.raterId && c.strength !== 'never',
          );
          const targets =
            variant === 'e7.targeted'
              ? raterCards.filter((c) => c.cardId === item.targetedCardId)
              : raterCards;
          for (const card of targets) {
            const before = e1.cards.get(item.articleId)?.get(card.cardId);
            const after = variantAnswers.get(card.cardId);
            if (before?.ok === true && after?.ok === true) deltas.push(after.p - before.p);
          }
          const baseScore = e1.scores.get(item.raterId)?.get(item.articleId) ?? null;
          if (baseScore !== null && laneOfScore(baseScore, config) !== 'for_you') {
            below += 1;
            const weights = config.strengthWeights;
            let best: number | null = null;
            for (const card of raterCards) {
              const after =
                variantAnswers.get(card.cardId) ?? e1.cards.get(item.articleId)?.get(card.cardId);
              if (after?.ok !== true) continue;
              const strength = card.strength as 'must' | 'love' | 'like';
              const s = weights[strength] * after.p;
              best = best === null ? s : Math.max(best, s);
            }
            if (laneOfScore(best, config) === 'for_you') risen += 1;
          }
        }
        if (deltas.length === 0 && below === 0) continue;
        rows.push([
          variant.slice(3),
          lang,
          String(deltas.length),
          signed(deltas.length === 0 ? null : deltas.reduce((a, b) => a + b, 0) / deltas.length),
          `${pct(below === 0 ? null : risen / below)} (${risen}/${below})`,
        ]);
      }
    }
    out += `**E7 steering text** (#${e7.id}, development only):\n\n`;
    out += table(['variant', 'lang', 'answers', 'mean Δp vs E1', 'below For You → For You'], rows);
  }
  return out === '' ? '_no informational runs_\n' : out;
}

/** AUC of an arbitrary item subset (used by the worst-ranked list and diagnostics). */
export function subsetAuc(items: readonly RatedItem[], view: ScoreView): number | null {
  return rocAuc(
    items
      .map((i) => ({ score: view.score(i), positive: i.liked }))
      .filter((x): x is { score: number; positive: boolean } => x.score !== null),
  );
}

export interface EvaluationReportOptions {
  title: string;
  splits: readonly Split[];
  settings: BootstrapSettings;
  /** Why a split is missing (e.g. the test split sealed until the gate locks a selection). */
  sealedNote?: string | undefined;
  baselineExperiment?: string | undefined;
  generatedAt: Date;
}

/** `eval report`: every §4 table for the runs of one dataset version. */
export function renderEvaluationReport(
  model: ReportModel,
  options: EvaluationReportOptions,
): string {
  const latest = latestRuns(model.runs);
  const views = [...latest.values()]
    .filter(isTableRun)
    .map(runView);
  const baselineRun = latest.get(options.baselineExperiment ?? 'B1') ?? null;
  const baseline = baselineRun === null ? null : runView(baselineRun);
  const primary =
    latest.get('E1') ?? [...latest.values()].find((r) => runView(r).probabilistic) ?? null;
  const parts: string[] = [];
  parts.push(`# ${options.title}\n`);
  parts.push(
    `Dataset \`${model.datasetVersion}\`; generated ${options.generatedAt.toISOString()}; ground truth from run ${
      model.reference === null ? '—' : `#${model.reference.id} (${model.reference.experiment})`
    }; bootstrap seed \`${options.settings.seed}\`.\n`,
  );
  if (options.sealedNote !== undefined) parts.push(`> ${options.sealedNote}\n`);
  parts.push('## Runs\n', renderRuns(model));
  parts.push('\n## Counts and class prevalence\n', renderCounts(model, options.splits));
  for (const split of options.splits) {
    parts.push(
      `\n## Ranking (${SPLIT_NAME[split]})\n`,
      renderRanking(model, views, baseline, split, options.settings),
    );
  }
  for (const split of options.splits) {
    parts.push(`\n## Calibration (${SPLIT_NAME[split]})\n`);
    parts.push(
      primary === null
        ? '_no card-based run_\n'
        : renderCalibration(model, runView(primary), split),
    );
  }
  for (const split of options.splits) {
    parts.push(
      `\n## Enrichment accuracy (${SPLIT_NAME[split]})\n`,
      renderEnrichment(model, split, { configured: CONFIGURED_CUTOFFS }),
    );
  }
  for (const split of options.splits) {
    parts.push(`\n## Policy (${SPLIT_NAME[split]}, configured thresholds)\n`);
    for (const view of views) parts.push(renderPolicy(model, view, split, DEFAULT_POLICY_CONFIG));
  }
  parts.push('\n## Operations\n', renderOperations(model));
  parts.push('\n## Informational experiments (E6, E7)\n', renderInformational(model));
  return `${parts.join('\n')}\n`;
}
