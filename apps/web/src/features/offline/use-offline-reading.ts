import { useEffect, useState } from 'react';

import {
  clearAccount,
  offlineUsage,
  saveMe,
  setOfflineEnabled,
  type OfflineUsage,
} from '../../offline/cache.js';
import { offlineDb } from '../../offline/db.js';
import { isOfflineEnabled } from '../../offline/device.js';
import { requestReplay } from '../../offline/replay.js';
import { useMe, useSession } from '../../session/context.js';

const NOTHING: OfflineUsage = { articles: 0, bytes: 0, unsent: 0 };

/** The account's choice to read offline, what is stored for it, and the ways to change both. */
export function useOfflineReading() {
  const me = useMe();
  const session = useSession();
  const [supported, setSupported] = useState(() => typeof indexedDB !== 'undefined');
  const [enabled, setEnabled] = useState(() => isOfflineEnabled(me.id));
  const [usage, setUsage] = useState(NOTHING);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let current = true;
    // Looking opens the database, which a browser that never chose offline reading has no use for.
    if (isOfflineEnabled(me.id)) {
      void offlineDb().then((opened) => {
        if (current) setSupported(opened.available);
      });
    }
    void offlineUsage(me.id).then((next) => {
      if (current) setUsage(next);
    });
    return () => {
      current = false;
    };
  }, [me.id]);

  // The sign-in this screen shows. A sign-out removes the account from the device, and the next
  // sign-in, of this account too, has its own state: a change asked for here stores nothing, and
  // changes nothing on the device, once this sign-in has ended.
  const signIn = session.currentSignIn();
  const lasts = () => session.currentSignIn() === signIn;

  /** Runs a change; `work` answers false for a failure the person should be told about. */
  async function run(work: () => Promise<boolean>): Promise<void> {
    if (!lasts()) return;
    setBusy(true);
    setFailed(false);
    setCleared(false);
    try {
      const done = await work();
      setFailed(!done);
      setUsage(await offlineUsage(me.id));
    } finally {
      setBusy(false);
    }
  }

  return {
    supported,
    enabled,
    usage,
    busy,
    failed,
    cleared,
    /** How many changes are waiting to be sent, read now. */
    unsent: async () => (await offlineUsage(me.id)).unsent,
    turnOn: () =>
      run(async () => {
        if (await setOfflineEnabled(me.id, true, lasts)) {
          // Without the account on the device, an offline start could not open what is kept.
          if (lasts() && (await saveMe(me.id, me))) {
            setEnabled(true);
            return true;
          }
          if (!lasts()) return false;
          await setOfflineEnabled(me.id, false, lasts);
          setEnabled(isOfflineEnabled(me.id));
          return false;
        }
        // A store that cannot open is told by the status line, not as a failure.
        if (!(await offlineDb()).available) {
          setSupported(false);
          return true;
        }
        return false;
      }),
    turnOff: () =>
      run(async () => {
        const done = await setOfflineEnabled(me.id, false, lasts);
        setEnabled(isOfflineEnabled(me.id));
        if (done) requestReplay();
        return done;
      }),
    /** Removes the stored articles and unsent changes; the choice and the account stay. */
    clear: () =>
      run(async () => {
        const done = await clearAccount(me.id);
        if (!done) return false;
        requestReplay();
        // The account stays: without it, an offline start could not open the app.
        if (!lasts() || !(await saveMe(me.id, me))) return false;
        setCleared(true);
        return true;
      }),
  };
}
