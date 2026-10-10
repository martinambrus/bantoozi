import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { meKey } from '../../api/query-keys.js';
import { useAccountId, useSignInLasts } from '../../session/context.js';

export type PreferencesLockState = 'acquiring' | 'held' | 'elsewhere';

export interface PreferencesLock {
  /**
   * `elsewhere`: another tab or window of this account is editing the preferences. `acquiring`: this
   * one is not editing yet, because the lock is not granted or the other tab still has a save on
   * its way.
   */
  state: PreferencesLockState;
  /** Takes the editing from the other tab, which then sees that it lost it. */
  takeOver: () => void;
  /**
   * Runs one save request while this tab holds the lock, and tells the tab that takes the lock over
   * to wait for it. Resolves to `undefined`, without running `work`, once the lock is lost.
   */
  whileSaving: <T>(work: () => Promise<T>) => Promise<T | undefined>;
}

export interface PreferencesLockOptions {
  /** Defaults to `navigator.locks`; without one, every tab edits. */
  locks?: Pick<LockManager, 'request'> | undefined;
}

type Mode = 'try' | 'wait' | 'steal';

/**
 * Lets one tab or window of an account edit the preferences at a time. The first one to open them
 * holds a Web Lock for as long as it stays on the screen; the others wait for it, and one of them
 * can take it over. A tab that gets the lock waits for the saves the previous holder still has on
 * their way, which hold a second lock, and after waiting reads the account again, because that tab
 * may have saved settings meanwhile.
 */
export function usePreferencesLock(options: PreferencesLockOptions = {}): PreferencesLock {
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const signInLasts = useSignInLasts();
  const locks =
    options.locks ??
    (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined);
  const [state, setState] = useState<PreferencesLockState>(
    locks === undefined ? 'held' : 'acquiring',
  );
  const savingNow = useRef<PreferencesLock['whileSaving']>((work) => work());
  const takeOverNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (locks === undefined) {
      takeOverNow.current = () => undefined;
      savingNow.current = (work) => work();
      return;
    }
    const name = `bantoozi:preferences:${accountId}`;
    const savingName = `bantoozi:preferences-save:${accountId}`;
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
            void settle(mode);
          });
        })
        .then(() => {
          holding = false;
        }, lost);
    }

    async function settle(mode: Mode) {
      const stillHolding = () => mounted && holding && signInLasts();
      // A save still on its way, of the tab that held the lock, can change what /me says: whoever
      // waits for it reads the account again, also on a first grant.
      let waited = false;
      try {
        // Exclusive: granted once every save of any tab, held shared, is over.
        const free = await locks!.request(
          savingName,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => lock !== null,
        );
        if (!free) {
          waited = true;
          await locks!.request(savingName, { mode: 'exclusive' }, () => undefined);
        }
      } catch {
        // Nothing aborts this request; if it fails anyway, the lock itself is what counts.
      }
      if (!stillHolding()) return;
      if (mode !== 'try' || waited) {
        await queryClient.invalidateQueries({ queryKey: meKey() });
        if (!stillHolding()) return;
      }
      setState('held');
    }

    savingNow.current = <T>(work: () => Promise<T>) =>
      locks.request(savingName, { mode: 'shared' }, () =>
        holding ? work() : undefined,
      ) as Promise<T | undefined>;

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
      setState('acquiring');
      acquire('steal');
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) release();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && mounted && !engaged) {
        setState('acquiring');
        acquire('try');
      }
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
      savingNow.current = (work) => work();
    };
  }, [locks, accountId, queryClient, signInLasts]);

  const takeOver = useCallback(() => {
    takeOverNow.current();
  }, []);
  const whileSaving = useCallback(<T>(work: () => Promise<T>) => savingNow.current(work), []);
  return { state: locks === undefined ? 'held' : state, takeOver, whileSaving };
}
