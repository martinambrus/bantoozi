import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { meKey } from '../../api/query-keys.js';
import { useAccountId, useSignInLasts } from '../../session/context.js';

export type PreferencesLockState = 'held' | 'elsewhere';

export interface PreferencesLock {
  /** `elsewhere`: another tab or window of this account is editing the preferences. */
  state: PreferencesLockState;
  /** Takes the editing from the other tab, which then sees that it lost it. */
  takeOver: () => void;
}

export interface PreferencesLockOptions {
  /** Defaults to `navigator.locks`; without one, every tab edits. */
  locks?: Pick<LockManager, 'request'> | undefined;
}

type Mode = 'try' | 'wait' | 'steal';

/**
 * Lets one tab or window of an account edit the preferences at a time. The first one to open them
 * holds a Web Lock for as long as it stays on the screen; the others wait for it, and one of them
 * can take it over. A tab that gets the lock after waiting reads the account again, because the
 * tab that held it may have saved settings meanwhile.
 */
export function usePreferencesLock(options: PreferencesLockOptions = {}): PreferencesLock {
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const signInLasts = useSignInLasts();
  const locks =
    options.locks ??
    (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined);
  const [state, setState] = useState<PreferencesLockState>('held');
  const takeOverNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (locks === undefined) {
      takeOverNow.current = () => undefined;
      return;
    }
    const name = `bantoozi:preferences:${accountId}`;
    let mounted = true;
    let engaged = false;
    let holding = false;
    let queued: AbortController | undefined;
    let letGo: (() => void) | undefined;

    function acquire(mode: Mode) {
      const controller = new AbortController();
      const lockOptions: LockOptions =
        mode === 'try'
          ? { ifAvailable: true }
          : mode === 'steal'
            ? { steal: true }
            : { signal: controller.signal };
      engaged = true;
      if (mode === 'wait') queued = controller;
      const lost = () => {
        // Aborted by this tab, which has nothing left to do, or taken by another one.
        if (controller.signal.aborted || !mounted || !holding) return;
        holding = false;
        letGo = undefined;
        setState('elsewhere');
        acquire('wait');
      };
      locks!
        .request(name, lockOptions, (lock) => {
          if (queued === controller) queued = undefined;
          if (lock === null) {
            if (mounted) {
              setState('elsewhere');
              acquire('wait');
            }
            return undefined;
          }
          // Granted after this tab left the screen or the sign-in ended: let it go at once.
          if (!mounted || !signInLasts()) {
            engaged = false;
            return undefined;
          }
          return new Promise<void>((resolve) => {
            holding = true;
            letGo = resolve;
            setState('held');
            if (mode !== 'try') void queryClient.invalidateQueries({ queryKey: meKey() });
          });
        })
        .then(() => {
          holding = false;
        }, lost);
    }

    function release() {
      engaged = false;
      holding = false;
      queued?.abort();
      queued = undefined;
      letGo?.();
      letGo = undefined;
    }

    takeOverNow.current = () => {
      if (!mounted || holding) return;
      queued?.abort();
      queued = undefined;
      acquire('steal');
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) release();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && mounted && !engaged) acquire('try');
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    acquire('try');

    return () => {
      mounted = false;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      release();
      takeOverNow.current = () => undefined;
    };
  }, [locks, accountId, queryClient, signInLasts]);

  const takeOver = useCallback(() => {
    takeOverNow.current();
  }, []);
  return { state: locks === undefined ? 'held' : state, takeOver };
}
