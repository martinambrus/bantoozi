import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import { useSigningOut } from '../../src/features/shell/use-sign-out.js';
import { createI18n } from '../../src/i18n/index.js';
import { SessionProvider } from '../../src/session/context.js';
import type { Session } from '../../src/session/session.js';

const navigate = vi.fn(() => Promise.resolve());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

function setup() {
  let finish: (result: { server: 'signed_out' }) => void = () => {};
  const logout = vi.fn(
    () =>
      new Promise<{ server: 'signed_out' }>((resolve) => {
        finish = resolve;
      }),
  );
  const session = { logout } as unknown as Session;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={createI18n('en')}>
      <SessionProvider session={session}>
        <ToastProvider>{children}</ToastProvider>
      </SessionProvider>
    </I18nextProvider>
  );
  const hook = renderHook(() => useSigningOut(), { wrapper });
  return { hook, logout, finish: (result = { server: 'signed_out' as const }) => finish(result) };
}

describe('useSigningOut', () => {
  it('is busy from the first call until the page has changed, and signs out once', async () => {
    const { hook, logout, finish } = setup();
    expect(hook.result.current.signingOut).toBe(false);

    let first!: Promise<void>;
    act(() => {
      first = hook.result.current.signOut();
      void hook.result.current.signOut();
    });

    expect(hook.result.current.signingOut).toBe(true);
    expect(logout).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await first;
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/login', replace: true });
    await waitFor(() => expect(hook.result.current.signingOut).toBe(false));
  });
});
