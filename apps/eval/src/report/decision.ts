import { DEFAULT_RANKER_CONFIG } from '@bantoozi/ranker';

import {
  calibration,
  hierarchicalWeights,
  isotonicRegression,
  precisionRecallAtCutoff,
  smallestScoreReaching,
  type CutoffResult,
  type FlagSample,
} from '../metrics/index.js';
import type { DemotionFlag } from './enrichment.js';

/**
 * The decision rules of gate G1 (spec 10 §5) as pure functions. Selection functions receive
 * development numbers only; the confirmation receives test numbers only after the selection is
 * locked (see `gate.ts`). Every unsupported input stays explicit: a null metric means unmeasured,
 * and each fallback says whether a target was unmet (measured, below the bar) or unmeasured.
 */

export type Profile = 'owner_pilot' | 'multi_person_beta';
export type CardMode = 'as_written' | 'english';
export type LanguageMode = 'native' | 'translate';
export type GateStatus = 'pass' | 'fail' | 'needs_more_data';

/** Compares decimals computed as differences (0.72 − 0.70 must count as 0.02). */
const EPS = 1e-9;
const atLeast = (value: number, bar: number): boolean => value >= bar - EPS;
const atMost = (value: number, bar: number): boolean => value <= bar + EPS;
/** Grid points as exact decimals (from, to and step in hundredths). */
export function grid(from: number, to: number, step = 5): number[] {
  const points: number[] = [];
  for (let h = from; h <= to; h += step) points.push(h / 100);
  return points;
}

// ── Step 1: eligibility, baseline and E* ─────────────────────────────────────────────────────

/** The all-language core candidates in tie-break order: cheaper native variants first. */
export const CORE_CANDIDATES = ['E1', 'E2', 'E3', 'E3b'] as const;
export type CoreCandidate = (typeof CORE_CANDIDATES)[number];
export const CORE_VARIANTS: Readonly<
  Record<CoreCandidate, { family: 'native' | 'lt'; cards: CardMode }>
> = {
  E1: { family: 'native', cards: 'as_written' },
  E2: { family: 'native', cards: 'english' },
  E3: { family: 'lt', cards: 'as_written' },
  E3b: { family: 'lt', cards: 'english' },
};
export const BASELINE_CANDIDATES = ['B1', 'B1-T'] as const;
export type BaselineCandidate = (typeof BASELINE_CANDIDATES)[number];

/** ≥95 % valid scoring coverage per language and rater (spec 10 §3 "Completeness"). */
export const MIN_COVERAGE = 0.95;

export interface RunCheck {
  experiment: string;
  runId: string | null;
  status: string | null;
  datasetMatches: boolean;
  cohortMatches: boolean;
  groundTruthMatches: boolean;
  coverage: {
    byLang: Readonly<Record<string, { expected: number; valid: number }>>;
    byRater: Readonly<Record<string, { expected: number; valid: number }>>;
  };
  /** Answers from an engine other than the pinned one (an LLM fallback is never a Jev answer). */
  foreignEngineAnswers: number;
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * Whether a run may enter selection or confirmation: it exists, finished `complete`, reads the
 * gate's dataset hashes, cohort and ground truth, pins its engine and has ≥95 % valid coverage for
 * every language and rater. Anything else is `needs_more_data` material, never an easy-items pass.
 */
export function runEligibility(check: RunCheck): Eligibility {
  const reasons: string[] = [];
  if (check.runId === null) return { eligible: false, reasons: ['no run'] };
  if (check.status !== 'complete') reasons.push(`status ${check.status ?? 'unfinished'}`);
  if (!check.datasetMatches) reasons.push('dataset or split hash mismatch');
  if (!check.cohortMatches) reasons.push('cohort differs from the reference run');
  if (!check.groundTruthMatches) reasons.push('ratings differ from the reference run');
  if (check.foreignEngineAnswers > 0) {
    reasons.push(`${check.foreignEngineAnswers} answers from an engine other than the pinned one`);
  }
  for (const [scope, entries] of [
    ['language', check.coverage.byLang],
    ['rater', check.coverage.byRater],
  ] as const) {
    for (const [key, { expected, valid }] of Object.entries(entries)) {
      if (expected > 0 && valid / expected < MIN_COVERAGE - EPS) {
        reasons.push(
          `coverage ${((100 * valid) / expected).toFixed(1)}% < 95% for ${scope} ${key}`,
        );
      }
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

export interface CandidateScore<E extends string> {
  experiment: E;
  eligible: boolean;
  /** Development macro AUC; null when no cell is supported. */
  devMacroAuc: number | null;
}

/**
 * The best eligible candidate by development macro AUC; exact ties go to the earlier entry of
 * `order` (B1 before B1-T; the cheaper native variant first among E*). Null when none is eligible
 * with a defined AUC.
 */
export function selectBest<E extends string>(
  candidates: readonly CandidateScore<E>[],
  order: readonly E[],
): E | null {
  let best: { experiment: E; auc: number; rank: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.eligible || candidate.devMacroAuc === null) continue;
    const rank = order.indexOf(candidate.experiment);
    if (rank < 0) continue;
    const auc = candidate.devMacroAuc;
    if (
      best === null ||
      auc > best.auc + EPS ||
      (Math.abs(auc - best.auc) <= EPS && rank < best.rank)
    ) {
      best = { experiment: candidate.experiment, auc, rank };
    }
  }
  return best?.experiment ?? null;
}

export const selectBaseline = (candidates: readonly CandidateScore<BaselineCandidate>[]) =>
  selectBest(candidates, BASELINE_CANDIDATES);

/** E* among E1/E2/E3/E3b only: E4/E5 are diagnostics and E6/E7 informational (spec 10 §5 step 1). */
export const selectCore = (candidates: readonly CandidateScore<string>[]) =>
  selectBest(
    candidates.filter((c): c is CandidateScore<CoreCandidate> =>
      (CORE_CANDIDATES as readonly string[]).includes(c.experiment),
    ),
    CORE_CANDIDATES,
  );

// ── Step 2: card text mode ──────────────────────────────────────────────────────────────────

export const CARD_MODE_MIN_GAIN = 0.02;

export interface CardModeDecision {
  mode: CardMode;
  status: 'measured' | 'unmeasured';
  /** English − as written, paired, on non-English-card contexts of the selected state family. */
  gain: number | null;
}

/**
 * `english` when its paired development gain on non-English-card participant-contexts is ≥0.02 in
 * the selected state family; otherwise `as_written`. Without an eligible non-English-card cohort
 * (either variant missing or no supported context) keep `as_written`, marked unmeasured.
 */
export function chooseCardMode(input: {
  asWritten: number | null;
  english: number | null;
}): CardModeDecision {
  if (input.asWritten === null || input.english === null) {
    return { mode: 'as_written', status: 'unmeasured', gain: null };
  }
  const gain = input.english - input.asWritten;
  return {
    mode: atLeast(gain, CARD_MODE_MIN_GAIN) ? 'english' : 'as_written',
    status: 'measured',
    gain,
  };
}

// ── Step 3: language modes and the tier-2 cap ───────────────────────────────────────────────

export const TRANSLATE_MIN_GAIN = 0.02;
export const NATIVE_MAX_SHORTFALL = 0.05;
export const TIER2_MIN_GAIN = 0.05;

export interface LanguageModeInput {
  lang: string;
  /** Development macro AUC of the native state (selected card mode) on this language. */
  native: number | null;
  /** The translated state, same card mode, same raters and articles. */
  translated: number | null;
  /** Bilingual-rater comparison: their native-language AUC and their English AUC. */
  bilingual: { native: number | null; english: number | null };
}

export interface LanguageModeDecision {
  lang: string;
  /** Null when the language is unmeasured: the current setting stays. */
  mode: LanguageMode | null;
  translationGain: number | null;
  /** The native-vs-English check on bilingual raters. */
  englishComparison: 'native_suffices' | 'native_short' | 'inconclusive';
  layaRecommended: boolean;
}

/**
 * Spec 10 §5 step 3 for one non-English language, within the selected card text mode: translate
 * only when translation adds ≥0.02 AUC over native on the same raters and articles, else native.
 * Native suffices when bilingual raters' native AUC is at most 0.05 below their English AUC; if it
 * falls short and translation does not help, keep native and recommend the Laya track. Without a
 * bilingual comparison the within-language gain decides and the English comparison is inconclusive.
 */
export function chooseLanguageMode(input: LanguageModeInput): LanguageModeDecision {
  const { native, translated, bilingual } = input;
  const comparison: LanguageModeDecision['englishComparison'] =
    bilingual.native === null || bilingual.english === null
      ? 'inconclusive'
      : atLeast(bilingual.native, bilingual.english - NATIVE_MAX_SHORTFALL)
        ? 'native_suffices'
        : 'native_short';
  if (native === null) {
    return {
      lang: input.lang,
      mode: null,
      translationGain: null,
      englishComparison: comparison,
      layaRecommended: false,
    };
  }
  const gain = translated === null ? null : translated - native;
  const mode: LanguageMode =
    gain !== null && atLeast(gain, TRANSLATE_MIN_GAIN) ? 'translate' : 'native';
  return {
    lang: input.lang,
    mode,
    translationGain: gain,
    englishComparison: comparison,
    layaRecommended: comparison === 'native_short' && mode === 'native',
  };
}

export interface Tier2Decision {
  cap: 300 | 1000;
  status: 'measured' | 'unmeasured';
  gains: Record<string, number | null>;
}

/**
 * `translate.tier2_daily_cap` is 1000 only when E4 (same selected card mode) gains ≥0.05 over
 * tier 1 for SK or CS on development; else 300, unmeasured when no gain could be computed.
 */
export function chooseTier2Cap(gains: Readonly<Record<string, number | null>>): Tier2Decision {
  const measured = Object.values(gains).filter((g): g is number => g !== null);
  return {
    cap: measured.some((g) => atLeast(g, TIER2_MIN_GAIN)) ? 1000 : 300,
    status: measured.length === 0 ? 'unmeasured' : 'measured',
    gains: { ...gains },
  };
}

/**
 * The actual composed production configuration: the experiment whose scores each language uses.
 * English is always native; an unmeasured language keeps the native default.
 */
export function composeConfiguration(
  langs: readonly string[],
  cardMode: CardMode,
  modes: Readonly<Record<string, LanguageMode | null>>,
): Record<string, CoreCandidate> {
  const composition: Record<string, CoreCandidate> = {};
  for (const lang of [...new Set(langs)].sort()) {
    const translate = lang !== 'en' && modes[lang] === 'translate';
    composition[lang] = translate
      ? cardMode === 'english'
        ? 'E3b'
        : 'E3'
      : cardMode === 'english'
        ? 'E2'
        : 'E1';
  }
  return composition;
}

// ── Step 4: one global threshold object ─────────────────────────────────────────────────────

/** A pooled development example of the composed configuration. */
export interface PoolItem {
  participantKey: string;
  contextId: string;
  articleId: string;
  /** Raw card score in [0, 1]. */
  p: number;
  liked: boolean;
}

export interface WeightedPoolItem extends PoolItem {
  weight: number;
}

/**
 * Equal total weight per actual participant, then per supported context inside it, then per
 * article inside the context (spec 10 §5 step 4).
 */
export function weightPool(items: readonly PoolItem[]): WeightedPoolItem[] {
  const weights = hierarchicalWeights(items);
  return items.map((item, i) => ({ ...item, weight: weights[i] ?? 0 }));
}

export interface ThresholdRow {
  t: number;
  likeRate: number | null;
  distinctItems: number;
  coverage: number;
  participants: number;
  ok: boolean;
}

export interface ThresholdDecision {
  value: number;
  status: 'selected' | 'unmet';
  rows: ThresholdRow[];
}

export const FOR_YOU_MIN_PRECISION = 0.7;
export const MAYBE_MAX_LIKE_RATE = 0.15;
export const MIN_DISTINCT_ITEMS = 30;
export const MIN_FOR_YOU_COVERAGE = 0.1;

function minParticipants(profile: Profile): number {
  return profile === 'multi_person_beta' ? 2 : 1;
}

function evaluateSlice(
  pool: readonly WeightedPoolItem[],
  slice: readonly WeightedPoolItem[],
  t: number,
): Omit<ThresholdRow, 'ok'> {
  const total = pool.reduce((s, i) => s + i.weight, 0);
  const w = slice.reduce((s, i) => s + i.weight, 0);
  const liked = slice.reduce((s, i) => s + (i.liked ? i.weight : 0), 0);
  return {
    t,
    likeRate: w > 0 ? liked / w : null,
    distinctItems: new Set(slice.map((i) => i.articleId)).size,
    coverage: total > 0 ? w / total : 0,
    participants: new Set(slice.map((i) => i.participantKey)).size,
  };
}

/**
 * `lanes.forYou`: the smallest t on 0.50…0.85 whose weighted like-rate among P ≥ t is ≥0.70 with
 * ≥30 distinct items and ≥10 % development coverage (beta: ≥2 participants). Otherwise the default
 * 0.65, marked unmet — never "achieved at 0.85".
 */
export function selectForYou(
  pool: readonly WeightedPoolItem[],
  profile: Profile,
): ThresholdDecision {
  const rows = grid(50, 85).map((t) => {
    const row = evaluateSlice(
      pool,
      pool.filter((i) => i.p >= t),
      t,
    );
    const ok =
      row.likeRate !== null &&
      atLeast(row.likeRate, FOR_YOU_MIN_PRECISION) &&
      row.distinctItems >= MIN_DISTINCT_ITEMS &&
      atLeast(row.coverage, MIN_FOR_YOU_COVERAGE) &&
      row.participants >= minParticipants(profile);
    return { ...row, ok };
  });
  const chosen = rows.find((row) => row.ok);
  return chosen === undefined
    ? { value: DEFAULT_RANKER_CONFIG.lanes.forYou, status: 'unmet', rows }
    : { value: chosen.t, status: 'selected', rows };
}

/**
 * `lanes.maybe`: the largest t on 0.20…0.50 below `forYou` whose weighted like-rate among P < t is
 * ≤0.15 with ≥30 distinct items (beta: ≥2 participants). Otherwise the default 0.35 (or the largest
 * grid point below `forYou`), marked unmet.
 */
export function selectMaybe(
  pool: readonly WeightedPoolItem[],
  forYou: number,
  profile: Profile,
): ThresholdDecision {
  const rows = grid(20, 50)
    .filter((t) => t < forYou - EPS)
    .map((t) => {
      const row = evaluateSlice(
        pool,
        pool.filter((i) => i.p < t),
        t,
      );
      const ok =
        row.likeRate !== null &&
        atMost(row.likeRate, MAYBE_MAX_LIKE_RATE) &&
        row.distinctItems >= MIN_DISTINCT_ITEMS &&
        row.participants >= minParticipants(profile);
      return { ...row, ok };
    });
  const chosen = [...rows].reverse().find((row) => row.ok);
  if (chosen !== undefined) return { value: chosen.t, status: 'selected', rows };
  const fallback =
    DEFAULT_RANKER_CONFIG.lanes.maybe < forYou - EPS
      ? DEFAULT_RANKER_CONFIG.lanes.maybe
      : (grid(20, 50)
          .filter((t) => t < forYou - EPS)
          .pop() ?? 0.2);
  return { value: fallback, status: 'unmet', rows };
}

export type Tiers = [number, number, number, number];
export const TIER_LEVELS = [0.2, 0.4, 0.6, 0.8] as const;
export const MAX_DEFAULT_ECE = 0.1;

export interface TierDecision {
  value: Tiers;
  status: 'calibrated' | 'isotonic' | 'fallback' | 'unmeasured';
  ece: number | null;
  /** The isotonic cuts (null where no block reaches the level). */
  cuts: (number | null)[] | null;
}

const DEFAULT_TIERS = [...DEFAULT_RANKER_CONFIG.tiers] as Tiers;

/**
 * `tiers`: keep the defaults when the development ECE is ≤0.10. Otherwise a weighted isotonic
 * regression of like-rate on raw score gives the smallest score reaching 0.2/0.4/0.6/0.8; all four
 * must exist and be strictly increasing in (0, 1), else every default is kept (the isotonic
 * fallback). Tier boundaries only: stored scores are never transformed.
 */
export function selectTiers(pool: readonly WeightedPoolItem[]): TierDecision {
  const ece = calibration(pool.map((i) => ({ p: i.p, positive: i.liked, weight: i.weight }))).ece;
  if (ece === null) return { value: DEFAULT_TIERS, status: 'unmeasured', ece, cuts: null };
  if (atMost(ece, MAX_DEFAULT_ECE))
    return { value: DEFAULT_TIERS, status: 'calibrated', ece, cuts: null };
  const blocks = isotonicRegression(
    pool.map((i) => ({ x: i.p, y: i.liked ? 1 : 0, weight: i.weight })),
  );
  // Rounded to 4 decimals for the settings file; validity is checked after rounding.
  const cuts = TIER_LEVELS.map((level) => {
    const cut = smallestScoreReaching(blocks, level);
    return cut === null ? null : Math.round(cut * 10_000) / 10_000;
  });
  const valid =
    cuts.every((c): c is number => c !== null && c > 0 && c < 1) &&
    cuts.every((c, i) => i === 0 || (cuts[i - 1] as number) < (c as number));
  return valid
    ? { value: cuts as Tiers, status: 'isotonic', ece, cuts }
    : { value: DEFAULT_TIERS, status: 'fallback', ece, cuts };
}

// ── Step 4: demotion cutoffs ────────────────────────────────────────────────────────────────

export const DEMOTION_MIN_FLAGGED = 20;
export const DEMOTION_MIN_PRECISION = 0.8;

export interface DemotionDecision {
  flag: DemotionFlag;
  value: number;
  default: number;
  status: 'selected' | 'unmet' | 'unmeasured';
  candidates: CutoffResult[];
}

/**
 * A demotion cutoff from adjudicated development facet labels (spec 10 §5 step 4). A candidate
 * counts only when it flags ≥20 articles. `clickbait`, `promotional` and `staleTimeSensitive` take
 * the smallest counted t on 0.50…0.95 with precision ≥0.80 against *yes*; `shallowDepth` the
 * largest counted t on 0.10…0.50 with precision ≥0.80 against a labelled depth ≤1. Without one the
 * default stays, unmet when some candidate was counted, unmeasured when none was.
 */
export function selectDemotionCutoff(
  flag: DemotionFlag,
  samples: readonly FlagSample[],
): DemotionDecision {
  const shallow = flag === 'shallowDepth';
  const fallback = DEFAULT_RANKER_CONFIG.demotion[flag];
  const points = shallow ? grid(10, 50) : grid(50, 95);
  const candidates = points.map((t) =>
    precisionRecallAtCutoff(samples, t, shallow ? 'lte' : 'gte'),
  );
  const counted = candidates.filter((c) => c.flagged >= DEMOTION_MIN_FLAGGED);
  const passing = counted.filter(
    (c) => c.precision !== null && atLeast(c.precision, DEMOTION_MIN_PRECISION),
  );
  const chosen = shallow ? passing[passing.length - 1] : passing[0];
  if (chosen !== undefined) {
    return { flag, value: chosen.cutoff, default: fallback, status: 'selected', candidates };
  }
  return {
    flag,
    value: fallback,
    default: fallback,
    status: counted.length > 0 ? 'unmet' : 'unmeasured',
    candidates,
  };
}

// ── Confirmation on the test split ──────────────────────────────────────────────────────────

export const PASS_MIN_GAIN = 0.05;
export const PASS_MIN_AUC = 0.7;

export interface ConfirmationInput {
  macro: number | null;
  baselineMacro: number | null;
  /** Every actual participant of the profile: test AUC of the composition and of the baseline. */
  participants: ReadonlyMap<string, { candidate: number | null; baseline: number | null }>;
}

export interface ConfirmationDecision {
  status: GateStatus;
  reasons: string[];
}

/**
 * Pass requires test macro AUC ≥ baseline + 0.05, macro AUC ≥ 0.70 and a higher AUC than the
 * baseline for every actual participant (point estimates). A participant or macro without a
 * supported test AUC is `needs_more_data`, never a pass.
 */
export function confirmGate(input: ConfirmationInput): ConfirmationDecision {
  const reasons: string[] = [];
  if (input.macro === null || input.baselineMacro === null) {
    return { status: 'needs_more_data', reasons: ['no supported test macro AUC'] };
  }
  if (input.participants.size === 0) {
    return { status: 'needs_more_data', reasons: ['no participant'] };
  }
  for (const [key, value] of input.participants) {
    if (value.candidate === null || value.baseline === null) {
      return {
        status: 'needs_more_data',
        reasons: [`participant ${key} has no supported test AUC`],
      };
    }
  }
  if (!atLeast(input.macro, input.baselineMacro + PASS_MIN_GAIN)) {
    reasons.push(
      `macro AUC ${input.macro.toFixed(3)} < baseline ${input.baselineMacro.toFixed(3)} + 0.05`,
    );
  }
  if (!atLeast(input.macro, PASS_MIN_AUC)) {
    reasons.push(`macro AUC ${input.macro.toFixed(3)} < 0.70`);
  }
  for (const [key, value] of input.participants) {
    if (!((value.candidate as number) > (value.baseline as number))) {
      reasons.push(`participant ${key} does not beat the baseline`);
    }
  }
  return { status: reasons.length === 0 ? 'pass' : 'fail', reasons };
}

// ── Budget ──────────────────────────────────────────────────────────────────────────────────

/**
 * `recommended_daily_budget_usd` (spec 10 §5 "Budget"): measured $/1,000 authorized uncached
 * article revisions × (expected daily authorized revisions ÷ 1000) × 2, rounded up to the next
 * $0.50, minimum $1/day. The ÷1000 divisor is never dropped. Unmeasured cost → the $1 minimum.
 */
export function recommendDailyBudget(
  costPer1000Usd: number | null,
  dailyRevisions: number,
): { value: number; status: 'measured' | 'unmeasured' } {
  if (costPer1000Usd === null || !Number.isFinite(costPer1000Usd)) {
    return { value: 1, status: 'unmeasured' };
  }
  const raw = costPer1000Usd * (dailyRevisions / 1000) * 2;
  const rounded = Math.ceil(raw * 2 - EPS) / 2;
  return { value: Math.max(1, rounded), status: 'measured' };
}
