import type { ArticleDetail, ArticleListItem } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  readDetail,
  readView,
  saveDetail,
  saveView,
  setOfflineEnabled,
} from '../../src/offline/cache.js';
import { projectDetail, projectItem } from '../../src/offline/projection.js';
import { A, VIEW, dumpDatabase, fullDetail, fullItem, freshIndexedDb } from './support.js';

/** What a row renders and acts on (spec 09 §1): never the score, the explanation or the rank. */
const ITEM_KEYS = [
  'analysis',
  'archivedAt',
  'author',
  'bookmarkCapture',
  'bookmarkedAt',
  'cluster',
  'contentRevision',
  'effectiveImagesAllowed',
  'excerpt',
  'feed',
  'firstSeenAt',
  'id',
  'imageUrl',
  'labelIds',
  'labelSuggestions',
  'lang',
  'mediaPolicyFeedId',
  'publishedAt',
  'rating',
  'readAt',
  'reason',
  'stateVersion',
  'title',
  'topReason',
  'translationAvailable',
  'url',
].sort();

/** The opened article adds its text, its translation and the saved snapshot. */
const DETAIL_KEYS = [
  ...ITEM_KEYS,
  'bodyLead',
  'bookmarkSnapshot',
  'excerptHtml',
  'translation',
].sort();

const NEVER_STORED = [
  '"explain"',
  '"clusterMembers"',
  '"pLike"',
  '"tier"',
  '"lane"',
  'EXPLAIN-CARD-SENTINEL',
  'CLUSTER-MEMBER-SENTINEL',
  '0.8213',
];

const keysOf = (value: object | null | undefined) => Object.keys(value ?? {}).sort();

describe('the projection of an article', () => {
  it('keeps exactly the allowlisted keys of a list item', () => {
    expect(keysOf(projectItem(fullItem()))).toEqual(ITEM_KEYS);
  });

  it('keeps exactly the allowlisted keys of an opened article and never its explanation', () => {
    const projected = projectDetail(fullDetail());

    expect(keysOf(projected)).toEqual(DETAIL_KEYS);
    expect(projected).not.toHaveProperty('explain');
  });

  it('keeps the values of the keys it keeps', () => {
    const item = fullItem();

    const projected = projectItem(item);

    for (const key of ITEM_KEYS) {
      expect(projected[key as keyof typeof projected]).toEqual(item[key as keyof ArticleListItem]);
    }
  });

  it('drops a key the allowlist does not name, such as one a newer server adds', () => {
    const grown = { ...fullDetail(), adminNote: 'internal' } as unknown as ArticleDetail;

    expect(keysOf(projectDetail(grown))).toEqual(DETAIL_KEYS);
  });

  it('is told apart from the raw DTO by the allowlist', () => {
    expect(keysOf(fullDetail())).not.toEqual(DETAIL_KEYS);
    expect(keysOf(fullItem())).not.toEqual(ITEM_KEYS);
    expect(keysOf(fullDetail())).toContain('explain');
  });
});

describe('what reaches IndexedDB', () => {
  const idb = freshIndexedDb();

  it('is the projection of the list items and of the opened article, and nothing else', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view-1', [fullItem()], VIEW);
    await saveDetail(A, { ...fullDetail(), adminNote: 'internal' } as unknown as ArticleDetail);

    const view = await readView(A, 'view-1');
    const detail = await readDetail(A, '101');

    expect(keysOf(view?.items[0])).toEqual(ITEM_KEYS);
    expect(keysOf(detail)).toEqual(DETAIL_KEYS);
    const stored = JSON.stringify(await dumpDatabase(idb.factory));
    expect(stored).toContain('Solid-state batteries reach the pilot line');
    for (const never of [...NEVER_STORED, 'adminNote', 'internal']) {
      expect(stored).not.toContain(never);
    }
  });
});
