import type { LibraryCardDto } from '@bantoozi/shared';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/badge.js';

export interface LibraryCardItemProps {
  card: LibraryCardDto;
  /** The names of the card's topics, in the interface language. */
  topics?: readonly string[] | undefined;
  /** The heading level of the title; the place the item sits in decides it. */
  heading: 'h3' | 'h4';
  /** The actions and messages under the card. */
  children?: ReactNode;
}

/** A card of the public library: its text and topics, with whatever the screen does with it. */
export function LibraryCardItem({
  card,
  topics = [],
  heading: Heading,
  children,
}: LibraryCardItemProps) {
  const { t } = useTranslation('interests');
  const titleId = useId();
  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl border border-slate-300 p-4 dark:border-slate-600"
    >
      <Heading id={titleId} className="min-w-0 break-words text-base font-semibold">
        {card.title}
      </Heading>
      <p className="break-words text-sm">{card.interest}</p>
      {card.notFor === null ? null : (
        <p className="break-words text-sm text-slate-600 dark:text-slate-300">
          {t('card.notFor', { text: card.notFor })}
        </p>
      )}
      {topics.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {topics.map((topic) => (
            <Badge key={topic}>{topic}</Badge>
          ))}
        </div>
      )}
      {children}
    </li>
  );
}
