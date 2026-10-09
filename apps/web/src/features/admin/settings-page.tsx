import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  type AdminSettingKey,
  type AdminSettings,
  type AdminSettingsPatchResult,
} from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { QueryState } from '../../components/states/query-state.js';
import { Hint, PageTitle } from './admin-ui.js';
import { SettingEditor } from './setting-editor.js';
import { useAdminKey, useRefresh } from './use-admin.js';

export function AdminSettingsPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const queryClient = useQueryClient();
  const adminKey = useAdminKey();
  const refresh = useRefresh();

  const settings = useQuery({
    queryKey: adminKey('settings'),
    queryFn: ({ signal }) => api.call(routes.adminSettingsGet, undefined, { signal }),
  });

  /**
   * Takes what one editor saved from the answer: the value of its key, when it was stored, and the
   * ranker settings version once that is newer. Saves of two editors can answer in another order
   * than they were made, each with all the settings as they stood then, so the rest of an answer
   * can be older than the screen.
   */
  function adopt(key: AdminSettingKey, result: AdminSettingsPatchResult) {
    const { values, stored, rankerSettingsVersion } = result;
    writeQueryData<AdminSettings>(queryClient, adminKey('settings'), (current) => {
      if (current === undefined) return { values, stored, rankerSettingsVersion };
      const saved = stored.filter((entry) => entry.key === key);
      return {
        values: { ...current.values, [key]: values[key] },
        stored: [...current.stored.filter((entry) => entry.key !== key), ...saved],
        rankerSettingsVersion: Math.max(current.rankerSettingsVersion, rankerSettingsVersion),
      };
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.settings')}</PageTitle>
      <Hint>{t('settings.intro')}</Hint>
      <QueryState query={settings}>
        {(data) => (
          <>
            <Hint>{t('settings.rankerVersion', { value: data.rankerSettingsVersion })}</Hint>
            <div className="flex flex-col gap-4">
              {ADMIN_PATCHABLE_SETTING_KEYS.map((key) => (
                <SettingEditor
                  key={key}
                  settingKey={key}
                  value={data.values[key]}
                  storedAt={data.stored.find((entry) => entry.key === key)?.updatedAt ?? null}
                  onSaved={(result) => adopt(key, result)}
                  onStale={() => void refresh('settings')}
                />
              ))}
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
