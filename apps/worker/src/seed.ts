import { pathToFileURL } from 'node:url';

import {
  checkQuestionSets,
  createDatabase,
  createPool,
  insertSettingIfMissing,
  seedLibraryCards,
  seedQuestionSets,
  seedTopics,
  type Database,
  type Executor,
  type LibraryCardSeed,
  type LibrarySeedOutcome,
  type QuestionSetSeedResult,
  type TopicSeedResult,
  type Transaction,
} from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  loadLibraryCards,
  taxonomyTopicRows,
  type LibraryCardEntry,
  type QuestionSetDefinition,
  type QuestionSetKind,
  type TopicRow,
} from '@bantoozi/questions';
import {
  SEEDED_SETTING_KEYS,
  parseSetting,
  settingDefault,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

/**
 * `pnpm db:seed` (spec 02 §2): inserts only `card_text_mode`, `question_sets.active = {}` and
 * `language_modes` (from `LANGUAGE_MODES`) when they are missing, then runs the content hooks: the
 * topic taxonomy (spec 05 §3.2), the immutable question sets (§2) and the public card library (§8).
 * It never overwrites a stored setting, and every hook is idempotent, so running it again — even
 * with another `LANGUAGE_MODES` — changes nothing. Deploys run it after the migrate job and before
 * the services start; the whole seed is one transaction.
 */

/** Seed content hooks, run in this order inside the seed transaction. */
export interface SeedHooks {
  /** Topics (spec 05 §3.2); the database rejects a level-2 topic without a level-1 parent. */
  taxonomy?: (tx: Transaction) => Promise<TopicSeedResult | void>;
  /** Immutable question sets; may fill absent kinds of `question_sets.active` (spec 05 §2). */
  questionSets?: (tx: Transaction) => Promise<QuestionSetSeedResult | void>;
  /** The reviewed public card library (spec 05 §8); after the taxonomy, which cards reference. */
  library?: (tx: Transaction) => Promise<LibrarySeedOutcome[] | void>;
}

export interface SeedResult {
  /** Setting keys this run inserted (empty when every key already existed). */
  insertedSettings: string[];
  /** What the taxonomy hook reported. */
  topics?: TopicSeedResult;
  /** What the question-set hook reported. */
  questionSets?: QuestionSetSeedResult;
  /** One outcome per library entry; `held` entries were reported, not applied. */
  library?: LibrarySeedOutcome[];
}

export async function runSeed(
  db: Database,
  env: SettingEnvDefaults,
  hooks: SeedHooks = {},
): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const insertedSettings: string[] = [];
    for (const key of SEEDED_SETTING_KEYS) {
      const value = parseSetting(key, settingDefault(key, env));
      if (await insertSettingIfMissing(tx, key, value)) insertedSettings.push(key);
    }
    const topics = await hooks.taxonomy?.(tx);
    const questionSets = await hooks.questionSets?.(tx);
    const library = await hooks.library?.(tx);
    return {
      insertedSettings,
      ...(topics ? { topics } : {}),
      ...(questionSets ? { questionSets } : {}),
      ...(library ? { library } : {}),
    };
  });
}

/** Seed content; each part defaults to what the code ships (tests pass variations). */
export interface SeedContent {
  topics?: readonly TopicRow[];
  questionSets?: readonly QuestionSetDefinition[];
  /** The version each kind is activated with when `question_sets.active` has no set of that kind. */
  activeVersions?: Partial<Record<QuestionSetKind, string>>;
  library?: readonly LibraryCardEntry[];
}

/** The newest set version of every kind: what an absent kind is activated with. */
export function latestQuestionSetVersions(): Record<QuestionSetKind, string> {
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  return versions;
}

/** A library entry (spec 05 §8) as the seed stores it: `i18n.sk` from the `*_sk` fields. */
export function libraryCardSeed(entry: LibraryCardEntry): LibraryCardSeed {
  return {
    slug: entry.slug,
    title: entry.title,
    interest: entry.interest,
    notFor: entry.not_for ?? null,
    examplesYes: entry.examples_yes ?? null,
    examplesNo: entry.examples_no ?? null,
    topicIds: entry.topic_ids,
    i18n: {
      sk: {
        title: entry.title_sk,
        ...(entry.interest_sk === undefined ? {} : { interest: entry.interest_sk }),
      },
    },
  };
}

/** The M2 content hooks: taxonomy, question sets (activating absent kinds) and the card library. */
export function defaultSeedHooks(content: SeedContent = {}): Required<SeedHooks> {
  return {
    taxonomy: (tx) => seedTopics(tx, content.topics ?? taxonomyTopicRows()),
    questionSets: (tx) =>
      seedQuestionSets(
        tx,
        content.questionSets ?? ALL_QUESTION_SETS,
        content.activeVersions ?? latestQuestionSetVersions(),
      ),
    library: (tx) =>
      seedLibraryCards(tx, (content.library ?? loadLibraryCards()).map(libraryCardSeed)),
  };
}

/** How many library entries ended in each outcome. */
export function librarySeedSummary(
  outcomes: readonly LibrarySeedOutcome[],
): Record<LibrarySeedOutcome['status'], number> {
  const summary = { inserted: 0, adopted: 0, updated: 0, versioned: 0, unchanged: 0, held: 0 };
  for (const outcome of outcomes) summary[outcome.status] += 1;
  return summary;
}

/** Stored question sets that disagree with the code (see {@link verifyQuestionSets}). */
export class QuestionSetMismatchError extends Error {
  override readonly name = 'QuestionSetMismatchError';

  constructor(readonly problems: readonly string[]) {
    super(`stored question sets do not match the code: ${problems.join('; ')}`);
  }
}

/**
 * The worker's startup check (spec 05 §2): every set the code defines is stored under its version
 * with the same kind and sha256, and every active set is one the code knows. Throws
 * {@link QuestionSetMismatchError} listing the problems — a missing set means `pnpm db:seed` has not
 * run, a different hash means wording changed without a new version.
 */
export async function verifyQuestionSets(
  db: Executor,
  sets: readonly QuestionSetDefinition[] = ALL_QUESTION_SETS,
): Promise<void> {
  const problems = await checkQuestionSets(db, sets);
  if (problems.length > 0) throw new QuestionSetMismatchError(problems);
}

async function main(): Promise<void> {
  const config = loadConfig({ process: 'worker' });
  const logger = createLogger({ name: 'seed', level: config.logLevel });
  const pool = createPool({
    connectionString: config.databaseUrlWorker,
    max: 1,
    applicationName: 'bantoozi-seed',
  });
  try {
    const result = await runSeed(
      createDatabase(pool),
      {
        dailyBudgetUsd: config.dailyBudgetUsd,
        languageModes: config.languageModes,
        signupMode: config.signupMode,
      },
      defaultSeedHooks(),
    );
    const library = result.library ?? [];
    for (const outcome of library) {
      if (outcome.status === 'held') {
        logger.warn(outcome, 'library entry held: an administrator must resolve it');
      }
    }
    logger.info(
      {
        insertedSettings: result.insertedSettings,
        topics: result.topics,
        questionSets: result.questionSets,
        library: librarySeedSummary(library),
      },
      'seed finished',
    );
  } catch (error) {
    logger.error({ err: error }, 'seed failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
