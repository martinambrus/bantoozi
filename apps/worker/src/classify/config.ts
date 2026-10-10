import {
  loadActiveQuestionSets,
  readStoredSetting,
  shareLockSettings,
  type Executor,
  type QuestionSetKind,
} from '@bantoozi/db';
import { languageModeFor, questionSetByVersion, type Question } from '@bantoozi/questions';
import {
  parseSetting,
  readSetting,
  settingDefault,
  type CardTextMode,
  type LanguageModes,
  type SettingEnvDefaults,
} from '@bantoozi/shared';

/**
 * The classification configuration a job reads once for its snapshot (spec 05 §5.5 step 2): the
 * active question sets, card text mode, language modes and the prefilter flag. A completion
 * compares the configuration it read inside its transaction with the job's snapshot and discards
 * results asked under a configuration that changed meanwhile (spec 05 §5.5 step 6). It reads them
 * under share locks, so a switch either waits for the completion to commit or is seen by it (D-84).
 * A compared key without a row is first stored with its default, so that its first write is fenced
 * as well.
 */

/** The settings a completion compares with its snapshot. */
const CLASSIFICATION_SETTING_KEYS = [
  'question_sets.active',
  'card_text_mode',
  'language_modes',
  'engine.prefilter_enabled',
] as const;

/** An active stored set whose version this worker's code builds, with the same sha (spec 05 §2). */
export interface ActiveQuestionSet {
  id: string;
  version: string;
  sha256: string;
}

export interface ClassificationConfig {
  enrich: ActiveQuestionSet | null;
  match: ActiveQuestionSet | null;
  cluster: ActiveQuestionSet | null;
  cardTextMode: CardTextMode;
  languageModes: LanguageModes;
  prefilterEnabled: boolean;
}

/**
 * An active set this worker cannot ask as stored: its version is unknown to the code or its sha
 * differs from the code's definition (a deploy/seed mismatch the startup check also reports).
 */
export class QuestionSetMismatchError extends Error {
  constructor(
    readonly kind: QuestionSetKind,
    readonly version: string,
  ) {
    super(`Active ${kind} question set ${version} does not match this worker's code`);
    this.name = 'QuestionSetMismatchError';
  }
}

/** A stored set verified against the code definition of its version. */
export function verifiedSet(
  kind: QuestionSetKind,
  row: { id: string; version: string; sha256: string } | undefined,
): ActiveQuestionSet | null {
  if (row === undefined) return null;
  const code = questionSetByVersion(row.version);
  if (code === undefined || code.kind !== kind || code.sha256 !== row.sha256) {
    throw new QuestionSetMismatchError(kind, row.version);
  }
  return { id: row.id, version: row.version, sha256: row.sha256 };
}

/** The verified active `suggest` set (spec 05 §7), or null when none is active. */
export async function loadSuggestSet(db: Executor): Promise<ActiveQuestionSet | null> {
  return verifiedSet('suggest', (await loadActiveQuestionSets(db)).suggest);
}

/** No active set of a kind the stage needs: the seed has not run (the startup check reports it). */
export class QuestionSetInactiveError extends Error {
  constructor(readonly kind: QuestionSetKind) {
    super(`No active ${kind} question set`);
    this.name = 'QuestionSetInactiveError';
  }
}

export function requireSet(
  set: ActiveQuestionSet | null,
  kind: QuestionSetKind,
): ActiveQuestionSet {
  if (set === null) throw new QuestionSetInactiveError(kind);
  return set;
}

/** The static questions of the active enrich set (spec 05 §3.3). */
export function enrichQuestions(set: ActiveQuestionSet): Record<string, Question> {
  const code: unknown = questionSetByVersion(set.version);
  if (typeof code !== 'object' || code === null || !('questions' in code)) {
    throw new QuestionSetMismatchError('enrich', set.version);
  }
  return (code as { questions: Record<string, Question> }).questions;
}

/**
 * `lock` (a completion's transaction): share-lock the settings first, so the values read stay
 * current until commit. A missing key is stored with the default it reads as (D-84).
 */
export async function loadClassificationConfig(
  db: Executor,
  env: SettingEnvDefaults,
  options: { lock?: boolean } = {},
): Promise<ClassificationConfig> {
  if (options.lock === true) {
    await shareLockSettings(
      db,
      CLASSIFICATION_SETTING_KEYS.map((key) => ({
        key,
        initial: parseSetting(key, settingDefault(key, env)),
      })),
    );
  }
  const sets = await loadActiveQuestionSets(db);
  const cardTextMode =
    readSetting('card_text_mode', await readStoredSetting(db, 'card_text_mode'), env) ??
    'as_written';
  const languageModes =
    readSetting('language_modes', await readStoredSetting(db, 'language_modes'), env) ?? {};
  const prefilterEnabled =
    readSetting(
      'engine.prefilter_enabled',
      await readStoredSetting(db, 'engine.prefilter_enabled'),
      env,
    ) ?? false;
  return {
    enrich: verifiedSet('enrich', sets.enrich),
    match: verifiedSet('match', sets.match),
    cluster: verifiedSet('cluster', sets.cluster),
    cardTextMode,
    languageModes,
    prefilterEnabled,
  };
}

/** The language mode of an article language; an unknown language is native (spec 05 §3.1). */
export function languageModeOf(
  config: ClassificationConfig,
  lang: string | null,
): 'native' | 'translate' {
  return languageModeFor(config.languageModes, lang);
}

/** Whether a completion may still apply a Call A result read under `snapshot` (spec 05 §5.5 step 6). */
export function sameEnrichConfig(
  snapshot: ClassificationConfig,
  current: ClassificationConfig,
  lang: string | null,
): boolean {
  return (
    snapshot.enrich?.sha256 === current.enrich?.sha256 &&
    snapshot.enrich?.id === current.enrich?.id &&
    languageModeOf(snapshot, lang) === languageModeOf(current, lang)
  );
}

/**
 * Whether a cluster fold decided under `snapshot` may still be applied (spec 05 §6): the candidates
 * were eligible by their current facets of the enrich set, and the decision answered the cluster set.
 */
export function sameClusterConfig(
  snapshot: ClassificationConfig,
  current: ClassificationConfig,
): boolean {
  return (
    snapshot.enrich?.sha256 === current.enrich?.sha256 &&
    snapshot.enrich?.id === current.enrich?.id &&
    snapshot.cluster?.sha256 === current.cluster?.sha256 &&
    snapshot.cluster?.id === current.cluster?.id
  );
}

/** Whether a completion may still apply a Call B result read under `snapshot`. */
export function sameMatchConfig(
  snapshot: ClassificationConfig,
  current: ClassificationConfig,
  lang: string | null,
): boolean {
  return (
    sameEnrichConfig(snapshot, current, lang) &&
    snapshot.match?.sha256 === current.match?.sha256 &&
    snapshot.match?.id === current.match?.id &&
    snapshot.cardTextMode === current.cardTextMode &&
    snapshot.prefilterEnabled === current.prefilterEnabled
  );
}
