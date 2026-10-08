import { Outlet, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../components/error-message.js';
import { useOnline } from '../../components/states/use-online.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useMe, useSession } from '../../session/context.js';
import { AppShellLayout } from './app-shell-layout.js';

/** The frame of every signed-in screen except the first-run wizard. */
export function AppShell() {
  const me = useMe();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const { t } = useTranslation('shell');

  async function signOut() {
    try {
      await session.logout();
    } catch (error) {
      // The server session is still there, so the visitor stays signed in.
      toast.show({ message: errorMessage(t, error), tone: 'error' });
      return;
    }
    await navigate({ to: '/login', replace: true });
  }

  return (
    <AppShellLayout user={me} onLogout={() => void signOut()} offline={!online}>
      <Outlet />
    </AppShellLayout>
  );
}
