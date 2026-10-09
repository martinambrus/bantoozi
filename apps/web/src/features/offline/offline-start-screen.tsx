import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { OfflineIcon, RefreshIcon } from '../../components/icons.js';

/** What the person sees when the app starts without a connection and has no saved account. */
export function OfflineStartScreen() {
  const { t } = useTranslation('offline');
  const router = useRouter();
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
      <OfflineIcon className="size-8 text-slate-600 dark:text-slate-300" />
      <h1 className="text-2xl font-bold">{t('start.title')}</h1>
      <p className="text-base">{t('start.body')}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('start.hint')}</p>
      <Button onClick={() => void router.invalidate()}>
        <RefreshIcon className="size-4" />
        {t('start.retry')}
      </Button>
    </main>
  );
}
