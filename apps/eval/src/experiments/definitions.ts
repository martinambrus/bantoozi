/**
 * The experiments of spec 10 §3, one config object each. A definition says what a run computes
 * (the score source), which state and card text variant it uses, which provider calls it makes and
 * whether it may read test data. The runner (`runner.ts`) is generic over these objects; only E6
 * and E7 add their own steps on top of the E1 run they build on.
 */

export const EXPERIMENT_IDS = [
  'B0',
  'B1',
  'B1-T',
  'E1',
  'E2',
  'E3',
  'E3b',
  'E4',
  'E5',
  'E6',
  'E7',
] as const;

export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

/** The article state a run sends or scores: none (B0), native text, or a frozen translation. */
export type StateVariantId = 'none' | 'native' | 'lt' | 'glm';

/**
 * Card text: as written, translated to English by LibreTranslate, or the global card mode selected
 * on development (E4 runs with whichever mode §5 step 2 chose; `--card-mode` passes it).
 */
export type CardVariantId = 'as_written' | 'english' | 'selected';

/** The zero-training score of spec 10 §3 "Per article and rater". */
export type ScoreSource = 'chrono' | 'bm25' | 'cards';

export interface ExperimentDefinition {
  id: ExperimentId;
  title: string;
  purpose: string;
  score: ScoreSource;
  variant: { state: StateVariantId; cards: CardVariantId };
  /**
   * The pinned decision engine (spec 04 §1 "Eval routers"): every Call A/B answer comes from it
   * and a failure stays a missing observation, never a fallback answer. Null: no engine calls.
   */
  engine: 'typesafe' | 'laya' | null;
  /** Article translations (spec 07 tiers) and card text translation this run makes. */
  translation: { articles: 'libretranslate' | 'ollama' | null; cards: 'libretranslate' | null };
  /** Languages the experiment covers when `--langs` is not given (E4 is SK/CZ only). */
  defaultLangs: readonly string[] | null;
  /** Development split only (E6, E7): never reads test data. */
  developmentOnly: boolean;
  /** A gate input of spec 10 §5 (E4/E5 are diagnostics, E6/E7 informational). */
  gateInput: boolean;
  /** The run it builds on (E6/E7 use the frozen E1 state and answers). */
  baseExperiment: ExperimentId | null;
  /** A stub that records `status: 'skipped'` with this reason instead of running. */
  skipReason: string | null;
}

const base = {
  translation: { articles: null, cards: null },
  defaultLangs: null,
  developmentOnly: false,
  gateInput: true,
  baseExperiment: null,
  skipReason: null,
} as const satisfies Partial<ExperimentDefinition>;

export const EXPERIMENTS: Readonly<Record<ExperimentId, ExperimentDefinition>> = Object.freeze({
  B0: {
    ...base,
    id: 'B0',
    title: 'chrono',
    purpose: 'baseline: newer = higher',
    score: 'chrono',
    variant: { state: 'none', cards: 'as_written' },
    engine: null,
  },
  B1: {
    ...base,
    id: 'B1',
    title: 'BM25',
    purpose: 'keyword baseline (spec 06 §9)',
    score: 'bm25',
    variant: { state: 'native', cards: 'as_written' },
    engine: null,
  },
  'B1-T': {
    ...base,
    id: 'B1-T',
    title: 'translated BM25',
    purpose: 'controls for translation improving the keyword baseline too',
    score: 'bm25',
    variant: { state: 'lt', cards: 'english' },
    engine: null,
    translation: { articles: 'libretranslate', cards: 'libretranslate' },
  },
  E1: {
    ...base,
    id: 'E1',
    title: 'native',
    purpose: 'the core bet in its simplest form',
    score: 'cards',
    variant: { state: 'native', cards: 'as_written' },
    engine: 'typesafe',
  },
  E2: {
    ...base,
    id: 'E2',
    title: 'native + EN cards',
    purpose: 'does English card text help?',
    score: 'cards',
    variant: { state: 'native', cards: 'english' },
    engine: 'typesafe',
    translation: { articles: null, cards: 'libretranslate' },
  },
  E3: {
    ...base,
    id: 'E3',
    title: 'LT',
    purpose: 'free translation',
    score: 'cards',
    variant: { state: 'lt', cards: 'as_written' },
    engine: 'typesafe',
    translation: { articles: 'libretranslate', cards: null },
  },
  E3b: {
    ...base,
    id: 'E3b',
    title: 'LT + EN cards',
    purpose: 'both',
    score: 'cards',
    variant: { state: 'lt', cards: 'english' },
    engine: 'typesafe',
    translation: { articles: 'libretranslate', cards: 'libretranslate' },
  },
  E4: {
    ...base,
    id: 'E4',
    title: 'GLM',
    purpose: 'measured alternative for the fallback translation (SK/CZ only)',
    score: 'cards',
    variant: { state: 'glm', cards: 'selected' },
    engine: 'typesafe',
    translation: { articles: 'ollama', cards: 'libretranslate' },
    defaultLangs: ['sk', 'cs'],
    gateInput: false,
  },
  E5: {
    ...base,
    id: 'E5',
    title: 'Laya zero-shot',
    purpose: 'measured M9 baseline without assuming an outcome',
    score: 'cards',
    variant: { state: 'native', cards: 'as_written' },
    engine: 'laya',
    gateInput: false,
    skipReason: 'laya is not installed (M9 optional extension); E5 is skipped',
  },
  E6: {
    ...base,
    id: 'E6',
    title: 'card examples',
    purpose: "does a rating-derived example improve Jev's card answers? (informational)",
    score: 'cards',
    variant: { state: 'native', cards: 'as_written' },
    engine: 'typesafe',
    developmentOnly: true,
    gateInput: false,
    baseExperiment: 'E1',
  },
  E7: {
    ...base,
    id: 'E7',
    title: 'steering text',
    purpose: 'how far text inside an article moves card answers (spec 04 §10.1)? (informational)',
    score: 'cards',
    variant: { state: 'native', cards: 'as_written' },
    engine: 'typesafe',
    developmentOnly: true,
    gateInput: false,
    baseExperiment: 'E1',
  },
});

export function isExperimentId(value: string): value is ExperimentId {
  return (EXPERIMENT_IDS as readonly string[]).includes(value);
}

export function experimentDefinition(id: ExperimentId): ExperimentDefinition {
  return EXPERIMENTS[id];
}

/** The experiments a replay can re-run with a proposed change (spec 10 §6): Call B scorers. */
export const REPLAYABLE_EXPERIMENTS: readonly ExperimentId[] = ['E1', 'E2', 'E3', 'E3b', 'E4'];

/**
 * The keyword baseline a first enablement of `LLM_FALLBACK_ENABLED` replays against (spec 10 §6:
 * "or against the B1 keyword baseline for a first enablement"): only with `--engine llm`, whose
 * replay side is the fallback classifier on E1's variant (native text, cards as written).
 */
export const KEYWORD_BASELINE_EXPERIMENT: ExperimentId = 'B1';
export const KEYWORD_BASELINE_REPLAY: ExperimentId = 'E1';
