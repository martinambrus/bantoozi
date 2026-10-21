import { useTranslation } from 'react-i18next';

import { Chip, ChipButton } from './chip-button.js';

export interface EstimatedMarkerProps {
  /** The tier of the word estimate; the number of rings, kept within 1..5. */
  tier: number;
  /** Opens "Why this?"; the marker is a button only when this is given. */
  onWhyThis?: (() => void) | undefined;
}

/**
 * Marks a row whose score is a word estimate rather than an analysis: one hollow ring per tier
 * followed by the word "Estimated".
 */
export function EstimatedMarker({ tier, onWhyThis }: EstimatedMarkerProps) {
  const { t } = useTranslation('article');
  const level = Math.min(5, Math.max(1, Math.round(tier)));
  const name = t('row.estimated.name', { tier: level });
  const content = (
    <>
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {Array.from({ length: level }, (_, index) => (
          <span
            key={index}
            data-dot="outlined"
            className="size-2.5 rounded-full border-2 border-slate-600 dark:border-slate-300"
          />
        ))}
      </span>
      {t('row.estimated.label')}
    </>
  );
  return onWhyThis === undefined ? (
    <Chip role="img" aria-label={name}>
      {content}
    </Chip>
  ) : (
    <ChipButton
      aria-label={t('row.reasonChip', { reason: name, action: t('detail.whyThis') })}
      onClick={onWhyThis}
    >
      {content}
    </ChipButton>
  );
}
