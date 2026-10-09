import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * A draft on top of a newer saved state: each field the person changed from `base`, the state the
 * draft started from, keeps their value, and every other field takes the newer one.
 */
export function rebaseDraft<Draft extends object>(draft: Draft, base: Draft, next: Draft): Draft {
  const rebased = { ...next };
  for (const key of Object.keys(next) as Array<keyof Draft>) {
    if (!Object.is(draft[key], base[key])) rebased[key] = draft[key];
  }
  return rebased;
}

/**
 * The values of a form that edits `source` and follows it: when `source` changes while the person
 * edits (another tab or device saved), the fields they have not changed take the new values. A save
 * that sends only what differs from `source` then never undoes what was saved elsewhere. The third
 * element starts the form again from what was just saved.
 */
export function useDraft<Source, Draft extends object>(
  source: Source,
  draftOf: (source: Source) => Draft,
): [Draft, Dispatch<SetStateAction<Draft>>, (saved: Source) => void] {
  const [draft, setDraft] = useState(() => draftOf(source));
  const [synced, setSynced] = useState(source);
  if (source !== synced) {
    setSynced(source);
    setDraft(rebaseDraft(draft, draftOf(synced), draftOf(source)));
  }
  function restart(saved: Source) {
    setSynced(saved);
    setDraft(draftOf(saved));
  }
  return [draft, setDraft, restart];
}
