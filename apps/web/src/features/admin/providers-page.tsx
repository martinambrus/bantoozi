import { PROVIDERS, type CredentialStatus, type KeyringOverview } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { QueryState } from '../../components/states/query-state.js';
import { Alert, Hint, PageTitle } from './admin-ui.js';
import { ProviderPanel } from './provider-panel.js';
import {
  VALIDATION_POLL_MS,
  validationRunning,
  type ValidationWatches,
} from './provider-status.js';
import { useAdminKey, useRefresh } from './use-admin.js';

interface CredentialItems {
  items: CredentialStatus[];
  keyring: KeyringOverview;
}

const ESCAPED = { interpolation: { escapeValue: false } } as const;

/** The reasons the keyring needs attention, one line each; empty when everything is fine. */
function KeyringBanner({ keyring }: { keyring: KeyringOverview }) {
  const { t } = useTranslation('admin');
  const lines: string[] = [];
  if (keyring.api.status !== 'ok') {
    lines.push(
      t(`providers.keyring.${keyring.api.status}`, {
        where: t('providers.keyring.api'),
        ...ESCAPED,
      }),
    );
  }
  for (const worker of keyring.workers) {
    if (worker.status === 'ok') continue;
    lines.push(
      t(`providers.keyring.${worker.status}`, {
        where: t('providers.keyring.worker', { id: worker.workerId, ...ESCAPED }),
        ...ESCAPED,
      }),
    );
  }
  if (keyring.mismatch) {
    const other = keyring.workers.find(
      (w) => w.status === 'ok' && w.activeKeyId !== keyring.api.activeKeyId,
    );
    lines.push(
      t('providers.keyring.mismatch', {
        api: keyring.api.activeKeyId ?? '',
        worker: other?.activeKeyId ?? '',
        ...ESCAPED,
      }),
    );
  }
  if (lines.length === 0) return null;
  return (
    <div data-testid="keyring-banner" className="flex flex-col gap-1">
      {lines.map((line) => (
        <Alert key={line}>{line}</Alert>
      ))}
    </div>
  );
}

export function AdminProvidersPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const queryClient = useQueryClient();
  const adminKey = useAdminKey();
  const refresh = useRefresh();
  const [watches, setWatches] = useState<ValidationWatches>({});

  const credentials = useQuery({
    queryKey: adminKey('credentials'),
    queryFn: ({ signal }) => api.call(routes.adminCredentialList, undefined, { signal }),
    refetchInterval: (query) =>
      validationRunning(query.state.data?.items, watches, Date.now()) ? VALIDATION_POLL_MS : false,
  });

  function replace(credential: CredentialStatus) {
    writeQueryData<CredentialItems>(queryClient, adminKey('credentials'), (current) =>
      current === undefined
        ? current
        : {
            ...current,
            items: current.items.map((item) =>
              item.provider === credential.provider ? credential : item,
            ),
          },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.providers')}</PageTitle>
      <Hint>{t('providers.intro')}</Hint>
      <QueryState query={credentials}>
        {(data) => (
          <>
            <KeyringBanner keyring={data.keyring} />
            <div className="grid gap-4 lg:grid-cols-2">
              {PROVIDERS.map((provider) => {
                const credential = data.items.find((item) => item.provider === provider);
                return credential === undefined ? null : (
                  <ProviderPanel
                    key={provider}
                    credential={credential}
                    keyringBlocked={
                      data.keyring.api.status !== 'ok' ||
                      data.keyring.workers.some((w) => w.status !== 'ok')
                    }
                    onCredential={replace}
                    onStale={() => void refresh('credentials')}
                    onValidationRequested={(watch) =>
                      setWatches((current) => ({ ...current, [provider]: watch }))
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
