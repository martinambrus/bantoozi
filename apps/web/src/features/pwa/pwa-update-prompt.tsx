import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { onOfflineDbVersionChange } from '../../offline/db.js';
import { UpdateBar } from './update-bar.js';
import { useUpdateCheck } from './use-update-check.js';

type Notice = 'update' | 'otherTab';

/**
 * Registers the service worker and asks before the page reloads for a new version (spec 09 §1).
 * The notice is a bar at the top of the page. A new version can wait for this tab, or
 * another tab can have taken over already: it activated the new worker, or it moved the offline
 * database to a newer version that this tab's code can no longer open. Either way the tab keeps
 * running until the person reloads it. Registering fails silently where service workers are
 * unavailable.
 */
export function PwaUpdatePrompt() {
  const { t } = useTranslation('pwa');
  const reloadAsked = useRef(false);
  const [dismissed, setDismissed] = useState<Notice | null>(null);
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
  if (notice === null || notice === dismissed) return null;

  const reload = () => {
    if (notice === 'otherTab') {
      window.location.reload();
      return;
    }
    reloadAsked.current = true;
    void updateServiceWorker(true);
  };
  return (
    <UpdateBar
      message={notice === 'update' ? t('update.ready') : t('update.otherTab')}
      onReload={reload}
      onDismiss={() => setDismissed(notice)}
    />
  );
}
