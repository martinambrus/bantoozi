import { readStoredSetting, type TenantTx } from '@bantoozi/db';
import { scoreVersion } from '@bantoozi/ranker';
import { parseStoredSetting } from '@bantoozi/shared';

/** `scoreVersion()` of the stored `ranker.settings_version` (spec 06 §7); 0 when never written. */
export async function currentScoreVersion(tx: TenantTx): Promise<string> {
  const stored = await readStoredSetting(tx, 'ranker.settings_version');
  return scoreVersion(
    stored === undefined ? 0 : parseStoredSetting('ranker.settings_version', stored),
  );
}
