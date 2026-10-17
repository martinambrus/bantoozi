import type { LearningFeedAgreement } from '@bantoozi/shared';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { CardEditor } from '../interests/card-editor.js';
import { useDismissCardHint } from './use-dismiss-card-hint.js';

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

/** Where the cards miss what the person likes in a feed: says so and opens the card editor on those articles. */
export function UncoveredSuggestion({
  agreement,
  feedTitle,
}: {
  agreement: LearningFeedAgreement;
  feedTitle: string;
}) {
  const { t } = useTranslation('feeds');
  const [making, setMaking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dismiss = useDismissCardHint();
  const { suggest, count, articles } = agreement.uncovered;
  if (!suggest || articles.length === 0) return null;
  return (
    <div ref={box} className="flex flex-col items-start gap-2">
      <p className="text-sm text-slate-700 dark:text-slate-200">{t('uncovered.text', { count })}</p>
      <Button
        variant="secondary"
        aria-label={t('uncovered.makeLabel', { title: feedTitle })}
        onClick={() => setMaking(true)}
      >
        {t('uncovered.make')}
      </Button>
      {making ? (
        <CardEditor
          fromArticles={articles}
          onNotNow={() => dismiss(agreement.feedId, 'interest')}
          returnFocus={() => box.current?.querySelector('button') ?? null}
          onClose={() => setMaking(false)}
        />
      ) : null}
    </div>
  );
}

/** Where no Never card hides what the person dislikes in a feed: says so and opens the card editor on those articles, set to Never. */
export function UnwantedSuggestion({
  agreement,
  feedTitle,
}: {
  agreement: LearningFeedAgreement;
  feedTitle: string;
}) {
  const { t } = useTranslation('feeds');
  const [making, setMaking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dismiss = useDismissCardHint();
  const { suggest, count, articles } = agreement.unwanted;
  if (!suggest || articles.length === 0) return null;
  return (
    <div ref={box} className="flex flex-col items-start gap-2">
      <p className="text-sm text-slate-700 dark:text-slate-200">{t('unwanted.text', { count })}</p>
      <Button
        variant="secondary"
        aria-label={t('unwanted.makeLabel', { title: feedTitle })}
        onClick={() => setMaking(true)}
      >
        {t('unwanted.make')}
      </Button>
      {making ? (
        <CardEditor
          fromArticles={articles}
          initialStrength="never"
          onNotNow={() => dismiss(agreement.feedId, 'never')}
          returnFocus={() => box.current?.querySelector('button') ?? null}
          onClose={() => setMaking(false)}
        />
      ) : null}
    </div>
  );
}
