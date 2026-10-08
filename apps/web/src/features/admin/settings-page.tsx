import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  type AdminSettings,
  type AdminSettingsPatchResult,
} from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

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

  function adopt(result: AdminSettingsPatchResult) {
    const { values, stored, rankerSettingsVersion } = result;
    queryClient.setQueryData<AdminSettings>(adminKey('settings'), {
      values,
      stored,
      rankerSettingsVersion,
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
                  onSaved={adopt}
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
