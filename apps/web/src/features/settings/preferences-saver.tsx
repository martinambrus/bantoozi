import {
  mergeUserPreferences,
  type Me,
  type UserPreferences,
  type UserPreferencesPatch,
} from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

import { useApiMutation } from '../../api/mutation.js';
import { meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useMe } from '../../session/context.js';

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
 * patch of that one leaf, so settings changed in quick succession cannot overwrite each other, and
 * the answer to an earlier change of a setting never replaces a later one.
 */
export function PreferenceSaverProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const update = useApiMutation(routes.meUpdate, { networkMode: 'always' });
  const [pending, setPending] = useState<ReadonlyMap<SettingId, SettingValues[SettingId]>>(
    new Map(),
  );
  const [failures, setFailures] = useState<ReadonlyMap<SettingId, { error: unknown }>>(new Map());
  const [savedId, setSavedId] = useState<SettingId | null>(null);
  const count = useRef(0);
  const issued = useRef(new Map<SettingId, number>());
  const applied = useRef(new Map<SettingId, number>());

  function valueOf<Id extends SettingId>(id: Id): SettingValues[Id] {
    return (pending.get(id) ?? readSetting(me.preferences, id)) as SettingValues[Id];
  }

  async function save<Id extends SettingId>(id: Id, value: SettingValues[Id], change: number) {
    let saved: Me;
    try {
      saved = await update.mutateAsync({ body: { preferences: patchFor(id, value) } });
    } catch (error) {
      if (issued.current.get(id) !== change) return;
      setPending((current) => withoutEntry(current, id));
      setFailures((current) => withEntry(current, id, { error }));
      return;
    }
    if (change > (applied.current.get(id) ?? 0)) {
      applied.current.set(id, change);
      const confirmed = patchFor(id, readSetting(saved.preferences, id));
      queryClient.setQueryData<Me | null>(meKey(), (current) =>
        current
          ? { ...current, preferences: mergeUserPreferences(current.preferences, confirmed) }
          : undefined,
      );
    }
    if (issued.current.get(id) === change) {
      setPending((current) => withoutEntry(current, id));
      setSavedId(id);
    }
  }

  function change<Id extends SettingId>(id: Id, value: SettingValues[Id]) {
    if (valueOf(id) === value) return;
    count.current += 1;
    issued.current.set(id, count.current);
    setPending((current) => withEntry(current, id, value));
    setFailures((current) => withoutEntry(current, id));
    setSavedId(null);
    void save(id, value, count.current);
  }

  return (
    <SaverContext value={{ valueOf, change, failureOf: (id) => failures.get(id), savedId }}>
      {children}
    </SaverContext>
  );
}
