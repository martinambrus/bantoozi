import type { LibraryCandidate, PromotionEligibility } from '@bantoozi/shared';

/** The states an administrator tells apart (spec 09 §8); inactivity is never worded as approval. */
export type EligibilityKey =
  | 'approved'
  | 'inactive'
  | 'awaiting_approval'
  | 'declined'
  | 'unknown_creator'
  | 'no_request'
  | 'insufficient_holders'
  | 'expired'
  | 'stale_payload'
  | 'promoted';

export function eligibilityKey(eligibility: PromotionEligibility): EligibilityKey {
  if (eligibility.status === 'promoted') return 'promoted';
  if (eligibility.status === 'eligible') {
    if (eligibility.basis === 'creator_approval') return 'approved';
    if (eligibility.basis === 'creator_inactive_30d') return 'inactive';
    return 'no_request';
  }
  return eligibility.reason ?? 'no_request';
}

/** Promote needs an open request that is eligible now, under one of the two bases. */
export function canPromote(candidate: LibraryCandidate): boolean {
  const key = eligibilityKey(candidate.promotionEligibility);
  return candidate.request !== null && (key === 'approved' || key === 'inactive');
}

/** A request is created where there is none to answer; a decline stays a veto. */
export function canRequest(candidate: LibraryCandidate): boolean {
  if (candidate.vetoed) return false;
  const key = eligibilityKey(candidate.promotionEligibility);
  return key === 'no_request' || key === 'expired' || key === 'stale_payload';
}
