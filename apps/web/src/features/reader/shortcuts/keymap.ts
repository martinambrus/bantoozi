import type { RuleExpiryDays } from '@bantoozi/shared';

import type { Lane } from '../lanes.js';

/** Spec 09 §3.4: a key that starts a sequence waits this long for the next one. */
export const SEQUENCE_MS = 1000;

/** The keys that start a sequence: `g` goes to a lane, `m` mutes the story. */
export type Sequence = 'g' | 'm';

/** `g` then one of these keys goes to its lane, in the order the hint names them. */
export const GO_KEYS = [
  ['f', 'for_you'],
  ['m', 'maybe'],
  ['e', 'everything'],
  ['n', 'new'],
  ['b', 'bookmarks'],
] as const satisfies readonly (readonly [string, Lane])[];

/** `m` then one of these keys mutes the story; 0 stands for the longest time, 30 days. */
export const MUTE_KEYS = [
  ['1', 1],
  ['3', 3],
  ['7', 7],
  ['0', 30],
] as const satisfies readonly (readonly [string, RuleExpiryDays])[];

export function goLane(key: string): Lane | undefined {
  return GO_KEYS.find(([candidate]) => candidate === key.toLowerCase())?.[1];
}

export function muteDays(key: string): RuleExpiryDays | undefined {
  return MUTE_KEYS.find(([candidate]) => candidate === key)?.[1];
}

/** A word between the keys of a shortcut in the overlay; the language has it in `shortcuts.words`. */
export interface Joiner {
  readonly word: 'then' | 'or' | 'plus' | 'to' | 'withRating';
}

const THEN: Joiner = { word: 'then' };
const OR: Joiner = { word: 'or' };
const PLUS: Joiner = { word: 'plus' };
const TO: Joiner = { word: 'to' };
const WITH_RATING: Joiner = { word: 'withRating' };

/** What is pressed: a key (shown as it is on the cap) or a word between keys. */
export type ChordPart = string | Joiner;

export interface ShortcutRow {
  /** The key of the label in the `reader` messages. */
  label: string;
  chord: readonly ChordPart[];
}

export interface ShortcutGroup {
  id: 'moving' | 'lanes' | 'article' | 'reader';
  rows: readonly ShortcutRow[];
}

/** Every shortcut of spec 09 §3.4, in the groups the `?` overlay lists them in. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'moving',
    rows: [
      { label: 'shortcuts.rows.next', chord: ['j'] },
      { label: 'shortcuts.rows.previous', chord: ['k'] },
      { label: 'shortcuts.rows.filter', chord: ['/'] },
    ],
  },
  {
    id: 'lanes',
    rows: GO_KEYS.map(([key, lane]) => ({ label: `lanes.${lane}`, chord: ['g', THEN, key] })),
  },
  {
    id: 'article',
    rows: [
      { label: 'shortcuts.rows.open', chord: ['o', OR, 'Enter'] },
      { label: 'shortcuts.rows.like', chord: ['+', OR, '='] },
      { label: 'shortcuts.rows.dislike', chord: ['-', THEN, '1', TO, '6'] },
      { label: 'shortcuts.rows.hide', chord: ['Shift', WITH_RATING] },
      { label: 'shortcuts.rows.bookmark', chord: ['b'] },
      { label: 'shortcuts.rows.labels', chord: ['l'] },
      { label: 'shortcuts.rows.why', chord: ['w'] },
      { label: 'shortcuts.rows.mute', chord: ['m', THEN, ...MUTE_KEYS.map(([key]) => key)] },
      { label: 'shortcuts.rows.read', chord: ['x'] },
    ],
  },
  {
    id: 'reader',
    rows: [
      { label: 'shortcuts.rows.markAll', chord: ['Shift', PLUS, 'A'] },
      { label: 'shortcuts.rows.simple', chord: ['s', OR, 'Ctrl', PLUS, 'M'] },
      { label: 'shortcuts.rows.help', chord: ['?'] },
    ],
  },
];
