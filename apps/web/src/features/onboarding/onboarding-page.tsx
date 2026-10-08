import { useTranslation } from 'react-i18next';

export function OnboardingPage() {
  const { t } = useTranslation('onboarding');
  return (
    <main>
      <h1>{t('title')}</h1>
    </main>
  );
}
