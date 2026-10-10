import type { Me, UserPreferences, UserPreferencesPatch } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { useMe, useSession } from '../../session/context.js';
import { storeSavedMe } from '../../session/me.js';
import type { PreferencesLock, PreferencesLockState } from './use-preferences-lock.js';

type Nested<Group extends string, Leaves> = {
  [Leaf in keyof Leaves & string as `${Group}.${Leaf}`]: Leaves[Leaf];
};

/** The preferences this screen edits, one entry per control; the nested ones are named `group.leaf`. */
export type SettingValues = Omit<
  UserPreferences,
  'demote' | 'swipe' | 'theme' | 'folderOrder' | 'onboardingCompletedAt'
> &
  Nested<'demote', UserPreferences['demote']> &
  Nested<'swipe', UserPreferences['swipe']>;

export type SettingId = keyof SettingValues;
type IdsHolding<Value> = {
  [Id in SettingId]: SettingValues[Id] extends Value ? Id : never;
}[SettingId];
export type ToggleId = IdsHolding<boolean>;
export type ChoiceId = IdsHolding<string>;

function readSetting<Id extends SettingId>(
  preferences: UserPreferences,
  id: Id,
): SettingValues[Id] {
  const [group, leaf] = id.split('.') as [keyof UserPreferences, string | undefined];
  const node: unknown = preferences[group];
  return (leaf === undefined ? node : (node as Record<string, unknown>)[leaf]) as SettingValues[Id];
}

function patchFor<Id extends SettingId>(id: Id, value: SettingValues[Id]): UserPreferencesPatch {
  const [group, leaf] = id.split('.') as [string, string | undefined];
  return (
    leaf === undefined ? { [group]: value } : { [group]: { [leaf]: value } }
  ) as UserPreferencesPatch;
}

function withEntry<Value>(
  map: ReadonlyMap<SettingId, Value>,
  id: SettingId,
  value: Value,
): ReadonlyMap<SettingId, Value> {
  return new Map(map).set(id, value);
}

function withoutEntry<Value>(
  map: ReadonlyMap<SettingId, Value>,
  id: SettingId,
): ReadonlyMap<SettingId, Value> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

export interface PreferenceSaver {
  /** What the control shows: the value being saved, else the one the account holds. */
  valueOf: <Id extends SettingId>(id: Id) => SettingValues[Id];
  change: <Id extends SettingId>(id: Id, value: SettingValues[Id]) => void;
  /** Why the latest change of this setting was not saved. */
  failureOf: (id: SettingId) => { error: unknown } | undefined;
  /** The setting whose change was saved last. */
  savedId: SettingId | null;
}

const SaverContext = createContext<PreferenceSaver | null>(null);

export function usePreferenceSaver(): PreferenceSaver {
  const saver = useContext(SaverContext);
  if (saver === null) throw new Error('usePreferenceSaver() needs a <PreferenceSaverProvider>');
  return saver;
}

/**
 * Saves each preference on its own the moment it changes. A change shows at once and is sent as a
 * patch of that one leaf, so settings changed in quick succession cannot overwrite each other. A
 * setting has one request on its way at a time: two could reach the server in either order and
 * leave it with the older value, so what is changed meanwhile waits, and only the newest is sent.
 * Unless this tab holds the lock (`lock`), nothing is changed here: what waited is dropped, and a
 * request already on its way is left to finish, as the next holder waits for it (`whileSaving`).
 */
export function PreferenceSaverProvider({
  lock = 'held',
  whileSaving = (work) => work(),
  children,
}: {
  lock?: PreferencesLockState;
  whileSaving?: PreferencesLock['whileSaving'];
  children: ReactNode;
}) {
  const me = useMe();
  const session = useSession();
  const queryClient = useQueryClient();
  const update = useApiMutation(routes.meUpdate);
  const [pending, setPending] = useState<ReadonlyMap<SettingId, SettingValues[SettingId]>>(
    new Map(),
  );
  const [failures, setFailures] = useState<ReadonlyMap<SettingId, { error: unknown }>>(new Map());
  const [savedId, setSavedId] = useState<SettingId | null>(null);
  const count = useRef(0);
  const issued = useRef(new Map<SettingId, number>());
  const sending = useRef(new Set<SettingId>());
  const waiting = useRef(new Map<SettingId, { value: SettingValues[SettingId]; change: number }>());

  function valueOf<Id extends SettingId>(id: Id): SettingValues[Id] {
    return (pending.get(id) ?? readSetting(me.preferences, id)) as SettingValues[Id];
  }

  async function save<Id extends SettingId>(
    id: Id,
    value: SettingValues[Id],
    change: number,
    signIn: number,
  ) {
    const preferences = patchFor(id, value);
    let saved: Me;
    try {
      const result = await whileSaving(() => update.mutateAsync({ body: { preferences } }));
      if (result === undefined) {
        // The lock was lost before the request went out: the change is dropped.
        if (issued.current.get(id) === change) setPending((current) => withoutEntry(current, id));
        return;
      }
      saved = result;
    } catch (error) {
      if (issued.current.get(id) !== change) return;
      setPending((current) => withoutEntry(current, id));
      setFailures((current) => withEntry(current, id, { error }));
      return;
    }
    if (session.currentSignIn() !== signIn) return;
    storeSavedMe(queryClient, { preferences }, saved);
    if (issued.current.get(id) === change) {
      setPending((current) => withoutEntry(current, id));
      setSavedId(id);
    }
  }

  async function send(id: SettingId, value: SettingValues[SettingId], change: number) {
    const signIn = session.currentSignIn();
    sending.current.add(id);
    try {
      await save(id, value, change, signIn);
    } finally {
      sending.current.delete(id);
      const next = waiting.current.get(id);
      waiting.current.delete(id);
      // What waits belongs to the sign-in it was changed in, which may have ended meanwhile. Sent
      // then, it would go out with no session, with another account's, or in a later sign-in over
      // what was changed there since.
      if (next !== undefined && session.currentSignIn() === signIn) {
        void send(id, next.value, next.change);
      }
    }
  }

  useEffect(() => {
    if (lock === 'held') return;
    const dropped = [...waiting.current.keys()];
    waiting.current.clear();
    if (dropped.length === 0) return;
    setPending((current) => {
      const next = new Map(current);
      for (const id of dropped) next.delete(id);
      return next;
    });
  }, [lock]);

  function change<Id extends SettingId>(id: Id, value: SettingValues[Id]) {
    if (lock !== 'held' || valueOf(id) === value) return;
    count.current += 1;
    issued.current.set(id, count.current);
    setPending((current) => withEntry(current, id, value));
    setFailures((current) => withoutEntry(current, id));
    setSavedId(null);
    if (sending.current.has(id)) waiting.current.set(id, { value, change: count.current });
    else void send(id, value, count.current);
  }

  return (
    <SaverContext value={{ valueOf, change, failureOf: (id) => failures.get(id), savedId }}>
      {children}
    </SaverContext>
  );
}
