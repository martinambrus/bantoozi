import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useOnline } from '../../components/states/use-online.js';
import { useMe } from '../../session/context.js';
import { planLabel } from '../settings/plan-section.js';
import { AppShellLayout } from './app-shell-layout.js';
import { useSigningOut } from './use-sign-out.js';

/** The frame of every signed-in screen except the first-run wizard. */
export function AppShell() {
  const me = useMe();
  const { i18n } = useTranslation();
  const online = useOnline();
  const { signOut, signingOut } = useSigningOut();

  return (
    <AppShellLayout
      user={me}
      plan={me.planInfo === undefined ? undefined : planLabel(me.planInfo, i18n.language)}
      onLogout={() => void signOut()}
      offline={!online}
      signingOut={signingOut}
    >
      <Outlet />
    </AppShellLayout>
  );
}
