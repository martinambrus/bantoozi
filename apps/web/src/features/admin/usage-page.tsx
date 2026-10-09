import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Select } from '../../components/select.js';
import { QueryState } from '../../components/states/query-state.js';
import { Cell, DataTable, Hint, PageTitle, RowHeader, SectionTitle } from './admin-ui.js';
import { useFormat } from './format.js';
import { DEFAULT_USAGE_PERIOD, USAGE_PERIODS } from './search.js';
import { UsageChart, dailyCosts } from './usage-chart.js';
import { useAdminKey } from './use-admin.js';

const route = getRouteApi('/_authed/_app/admin/usage');

export function AdminUsagePage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const adminKey = useAdminKey();
  const format = useFormat();
  const { days = DEFAULT_USAGE_PERIOD } = route.useSearch();
  const navigate = route.useNavigate();

  const usage = useQuery({
    queryKey: adminKey('usage', days),
    queryFn: ({ signal }) => api.call(routes.adminUsage, { query: { days } }, { signal }),
  });

  function selectPeriod(value: string) {
    const period = USAGE_PERIODS.find((candidate) => String(candidate) === value);
    if (period === undefined) return;
    void navigate({
      search: (previous) => ({
        ...previous,
        days: period === DEFAULT_USAGE_PERIOD ? undefined : period,
      }),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>{t('nav.usage')}</PageTitle>
      <Select
        label={t('usage.period')}
        value={String(days)}
        onChange={(event) => selectPeriod(event.target.value)}
        className="max-w-xs"
      >
        {USAGE_PERIODS.map((period) => (
          <option key={period} value={period}>
            {t('usage.last', { count: period })}
          </option>
        ))}
      </Select>
      <QueryState query={usage}>
        {(data) => {
          const costs = dailyCosts(data.daily);
          const spent = costs.some(({ costUsd }) => costUsd > 0);
          return (
            <>
              <section className="flex flex-col gap-3">
                <SectionTitle>{t('usage.spend')}</SectionTitle>
                {spent ? (
                  <UsageChart costs={costs} days={data.days} />
                ) : (
                  <Hint>{t('usage.noSpend')}</Hint>
                )}
              </section>
              <section className="flex flex-col gap-3">
                <SectionTitle>{t('usage.topUsers.title')}</SectionTitle>
                {data.topUsers.length === 0 ? (
                  <Hint>{t('usage.topUsers.empty')}</Hint>
                ) : (
                  <DataTable
                    caption={t('usage.topUsers.caption')}
                    hideCaption
                    columns={[
                      t('usage.topUsers.user'),
                      t('usage.topUsers.direct'),
                      t('usage.topUsers.shared'),
                      t('usage.topUsers.total'),
                    ]}
                  >
                    {data.topUsers.map((user) => (
                      <tr key={user.userId}>
                        <RowHeader>{user.email ?? t('usage.topUsers.noEmail')}</RowHeader>
                        <Cell>{format.usd(user.directUsd)}</Cell>
                        <Cell>{format.usd(user.sharedUsd)}</Cell>
                        <Cell>{format.usd(user.totalUsd)}</Cell>
                      </tr>
                    ))}
                  </DataTable>
                )}
                <Hint>{t('usage.topUsers.estimate')}</Hint>
              </section>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
