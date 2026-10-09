import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';

/**
 * Signs this device out and goes to the sign-in page. The sign-out takes turns with the sign-ins of
 * the other tabs, so its answer cannot clear the cookie of one that came meanwhile. When the server
 * has not ended the session yet, the person is told so (spec 09 §1).
 */
export function useSignOut(): () => Promise<void> {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation('shell');

  return async () => {
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
}
