import { useTranslation } from 'react-i18next';

import { AuthFooterRow, AuthLayout } from './auth-layout.js';
import { SignInFlow } from './sign-in-flow.js';

export function LoginPage({ redirect }: { redirect?: string | undefined }) {
  const { t } = useTranslation('auth');
  return (
    <AuthLayout
      title={t('title')}
      lead={t('login.lead')}
      footer={
        <AuthFooterRow text={t('login.noAccount')} to="/waitlist">
          {t('login.waitlist')}
        </AuthFooterRow>
      }
    >
      <SignInFlow redirect={redirect} />
    </AuthLayout>
  );
}
