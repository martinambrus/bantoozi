/**
 * The stable rule codes that "Why this?" shows (spec 06 §3.2). `user_article.rules_fired` holds these
 * strings; the explanation's `rules` entries carry them together with the ids that let the UI offer
 * "undo".
 */
export const RULE_CODES = {
  muteStory: 'mute_story',
  blockFeed: 'block_feed',
  blockDomain: 'block_domain',
  blockAuthor: 'block_author',
  boostFeed: 'boost_feed',
  boostDomain: 'boost_domain',
  demoteClickbait: 'demote:clickbait',
  demotePromotional: 'demote:promotional',
  demoteShallow: 'demote:shallow',
  demoteStale: 'demote:stale',
  degraded: 'degraded',
  llmAnswer: 'llm_answer',
  seenStory: 'seen_story',
  pendingCards: 'pending_cards',
  inferenceNotRequested: 'inference_not_requested',
} as const;

/** `mute_keyword:<value>`. */
export function muteKeywordCode(value: string): `mute_keyword:${string}` {
  return `mute_keyword:${value}`;
}

/** `never:<cardId>`: a never-card hid the item (§4.2). */
export function neverCode(cardId: string): `never:${string}` {
  return `never:${cardId}`;
}

/** `never_soft:<cardId>`: a never-card capped the lane at Maybe (§4.2). */
export function neverSoftCode(cardId: string): `never_soft:${string}` {
  return `never_soft:${cardId}`;
}

/** `must:<cardId>`: a must card raised the item to For you (§2 step 6iii). */
export function mustCode(cardId: string): `must:${string}` {
  return `must:${cardId}`;
}
