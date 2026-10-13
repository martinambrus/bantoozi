import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  RUNTIME_SETTING_KEYS,
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
import { Hint, PageTitle, SectionTitle } from './admin-ui.js';
import { RuntimeEditor } from './runtime-editor.js';
import { RUNTIME_GROUPS } from './runtime-fields.js';
import { SettingEditor } from './setting-editor.js';
import { useAdminKey, useRefresh } from './use-admin.js';
import { WorkersStatus } from './workers-status.js';

const isRuntimeKey = (key: string): boolean =>
  (RUNTIME_SETTING_KEYS as readonly string[]).includes(key);
const BASE_KEYS = ADMIN_PATCHABLE_SETTING_KEYS.filter((key) => !isRuntimeKey(key));

type Workers = AdminSettings['workers'];

/** Per process, the entry of the newer heartbeat; on a tie a pending restart stays pending. */
function mergeWorkers(current: Workers, incoming: Workers): Workers {
  const merged = new Map(current.map((worker) => [worker.processId, worker]));
  for (const worker of incoming) {
    const have = merged.get(worker.processId);
    if (have === undefined || worker.at > have.at) merged.set(worker.processId, worker);
    else if (worker.at === have.at && worker.pendingRestart && !have.pendingRestart)
      merged.set(worker.processId, worker);
  }
  return [...merged.values()];
}

export function AdminSettingsPage() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const api = useApi();
  const queryClient = useQueryClient();
  const adminKey = useAdminKey();
  const refresh = useRefresh();

  const settings = useQuery({
    queryKey: adminKey('settings'),
    queryFn: ({ signal }) => api.call(routes.adminSettingsGet, undefined, { signal }),
  });

  /**
   * Takes what one editor saved from the answer: the key's value, source, default and stored time,
   * and the ranker settings version once that is newer. Saves of two editors can answer in another
   * order than they were made, each with all the settings as they stood then, so nothing outside
   * the saved key is taken from an answer. The workers' status is merged per process, the newer
   * heartbeat winning (a worker that waits for a restart keeps waiting until its process is gone),
   * so an older answer cannot take back what a newer one reported.
   */
  function adopt(key: AdminSettingKey, result: AdminSettingsPatchResult) {
    const { values, stored, rankerSettingsVersion, sources, defaults, workers } = result;
    writeQueryData<AdminSettings>(queryClient, adminKey('settings'), (current) => {
      if (current === undefined)
        return { values, stored, rankerSettingsVersion, sources, defaults, workers };
      const saved = stored.filter((entry) => entry.key === key);
      const own = <T,>(map: Record<string, T>): Record<string, T> =>
        key in map ? { [key]: map[key] as T } : {};
      return {
        values: { ...current.values, [key]: values[key] },
        stored: [...current.stored.filter((entry) => entry.key !== key), ...saved],
        rankerSettingsVersion: Math.max(current.rankerSettingsVersion, rankerSettingsVersion),
        sources: { ...current.sources, ...own(sources) },
        defaults: { ...current.defaults, ...own(defaults) },
        workers: mergeWorkers(current.workers, workers),
      };
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.settings')}</PageTitle>
      <Hint>{t('settings.intro')}</Hint>
      {settings.status === 'pending' && settings.fetchStatus !== 'paused' ? (
        // Not a role=status region: the workers status below is the one status of this screen.
        <p aria-live="polite" aria-busy="true" className="py-8 text-center text-sm">
          {tc('states.loading')}
        </p>
      ) : (
        <QueryState query={settings}>
          {(data) => (
            <>
              <Hint>{t('settings.rankerVersion', { value: data.rankerSettingsVersion })}</Hint>
              <div className="flex flex-col gap-4">
                {BASE_KEYS.map((key) => (
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
              <WorkersStatus workers={data.workers} />
              {RUNTIME_GROUPS.map((group) => (
                <section
                  key={group.id}
                  role="group"
                  aria-label={t(`settings.groups.${group.id}`)}
                  className="flex flex-col gap-4"
                >
                  <SectionTitle>{t(`settings.groups.${group.id}`)}</SectionTitle>
                  {group.keys.map((key) => (
                    <RuntimeEditor
                      key={key}
                      settingKey={key}
                      value={data.values[key]}
                      defaultValue={data.defaults[key] ?? null}
                      source={data.sources[key] ?? 'env'}
                      hasStoredRow={data.stored.some((entry) => entry.key === key)}
                      problems={[
                        ...new Set(
                          data.workers.flatMap((worker) =>
                            worker.problems.filter((p) => p.key === key).map((p) => p.message),
                          ),
                        ),
                      ]}
                      onSaved={(result) => adopt(key, result)}
                      onStale={() => void refresh('settings')}
                    />
                  ))}
                </section>
              ))}
            </>
          )}
        </QueryState>
      )}
    </div>
  );
}
