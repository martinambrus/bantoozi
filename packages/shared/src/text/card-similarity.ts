import { normalizeText } from './normalize-text.js';

/**
 * Words that describe card sentences in general rather than a topic ("Articles focusing on …",
 * "Články o …"), in the two interface languages; they would make unrelated cards look alike.
 */
const GENERIC_WORDS = new Set(
  (
    'articles article about focusing focused focus covering cover concerning discussing related ' +
    'regarding involving including include news stories story topics topic and the for with that ' +
    'this their from into other various latest new updates developments such them they which ' +
    'clanky clanok clankoch spravy spravach tema temy temach tykajuce tykajuci zamerane zamerany ' +
    'venovane venovany ktore ktory ich ako pre alebo tiez rozne nove najnovsie'
  ).split(' '),
);

/** A card text's topic words: normalized, at least three characters, generic words left out. */
export function cardTopicWords(title: string | null, interest: string): Set<string> {
  return new Set(
    normalizeText(`${title ?? ''} ${interest}`)
      .split(' ')
      .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word)),
  );
}

/** Jaccard overlap of two cards' topic words (0 … 1). */
export function cardTextSimilarity(
  a: { title: string | null; interest: string },
  b: { title: string | null; interest: string },
): number {
  const x = cardTopicWords(a.title, a.interest);
  const y = cardTopicWords(b.title, b.interest);
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * From this overlap on, a proposed card restates one the user holds (D-265). Calibrated on the
 * owner's cards and drafts: a draft saved as a card scores 1.0, unrelated cards that share a broad
 * word such as "technology" at most 0.13.
 */
export const SIMILAR_CARD_MIN = 0.4;

/** The held card a proposal most resembles, when it reaches {@link SIMILAR_CARD_MIN}. */
export function mostSimilarCard<T extends { title: string | null; interest: string }>(
  proposal: { title: string | null; interest: string },
  cards: readonly T[],
): { card: T; similarity: number } | null {
  let best: { card: T; similarity: number } | null = null;
  for (const card of cards) {
    const similarity = cardTextSimilarity(proposal, card);
    if (similarity >= SIMILAR_CARD_MIN && (best === null || similarity > best.similarity)) {
      best = { card, similarity };
    }
  }
  return best;
}
