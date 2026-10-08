import { useEffect } from 'react';

import { useToastStore } from '../../components/toast/toast-provider.js';
import { useOptionalSession } from '../../session/context.js';

/**
 * Whenever someone signs in or out (or another tab does), the toasts on screen go: what they say
 * and offer belongs to the account they were shown to. A toast of the device (an update to reload
 * for) stays. A toast shown after the change, like the note about an offline sign-out on the
 * sign-in screen, lasts until the next one.
 */
export function AccountToasts() {
  const session = useOptionalSession();
  const { clearAccount } = useToastStore();

  useEffect(() => session?.subscribe(clearAccount), [session, clearAccount]);

  return null;
}
