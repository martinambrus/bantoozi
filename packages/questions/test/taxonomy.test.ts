import { describe, expect, it } from 'vitest';

import {
  L1_IDS,
  OTHER_TOPIC_ID,
  TAXONOMY,
  isTopicId,
  taxonomyL1,
  taxonomyL1Criteria,
  taxonomyTopicRows,
  topicL1,
} from '../src/index.js';

describe('taxonomy v1', () => {
  it('has 20 level-1 topics with unique ids, `other` last and childless', () => {
    expect(TAXONOMY).toHaveLength(20);
    expect(new Set(L1_IDS).size).toBe(20);
    expect(L1_IDS.at(-1)).toBe(OTHER_TOPIC_ID);
    expect(taxonomyL1(OTHER_TOPIC_ID)?.children).toEqual([]);
    expect(L1_IDS).toEqual([
      'technology',
      'science',
      'health',
      'business',
      'economy',
      'politics',
      'world',
      'local',
      'environment',
      'transport',
      'culture',
      'entertainment',
      'gaming',
      'sports',
      'lifestyle',
      'education',
      'society',
      'shopping',
      'diy',
      'other',
    ]);
  });

  it('gives every topic a unique `<l1>.<l2>` id, names and a description', () => {
    const rows = taxonomyTopicRows();
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.filter((row) => row.level === 2)).toHaveLength(
      TAXONOMY.reduce((sum, topic) => sum + topic.children.length, 0),
    );
    for (const topic of TAXONOMY) {
      expect(topic.id).toMatch(/^[a-z_]+$/);
      expect(topic.children.length === 0).toBe(topic.id === OTHER_TOPIC_ID);
      for (const child of topic.children) {
        expect(child.id).toMatch(new RegExp(`^${topic.id}\\.[a-z_0-9]+$`));
      }
    }
    for (const row of rows) {
      expect(row.nameEn.trim(), row.id).not.toBe('');
      expect(row.nameSk.trim(), row.id).not.toBe('');
      expect(row.description.trim(), row.id).not.toBe('');
      expect(row.description, row.id).not.toContain('\n');
    }
  });

  it('seeds every level-2 topic under an existing level-1 parent', () => {
    const rows = taxonomyTopicRows();
    const levelOne = new Set(rows.filter((row) => row.level === 1).map((row) => row.id));
    expect(levelOne.size).toBe(20);
    for (const row of rows) {
      if (row.level === 1) {
        expect(row.parentId).toBeNull();
      } else {
        expect(levelOne.has(row.parentId ?? ''), row.id).toBe(true);
        expect(topicL1(row.id)).toBe(row.parentId);
      }
    }
    // Parents come first (one INSERT may carry both; the trigger checks at statement end anyway).
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.parentId !== null) expect(seen.has(row.parentId)).toBe(true);
      seen.add(row.id);
    }
    expect(rows.find((row) => row.id === 'technology')).toEqual({
      id: 'technology',
      parentId: null,
      level: 1,
      nameEn: 'Technology',
      nameSk: 'Technológie',
      description: 'Software, hardware, the internet, AI and the tech industry',
      sort: 1,
    });
    expect(rows.find((row) => row.id === 'local.czechia')).toMatchObject({
      parentId: 'local',
      level: 2,
      nameEn: 'Czechia',
      nameSk: 'Česko',
      sort: 2,
    });
  });

  it('keeps the spec 05 §3.2 names', () => {
    expect(taxonomyL1('local')).toMatchObject({
      nameEn: 'Slovakia and Czechia',
      nameSk: 'Slovensko a Česko',
      description: 'News specifically about Slovakia or Czechia',
    });
    expect(taxonomyL1('sports')?.children.map((child) => child.id)).toEqual([
      'sports.football',
      'sports.ice_hockey',
      'sports.tennis',
      'sports.motorsport',
      'sports.cycling_sport',
      'sports.winter_sports',
      'sports.other_sports',
    ]);
    expect(taxonomyL1('diy')?.children[1]).toMatchObject({
      id: 'diy.printing_3d',
      nameEn: '3D printing',
      nameSk: '3D tlač',
    });
  });

  it('answers id lookups', () => {
    expect(isTopicId('technology')).toBe(true);
    expect(isTopicId('technology.ai_ml')).toBe(true);
    expect(isTopicId('technology.quantum')).toBe(false);
    expect(isTopicId('tech')).toBe(false);
    expect(topicL1('transport.ev')).toBe('transport');
    expect(topicL1('transport')).toBe('transport');
    expect(taxonomyL1('transport.ev')).toBeUndefined();
  });

  it('builds the topic_l1 criteria from the descriptions and level-2 names', () => {
    const criteria = taxonomyL1Criteria();
    expect(Object.keys(criteria)).toEqual([...L1_IDS]);
    expect(criteria['other']).toBeNull();
    expect(criteria['education']).toEqual({
      what: 'Schools, universities and learning',
      includes: ['Schools', 'Universities', 'Learning and skills'],
    });
  });
});
