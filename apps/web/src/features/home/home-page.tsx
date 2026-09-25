import { useTranslation } from 'react-i18next';

/** M0 shell page: the localized product name (the reader replaces it in M6). */
export function HomePage() {
  const { t } = useTranslation(['common', 'home']);
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">{t('common:appName')}</h1>
      <p className="text-lg text-slate-600 dark:text-slate-300">{t('home:tagline')}</p>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('home:comingSoon')}</p>
    </main>
  );
}
