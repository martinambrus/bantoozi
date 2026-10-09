import type { Me } from '@bantoozi/shared';
import { useEffect } from 'react';

import { themePreference } from '../../theme/theme.js';

/**
 * Effects that last as long as the signed-in account does. Rendered below the `_authed` layout,
 * which hands it the account from the query cache (it must work with nothing but the router
 * context above it, so it does not read `useMe()`). When the account goes, so does its theme.
 */
export function AccountEffects({ me }: { me: Me | undefined }) {
  const theme = me?.preferences.theme;

  useEffect(() => {
    if (theme === undefined) return;
    themePreference.set(theme);
    return () => themePreference.set('system');
  }, [theme]);

  return null;
}
