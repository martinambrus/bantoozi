import { readStoredSetting, type Executor } from '@bantoozi/db';
import { resolveRankerSettings, type RankerSettings } from '@bantoozi/ranker';

/**
 * The settings override loader of the rank handler (spec 06 §7, §11): reads
 * `settings['ranker.thresholds']` and `settings['ranker.settings_version']` and resolves them with
 * the shared `RankerConfig` (missing rows mean the defaults and version 0). A malformed stored value
 * throws `RankerSettingsError`, so the job fails visibly instead of ranking with silently changed
 * thresholds.
 */
export async function loadRankerSettings(db: Executor): Promise<RankerSettings> {
  const thresholds = await readStoredSetting(db, 'ranker.thresholds');
  const settingsVersion = await readStoredSetting(db, 'ranker.settings_version');
  return resolveRankerSettings({ thresholds, settingsVersion });
}
