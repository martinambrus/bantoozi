import type { Lane } from './lanes.js';

/** What a reader route shows: a lane, or one feed, folder or label (spec 09 §2). */
export type ReaderView =
  | { kind: 'lane'; lane: Lane }
  | { kind: 'feed'; feedId: string }
  | { kind: 'folder'; name: string }
  | { kind: 'label'; labelId: string };
