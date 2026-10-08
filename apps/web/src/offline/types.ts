import type { Me } from '@bantoozi/shared';
import type { DBSchema } from 'idb';

import type { Fence, ReaderAction, ReaderState } from '../features/reader/actions/types.js';
import type { OfflineDetail, OfflineItem } from './projection.js';

/** One reader action waiting to be sent (spec 09 §1), schema 1. */
export interface QueueRecord {
  schema: 1;
  /** The mutation id: the `Idempotency-Key` of the first send. */
  id: string;
  /** The key the next send carries; it differs from `id` after a request was replaced. */
  key: string;
  accountId: string;
  articleId: string;
  action: ReaderAction;
  /** Fixed at the first send; null until then. */
  fence: Fence | null;
  /** The id of the earlier record on the same article this one waits for. */
  after: string | null;
  /** The reader state shown before the optimistic change. */
  before: ReaderState;
  createdAt: number;
  stamp: string;
  markRead: boolean;
  snapshot?: { id: string; contentRevision: string };
  /** Set once the change was sent and then kept on the device: the server may have it. */
  sent?: true;
  state: 'pending' | 'sending' | 'frozen';
  attempts: number;
  nextAttemptAt: number;
}

export interface Stat {
  savedAt: number;
  seq: number;
  bytes: number;
}

/** What an account has stored, so usage and eviction never read the articles themselves. */
export interface Manifest {
  seq: number;
  entries: Record<string, Stat>;
}

export interface MeRow {
  me: Me;
  savedAt: number;
}

export interface ItemRow {
  item: OfflineItem;
  savedAt: number;
}

export interface ViewRow {
  itemIds: string[];
  asOf: string;
  datasetVersion: string;
  savedAt: number;
}

export interface DetailRow {
  detail: OfflineDetail;
  savedAt: number;
}

export interface OfflineSchema extends DBSchema {
  meta: { key: string; value: MeRow | Manifest };
  items: { key: string; value: ItemRow };
  views: { key: string; value: ViewRow };
  details: { key: string; value: DetailRow };
  queue: { key: string; value: QueueRecord };
}
