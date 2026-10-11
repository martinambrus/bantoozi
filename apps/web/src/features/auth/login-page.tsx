import { useTranslation } from 'react-i18next';

import { FOCUS_RING, cx } from '../../components/cx.js';
import { AuthFooterRow, AuthLayout } from './auth-layout.js';
import { SignInFlow } from './sign-in-flow.js';

export function LoginPage({ redirect }: { redirect?: string | undefined }) {
  const { t, i18n } = useTranslation('auth');
  return (
    <AuthLayout
      title={t('title')}
      lead={t('login.lead')}
      footer={
        <>
          <AuthFooterRow text={t('login.noAccount')} to="/waitlist">
            {t('login.waitlist')}
          </AuthFooterRow>
          {/* A static page outside the SPA (spec 11 §7): a plain link, not a router link. */}
          <a
            href={i18n.language.startsWith('sk') ? '/privacy/sk/' : '/privacy'}
            className={cx(
              'inline-flex min-h-11 items-center self-start rounded font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200',
              FOCUS_RING,
            )}
          >
            {t('login.privacy')}
          </a>
        </>
      }
    >
      <SignInFlow redirect={redirect} />
    </AuthLayout>
  );
}
