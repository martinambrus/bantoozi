import { describe, expect, it } from 'vitest';

import {
  AnalyzeBodySchema,
  FolderRenameSchema,
  MePatchSchema,
  MeSchema,
  SubscriptionPatchSchema,
  UuidStringSchema,
  isIanaTimeZone,
} from '../src/index.js';

/** M4-T3/T4 request schemas (spec 08 §3–4). */

describe('isIanaTimeZone', () => {
  it('accepts IANA zones and UTC, rejects offsets, abbreviations and unknown zones', () => {
    for (const zone of ['Europe/Bratislava', 'America/Argentina/Buenos_Aires', 'UTC']) {
      expect(isIanaTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ['', '+02:00', 'Mars/Olympus_Mons', 'Europe/../etc', 'x'.repeat(65)]) {
      expect(isIanaTimeZone(zone), zone).toBe(false);
    }
  });
});

describe('MePatchSchema', () => {
  it('accepts partial profile and preference leaves, including the new preference fields', () => {
    const patch = MePatchSchema.parse({
      displayName: null,
      timezone: 'Europe/Bratislava',
      preferences: {
        theme: 'dark',
        folderOrder: ['News'],
        onboardingCompletedAt: '2026-09-30T10:00:00Z',
        demote: { clickbait: 'on' },
      },
    });
    expect(patch.preferences?.demote).toEqual({ clickbait: 'on' });
  });

  it('rejects empty patches, unknown keys and invalid values', () => {
    for (const body of [
      {},
      { email: 'x@example.test' },
      { timezone: 'Nowhere/Land' },
      { displayName: 'x'.repeat(101) },
      { preferences: { theme: 'neon' } },
      { preferences: { onboardingCompletedAt: 'soon' } },
    ]) {
      expect(MePatchSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('subscription request schemas', () => {
  it('rejects an empty subscription patch and inference fields in it', () => {
    expect(SubscriptionPatchSchema.safeParse({}).success).toBe(false);
    expect(SubscriptionPatchSchema.safeParse({ inferenceMode: 'active' }).success).toBe(false);
    expect(SubscriptionPatchSchema.safeParse({ imagePolicy: 'allow' }).success).toBe(true);
  });

  it('bounds the analyze selection and rejects duplicate articles', () => {
    const one = { id: '1', contentRevision: '1' };
    expect(
      AnalyzeBodySchema.safeParse({ articles: [one], expectedInferenceVersion: '0' }).success,
    ).toBe(true);
    expect(
      AnalyzeBodySchema.safeParse({ articles: [one, one], expectedInferenceVersion: '0' }).success,
    ).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: String(i + 1),
      contentRevision: '1',
    }));
    expect(
      AnalyzeBodySchema.safeParse({ articles: many, expectedInferenceVersion: '0' }).success,
    ).toBe(false);
  });

  it('requires a folder rename to change the name', () => {
    expect(FolderRenameSchema.safeParse({ from: 'A', to: 'A' }).success).toBe(false);
    expect(FolderRenameSchema.safeParse({ from: 'A', to: 'B' }).success).toBe(true);
  });
});

describe('UuidStringSchema', () => {
  it('validates without transforming, so response encoding works', () => {
    const id = '0190a8e0-0000-7000-8000-000000000000';
    expect(UuidStringSchema.parse(id)).toBe(id);
    expect(UuidStringSchema.safeParse('nope').success).toBe(false);
    expect(MeSchema.shape.id).toBe(UuidStringSchema);
  });
});
