import type { AdminPlan } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { QueryState } from '../../components/states/query-state.js';
import { useSession } from '../../session/context.js';
import { Alert, Cell, DataTable, Hint, PageTitle, RowHeader } from './admin-ui.js';
import { PlanDialog } from './plan-dialog.js';
import { useAdminKey, useRefresh } from './use-admin.js';

export function AdminPlansPage() {
  const { t, i18n } = useTranslation('admin');
  const api = useApi();
  const session = useSession();
  const key = useAdminKey();
  const refresh = useRefresh();
  const plans = useQuery({
    queryKey: key('plans'),
    queryFn: ({ signal }) => api.call(routes.adminPlanList, undefined, { signal }),
  });
  const update = useApiMutation(routes.adminPlanUpdate);
  const makeDefault = useApiMutation(routes.adminPlanDefault);
  const remove = useApiMutation(routes.adminPlanDelete);
  const [editing, setEditing] = useState<AdminPlan | null | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const pending = update.isPending || makeDefault.isPending || remove.isPending;
  const reload = () => {
    void refresh('plans');
    void refresh('users');
  };

  async function act(send: () => Promise<unknown>) {
    setFailure(null);
    const signIn = session.currentSignIn();
    try {
      await send();
      if (session.currentSignIn() === signIn) reload();
    } catch (error) {
      if (session.currentSignIn() !== signIn) return;
      setFailure(error);
      if (isApiError(error) && error.code === 'STALE_STATE') reload();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <PageTitle>{t('nav.plans')}</PageTitle>
        <Button onClick={() => setEditing(null)}>{t('plans.add')}</Button>
      </div>
      <Hint>{t('plans.schedulerNote')}</Hint>
      <Link to="/admin/settings" className="text-indigo-700 underline dark:text-indigo-300">
        {t('plans.analysisCap')}
      </Link>
      {failure === null ? null : (
        <Alert>
          {isApiError(failure) && failure.code === 'STALE_STATE'
            ? t('plans.stale')
            : errorMessage(t, failure)}
        </Alert>
      )}
      <QueryState query={plans}>
        {({ items }) => (
          <DataTable
            caption={t('nav.plans')}
            hideCaption
            columns={[
              t('plans.columns.plan'),
              t('plans.columns.users'),
              t('plans.fields.maxFeeds'),
              t('plans.fields.minFetchIntervalS'),
              t('plans.columns.actions'),
            ]}
          >
            {items.map((plan) => (
              <tr key={plan.key}>
                <RowHeader>
                  <div>
                    {i18n.language.startsWith('sk') ? (plan.labelSk ?? plan.label) : plan.label}{' '}
                    <span className="font-normal">({plan.key})</span>
                  </div>
                  {plan.isDefault ? <Badge>{t('plans.default')}</Badge> : null}
                  {plan.retiredAt !== null ? <Badge>{t('plans.retired')}</Badge> : null}
                </RowHeader>
                <Cell>{plan.userCount}</Cell>
                <Cell>{plan.maxFeeds}</Cell>
                <Cell>{plan.minFetchIntervalS}</Cell>
                <Cell>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={pending} onClick={() => setEditing(plan)}>
                      {t('plans.edit', { key: plan.key })}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={pending || plan.isDefault}
                      onClick={() =>
                        void act(() =>
                          update.mutateAsync({
                            params: { key: plan.key },
                            body: {
                              expectedVersion: plan.version,
                              retired: plan.retiredAt === null,
                            },
                          }),
                        )
                      }
                    >
                      {t(plan.retiredAt === null ? 'plans.retire' : 'plans.restore', {
                        key: plan.key,
                      })}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={pending || plan.isDefault || plan.retiredAt !== null}
                      onClick={() =>
                        void act(() => makeDefault.mutateAsync({ params: { key: plan.key } }))
                      }
                    >
                      {t('plans.makeDefault', { key: plan.key })}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={pending || plan.isDefault || plan.userCount > 0}
                      onClick={() =>
                        void act(() => remove.mutateAsync({ params: { key: plan.key } }))
                      }
                    >
                      {t('plans.delete', { key: plan.key })}
                    </Button>
                  </div>
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </QueryState>
      {editing === undefined ? null : (
        <PlanDialog plan={editing} onClose={() => setEditing(undefined)} onChanged={reload} />
      )}
    </div>
  );
}
