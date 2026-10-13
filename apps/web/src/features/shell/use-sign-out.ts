import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';

/**
 * Signs this device out and goes to the sign-in page. The sign-out takes turns with the sign-ins of
 * the other tabs, so its answer cannot clear the cookie of one that came meanwhile. When the server
 * has not ended the session yet, the person is told so (spec 09 §1).
 */
export function useSignOut(): () => Promise<void> {
  return useSigningOut().signOut;
}

/** As `useSignOut`, and whether a sign-out is on its way; a second call meanwhile does nothing. */
export function useSigningOut(): { signOut: () => Promise<void>; signingOut: boolean } {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation('shell');

  const [signingOut, setSigningOut] = useState(false);
  const running = useRef(false);

  const signOut = async () => {
    if (running.current) return;
    running.current = true;
    setSigningOut(true);
    try {
      await run();
    } finally {
      running.current = false;
      setSigningOut(false);
    }
  };

  const run = async () => {
    const { server } = await session.logout();
    if (server !== 'signed_out') {
      toast.show({
        id: 'signed-out-offline',
        message: t(server === 'pending' ? 'signedOutOffline' : 'signedOutRefused'),
        tone: server === 'pending' ? 'info' : 'error',
        durationMs: null,
      });
    }
    await navigate({ to: '/login', replace: true });
  };

  return { signOut, signingOut };
}
