import type { Profile } from './decision.js';
import type { RatedItem } from './items.js';
import { buildCells, type Cell } from './ranking.js';

/**
 * Profile readiness (spec 10 §5), computed from label counts before any score is looked at. Counts
 * are of actual participants (participant keys), never persona rows; one article rated under
 * three contexts counts once toward a participant's distinct articles.
 */
export const OWNER_PILOT = { rated: 250, heldOut: 60, eachClass: 10 } as const;
export const BETA = {
  participants: 3,
  rated: 250,
  heldOut: 60,
  eachClass: 10,
  languageTest: 50,
  languageEachClass: 10,
} as const;

export interface ParticipantReadiness {
  participantKey: string;
  contexts: number;
  distinctRated: number;
  heldOut: number;
  heldOutLikes: number;
  heldOutDislikes: number;
}

export interface LanguageReadiness {
  lang: string;
  testRatings: number;
  likes: number;
  dislikes: number;
  /** Supported test context × language cells. */
  supportedCells: number;
}

export interface Readiness {
  profile: Profile;
  ready: boolean;
  participants: number;
  reasons: string[];
  perParticipant: ParticipantReadiness[];
  perLanguage: LanguageReadiness[];
  /** Test cells (context × language) with their support. */
  testCells: Cell[];
  /** Languages with at least one supported test cell; the others are unmeasured. */
  measuredLangs: string[];
  unmeasuredLangs: string[];
}

export function assessReadiness(
  profile: Profile,
  items: readonly RatedItem[],
  targetLangs: readonly string[],
): Readiness {
  const byParticipant = new Map<string, RatedItem[]>();
  for (const item of items) {
    byParticipant.set(item.participantKey, [
      ...(byParticipant.get(item.participantKey) ?? []),
      item,
    ]);
  }
  const perParticipant: ParticipantReadiness[] = [...byParticipant.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([participantKey, list]) => {
      const test = list.filter((i) => i.split === 'test');
      return {
        participantKey,
        contexts: new Set(list.map((i) => i.contextId)).size,
        distinctRated: new Set(list.map((i) => i.articleId)).size,
        heldOut: new Set(test.map((i) => i.articleId)).size,
        heldOutLikes: new Set(test.filter((i) => i.liked).map((i) => i.articleId)).size,
        heldOutDislikes: new Set(test.filter((i) => !i.liked).map((i) => i.articleId)).size,
      };
    });
  const testItems = items.filter((i) => i.split === 'test');
  const testCells = buildCells(testItems, 'context-lang');
  const langs = [...new Set([...targetLangs, ...items.map((i) => i.lang)])].sort();
  const perLanguage = langs.map((lang) => {
    const list = testItems.filter((i) => i.lang === lang);
    return {
      lang,
      testRatings: list.length,
      likes: list.filter((i) => i.liked).length,
      dislikes: list.filter((i) => !i.liked).length,
      supportedCells: testCells.filter((c) => c.lang === lang && c.supported).length,
    };
  });
  const reasons: string[] = [];
  const need = profile === 'owner_pilot' ? OWNER_PILOT : BETA;
  if (profile === 'owner_pilot') {
    if (perParticipant.length !== 1) {
      reasons.push(
        `owner_pilot needs exactly one actual participant, found ${perParticipant.length}`,
      );
    }
  } else if (perParticipant.length < BETA.participants) {
    reasons.push(
      `multi_person_beta needs ≥${BETA.participants} actual participants, found ${perParticipant.length}`,
    );
  }
  for (const p of perParticipant) {
    if (p.distinctRated < need.rated) {
      reasons.push(
        `participant ${p.participantKey}: ${p.distinctRated} distinct rated articles < ${need.rated}`,
      );
    }
    if (p.heldOut < need.heldOut) {
      reasons.push(
        `participant ${p.participantKey}: ${p.heldOut} held-out articles < ${need.heldOut}`,
      );
    }
    if (p.heldOutLikes < need.eachClass || p.heldOutDislikes < need.eachClass) {
      reasons.push(
        `participant ${p.participantKey}: held-out likes ${p.heldOutLikes} / dislikes ${p.heldOutDislikes} < ${need.eachClass} each`,
      );
    }
  }
  if (profile === 'multi_person_beta') {
    for (const lang of [...new Set(targetLangs)].sort()) {
      const l = perLanguage.find((x) => x.lang === lang);
      if (
        l === undefined ||
        l.testRatings < BETA.languageTest ||
        l.likes < BETA.languageEachClass ||
        l.dislikes < BETA.languageEachClass
      ) {
        reasons.push(
          `language ${lang}: needs ≥${BETA.languageTest} test ratings and ≥${BETA.languageEachClass} of each class`,
        );
      }
    }
  }
  if (!testCells.some((c) => c.supported)) {
    reasons.push('no context/language cell has ≥20 test articles with ≥5 of each class');
  }
  const measuredLangs = perLanguage.filter((l) => l.supportedCells > 0).map((l) => l.lang);
  return {
    profile,
    ready: reasons.length === 0,
    participants: perParticipant.length,
    reasons,
    perParticipant,
    perLanguage,
    testCells,
    measuredLangs,
    unmeasuredLangs: langs.filter((l) => !measuredLangs.includes(l)),
  };
}
