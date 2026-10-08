import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { useToast } from '../../components/toast/toast-provider.js';
import { onOfflineDbVersionChange } from '../../offline/db.js';
import { useUpdateCheck } from './use-update-check.js';

const TOAST_ID = 'pwa-update';

type Notice = 'update' | 'otherTab';

/**
 * Registers the service worker and asks before the page reloads for a new version (spec 09 §1).
 * It renders nothing; the notice is a persistent toast. A new version can wait for this tab, or
 * another tab can have taken over already: it activated the new worker, or it moved the offline
 * database to a newer version that this tab's code can no longer open. Either way the tab keeps
 * running until the person reloads it. Registering fails silently where service workers are
 * unavailable.
 */
export function PwaUpdatePrompt() {
  const { t } = useTranslation('pwa');
  const toast = useToast();
  const reloadAsked = useRef(false);
  const shown = useRef<Notice | null>(null);
  const [otherTab, setOtherTab] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  // The library keeps the options of the first render, so they use only refs and setters. Left to
  // itself it also reloads every tab that shows its prompt once any tab has activated the worker;
  // here only the tab that asked reloads, and the others are told.
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW: (_url, registered) => setRegistration(registered ?? null),
    onNeedReload: () => {
      if (reloadAsked.current) window.location.reload();
      else setOtherTab(true);
    },
  });

  useEffect(
    () =>
      onOfflineDbVersionChange(({ newVersion }) => {
        if (newVersion !== null) setOtherTab(true);
      }),
    [],
  );
  useUpdateCheck(registration);

  const notice: Notice | null = otherTab ? 'otherTab' : needRefresh ? 'update' : null;
  useEffect(() => {
    if (notice === null || notice === shown.current) return;
    shown.current = notice;
    toast.show({
      id: TOAST_ID,
      message: notice === 'update' ? t('update.ready') : t('update.otherTab'),
      tone: 'info',
      durationMs: null,
      action: {
        label: t('update.reload'),
        onAction: () => {
          if (notice === 'otherTab') {
            window.location.reload();
            return;
          }
          reloadAsked.current = true;
          void updateServiceWorker(true);
        },
      },
    });
  }, [notice, toast, t, updateServiceWorker]);

  return null;
}
