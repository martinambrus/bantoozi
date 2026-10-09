import { Outlet } from '@tanstack/react-router';

import { useOnline } from '../../components/states/use-online.js';
import { useMe } from '../../session/context.js';
import { AppShellLayout } from './app-shell-layout.js';
import { useSignOut } from './use-sign-out.js';

/** The frame of every signed-in screen except the first-run wizard. */
export function AppShell() {
  const me = useMe();
  const online = useOnline();
  const signOut = useSignOut();

  return (
    <AppShellLayout user={me} onLogout={() => void signOut()} offline={!online}>
      <Outlet />
    </AppShellLayout>
  );
}
