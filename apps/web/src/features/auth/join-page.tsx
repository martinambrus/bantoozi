import { useTranslation } from 'react-i18next';

import { AuthFooterRow, AuthLayout } from './auth-layout.js';
import { SignInFlow } from './sign-in-flow.js';

export function JoinPage({ code }: { code?: string | undefined }) {
  const { t } = useTranslation('auth');
  return (
    <AuthLayout
      title={t('join.title')}
      lead={t('join.lead')}
      footer={
        <>
          <AuthFooterRow text={t('join.haveAccount')} to="/login">
            {t('join.signIn')}
          </AuthFooterRow>
          <AuthFooterRow text={t('join.noInvite')} to="/waitlist">
            {t('join.waitlist')}
          </AuthFooterRow>
        </>
      }
    >
      <SignInFlow invite={{ code }} />
    </AuthLayout>
  );
}
