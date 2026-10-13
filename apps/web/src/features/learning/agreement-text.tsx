import type { LearningFeedAgreement } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

/** How many likes and dislikes a feed needs before its agreement is judged (the ranker's `FEED_AGREEMENT.minEachClass`). */
export const AGREEMENT_MIN_EACH_CLASS = 3;

/** What the feed's agreement says, in words; `long` is the full sentence, else a few words. */
export function useAgreementText(agreement: LearningFeedAgreement, long: boolean): string {
  const { t } = useTranslation('feeds');
  const form = long ? 'agreement' : 'agreement.short';
  return t(`${form}.${agreement.status}`, {
    likes: agreement.likes,
    dislikes: agreement.dislikes,
    min: AGREEMENT_MIN_EACH_CLASS,
    high: agreement.ratedHigh.total,
    liked: agreement.ratedHigh.liked,
    low: agreement.ratedLow.total,
    disliked: agreement.ratedLow.disliked,
  });
}

export function AgreementLine({
  agreement,
  long = false,
}: {
  agreement: LearningFeedAgreement;
  long?: boolean;
}) {
  const text = useAgreementText(agreement, long);
  return <p className="text-sm text-slate-700 dark:text-slate-200">{text}</p>;
}
